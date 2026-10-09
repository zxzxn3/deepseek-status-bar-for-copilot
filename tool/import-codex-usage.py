#!/usr/bin/env python3
"""Import DeepSeek usage recorded by Codex CLI into the extension's usage.jsonl.

Codex appends one `token_usage_record` per API response to
`<CODEX_HOME>/sessions/<year>/<month>/<day>/rollout-*.jsonl`. This script turns
those records into the extension's append-only usage file, so the status bar and
the detail panel also count traffic that never went through the local proxy.

Only sessions whose `model_provider` is `deepseek` are imported; sessions that
used another provider (for example `openai`) are ignored because they are not
DeepSeek billing.

This file is not part of the packaged extension; see tool/README.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_MODEL = "deepseek-flash"
PROVIDER = "deepseek"
EXTENSION_ID = "zxzxo.deepseek-status-bar-for-copilot"
STATE_VERSION = 1
VSCODE_APPS = ("Code", "Code - Insiders", "VSCodium")


def codex_homes(explicit: list[str]) -> list[Path]:
    """Codex home directories to read, in order."""
    if explicit:
        return [Path(item) for item in explicit]
    candidates: list[Path] = []
    if os.environ.get("CODEX_HOME"):
        candidates.append(Path(os.environ["CODEX_HOME"]))
    candidates += [
        Path.home() / ".codex",
        Path.home() / ".local/share/codex-deepseek/.codex",
    ]
    seen: set[str] = set()
    homes: list[Path] = []
    for path in candidates:
        try:
            key = str(path.resolve())
        except OSError:
            continue
        if key not in seen and path.is_dir():
            seen.add(key)
            homes.append(path)
    return homes


def usage_files(explicit: list[str]) -> list[Path]:
    """usage.jsonl paths written by the extension (VS Code global storage)."""
    if explicit:
        return [Path(item) for item in explicit]
    bases: list[Path] = []
    if sys.platform == "darwin":
        bases.append(Path.home() / "Library/Application Support")
    elif os.name == "posix":
        bases.append(Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")))
    if os.environ.get("APPDATA"):
        bases.append(Path(os.environ["APPDATA"]))
    bases.append(Path.home() / "AppData/Roaming")
    if os.name == "posix":
        bases += sorted(Path("/mnt/c/Users").glob("*/AppData/Roaming"))
    found: list[Path] = []
    for base in bases:
        for app in VSCODE_APPS:
            candidate = base / app / "User" / "globalStorage" / EXTENSION_ID / "usage.jsonl"
            if candidate.is_file() and candidate not in found:
                found.append(candidate)
    return found


def rollout_files(homes: list[Path]) -> list[Path]:
    files: list[Path] = []
    for home in homes:
        files += sorted(home.glob("sessions/**/rollout-*.jsonl"))
    return files


def session_provider(path: Path) -> str | None:
    """`model_provider` of a rollout, read from its first line."""
    try:
        with path.open("rb") as handle:
            first = handle.readline()
        event = json.loads(first)
    except (OSError, ValueError):
        return None
    if event.get("type") != "session_meta":
        return None
    return (event.get("payload") or {}).get("model_provider")


def usage_record(timestamp: str, model: str, usage: dict, record_id: str) -> dict:
    """One extension usage row (facts only; the extension prices each row)."""
    prompt = int(usage.get("input_tokens") or 0)
    cached = int(usage.get("cached_input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    total = int(usage.get("total_tokens") or (prompt + completion))
    return {
        "ts": timestamp,
        "model": model,
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "cache_hit_tokens": cached,
        "cache_miss_tokens": max(prompt - cached, 0),
        "stream": True,
        "status": 200,
        "source": "codex",
        "id": record_id,
    }


def scan_rollout(path: Path, offset: int, session: str | None) -> tuple[list[dict], list[tuple], int, int]:
    """Read appended events after `offset`.

    Returns the per-response records, the cumulative-only fallback entries and
    the new offset, plus how many records were skipped as non-DeepSeek. A
    half-written last line is left for the next run.
    """
    records: list[dict] = []
    legacy: list[tuple] = []
    skipped = 0
    provider = session
    turn_models: dict[str, str] = {}
    thread_model: str | None = None
    last_model: str | None = None
    with path.open("rb") as handle:
        handle.seek(offset)
        consumed = offset
        for raw in handle:
            if not raw.endswith(b"\n"):
                break
            consumed += len(raw)
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            kind = event.get("type")
            payload = event.get("payload") or {}
            if kind == "turn_context":
                model = payload.get("model")
                if model:
                    turn_models[payload.get("turn_id")] = model
                    last_model = model
            elif kind == "event_msg" and payload.get("type") == "thread_settings_applied":
                settings = payload.get("thread_settings") or {}
                thread_model = settings.get("model") or thread_model
                provider = settings.get("model_provider_id") or provider
            elif kind == "token_usage_record":
                usage = payload.get("usage") or {}
                resolved = turn_models.get(payload.get("turn_id")) or thread_model or last_model
                # One thread can switch models mid-session, so decide per record:
                # DeepSeek models are the only ones that appear on the DeepSeek bill.
                if resolved:
                    keep = resolved.startswith("deepseek") and provider != "openai"
                else:
                    keep = provider == PROVIDER
                if not keep:
                    skipped += 1
                    continue
                model = resolved or DEFAULT_MODEL
                record_id = payload.get("response_id") or (
                    f"{path.stem}:{event.get('timestamp')}:{usage.get('total_tokens')}"
                )
                records.append(usage_record(event.get("timestamp", ""), model, usage, record_id))
            elif kind == "event_msg" and payload.get("type") == "token_count":
                # Older CLIs only report cumulative counters plus the last response.
                info = payload.get("info") or {}
                if info.get("last_token_usage") and info.get("total_token_usage"):
                    legacy.append((event.get("timestamp", ""), info, path.stem, provider))
    return records, legacy, consumed, skipped


def legacy_records(entries: list[tuple]) -> list[dict]:
    """Fallback for rollouts without per-response records: one row per response."""
    out: list[dict] = []
    seen: set[tuple] = set()
    for timestamp, info, stem, provider in entries:
        if provider != PROVIDER:
            continue
        total_usage = info["total_token_usage"]
        key = (stem,) + tuple(sorted(total_usage.items()))
        if key in seen:
            continue
        seen.add(key)
        usage = info["last_token_usage"]
        if not int(usage.get("total_tokens") or 0):
            continue
        record_id = f"legacy:{stem}:{total_usage.get('total_tokens')}"
        out.append(usage_record(timestamp, DEFAULT_MODEL, usage, record_id))
    return out


def load_state(path: Path) -> dict:
    if not path.is_file():
        return {"version": STATE_VERSION, "targets": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise SystemExit(f"state file is not valid JSON: {path}")
    if state.get("version") != STATE_VERSION:
        raise SystemExit(f"unsupported state version in {path}; delete it to start over")
    state.setdefault("targets", {})
    return state


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def append_records(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for item in records:
            handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")


def writable(path: Path) -> bool:
    """True when the file can be appended to (WSL mounts C: read-only by default)."""
    try:
        with path.open("a"):
            return True
    except OSError:
        return False


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import DeepSeek usage from Codex CLI rollouts into the extension's usage.jsonl.",
    )
    parser.add_argument("--codex-home", action="append", default=[], metavar="DIR",
                        help="Codex home to read; repeatable (default: CODEX_HOME, ~/.codex, "
                             "~/.local/share/codex-deepseek/.codex)")
    parser.add_argument("--usage", action="append", default=[], metavar="FILE",
                        help="usage.jsonl to append to; repeatable (default: detect VS Code global storage)")
    parser.add_argument("--state", metavar="FILE",
                        help="import ledger (default: tool/.import-state.json next to this script)")
    parser.add_argument("--since", metavar="YYYY-MM-DD",
                        help="skip usage older than this UTC date")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be imported without writing anything")
    parser.add_argument("--verbose", action="store_true", help="print every imported record")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    homes = codex_homes(args.codex_home)
    if not homes:
        print("no Codex home found; pass --codex-home", file=sys.stderr)
        return 2
    targets = usage_files(args.usage)
    if not targets:
        print("no usage.jsonl found; start the extension once or pass --usage", file=sys.stderr)
        return 2
    state_path = Path(args.state) if args.state else Path(__file__).with_name(".import-state.json")
    state = load_state(state_path)
    rollouts = rollout_files(homes)
    print(f"codex homes: {', '.join(str(home) for home in homes)}")
    print(f"rollouts   : {len(rollouts)} files")
    for target in targets:
        ledger = state["targets"].setdefault(str(target), {"ids": [], "files": {}})
        known = set(ledger["ids"])
        offsets = ledger["files"]
        pending: list[dict] = []
        duplicates = 0
        skipped = 0
        for path in rollouts:
            offset = int(offsets.get(str(path), 0))
            if path.stat().st_size < offset:
                offset = 0
            records, legacy, new_offset, ignored = scan_rollout(path, offset, session_provider(path))
            skipped += ignored
            if not records and legacy:
                records = legacy_records(legacy)
            records = [
                item for item in records
                if (not args.since or item["ts"][:10] >= args.since)
                and int(item["total_tokens"] or 0) > 0
            ]
            offsets[str(path)] = new_offset
            for item in records:
                if item["id"] in known:
                    duplicates += 1
                    continue
                known.add(item["id"])
                pending.append(item)
        pending.sort(key=lambda item: item["ts"])
        models: dict[str, int] = {}
        tokens = 0
        for item in pending:
            models[item["model"]] = models.get(item["model"], 0) + 1
            tokens += int(item["total_tokens"] or 0)
        print(f"\n{target}")
        print(f"  new records: {len(pending)}   already imported: {duplicates}")
        print(f"  skipped    : {skipped} (other providers, e.g. gpt-*)")
        print(f"  tokens     : {tokens:,}")
        for model, count in sorted(models.items()):
            print(f"    {model}: {count}")
        if args.verbose:
            for item in pending:
                print("    " + json.dumps(item, ensure_ascii=False))
        if args.dry_run:
            print("  dry run: nothing written")
            continue
        if not writable(target):
            print("  NOT written: no append permission (WSL /mnt/c is read-only; "
                  "run this script from Windows instead)")
            continue
        if pending:
            append_records(target, pending)
        ledger["ids"] = sorted(known)
        save_state(state_path, state)
        print(f"  written    : {len(pending)} rows -> {target}")
    if args.dry_run:
        print(f"\ndry run: state file untouched ({state_path})")
    else:
        print(f"\nstate: {state_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
