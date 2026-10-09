#!/usr/bin/env python3
"""Import DeepSeek usage recorded by opencode into the extension's usage.jsonl.

opencode keeps one row per assistant message in its SQLite database
(`~/.local/share/opencode/opencode.db`), each with the model that answered and
the `usage` it received. This script converts the DeepSeek ones into the
extension's append-only usage file, so conversations that were run with
opencode — and later only moved into Codex as transcripts, without usage — are
still counted.

Only messages whose `model.providerID` is `deepseek` are imported; opencode's own
free models (`big-pickle`, ...) are not DeepSeek billing.

This file is not part of the packaged extension; see tool/README.md.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
from pathlib import Path

PROVIDER = "deepseek"
EXTENSION_ID = "zxzxo.deepseek-status-bar-for-copilot"
STATE_VERSION = 1
VSCODE_APPS = ("Code", "Code - Insiders", "VSCodium")
DEFAULT_DB = "~/.local/share/opencode/opencode.db"


def databases(explicit: list[str]) -> list[Path]:
    """opencode databases to read, in order."""
    paths = [Path(item).expanduser() for item in explicit] if explicit else [
        Path(DEFAULT_DB).expanduser()
    ]
    return [path for path in paths if path.is_file()]


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


def iso_utc(created_ms: int) -> str:
    moment = datetime.datetime.fromtimestamp(created_ms / 1000, datetime.timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def message_record(timestamp_ms: int, message_id: str, data: dict) -> dict | None:
    """One opencode assistant message -> one extension usage row."""
    tokens = data.get("tokens") or {}
    cache = tokens.get("cache") or {}
    # opencode reports the cache misses in `input` and the hits separately, and
    # bills reasoning tokens as output (same as DeepSeek's completion_tokens).
    prompt = int(tokens.get("input") or 0) + int(cache.get("read") or 0)
    completion = int(tokens.get("output") or 0) + int(tokens.get("reasoning") or 0)
    if prompt + completion <= 0:
        return None
    return {
        "ts": iso_utc(timestamp_ms),
        "model": (data.get("model") or {}).get("id") or "deepseek-flash",
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "cache_hit_tokens": int(cache.get("read") or 0),
        "cache_miss_tokens": int(tokens.get("input") or 0),
        "stream": True,
        "status": 200,
        "source": "opencode",
        "id": f"opencode:{message_id}",
    }


def read_database(path: Path) -> list[dict]:
    """Every DeepSeek assistant message in one opencode database."""
    records: list[dict] = []
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "select id, data, time_created from session_message where type = 'assistant'"
        )
        for message_id, data, created in rows:
            try:
                message = json.loads(data)
            except ValueError:
                continue
            if (message.get("model") or {}).get("providerID") != PROVIDER:
                continue
            record = message_record(int(created), message_id, message)
            if record:
                records.append(record)
    finally:
        connection.close()
    return records


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


def writable(path: Path) -> bool:
    """True when the file can be appended to (WSL mounts C: read-only by default)."""
    try:
        with path.open("a"):
            return True
    except OSError:
        return False


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import DeepSeek usage from opencode databases into the extension's usage.jsonl.",
    )
    parser.add_argument("--db", action="append", default=[], metavar="FILE",
                        help=f"opencode database; repeatable (default: {DEFAULT_DB})")
    parser.add_argument("--usage", action="append", default=[], metavar="FILE",
                        help="usage.jsonl to append to; repeatable (default: detect VS Code global storage)")
    parser.add_argument("--state", metavar="FILE",
                        help="import ledger (default: tool/.import-opencode-state.json)")
    parser.add_argument("--since", metavar="YYYY-MM-DD",
                        help="skip usage older than this UTC date")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be imported without writing anything")
    parser.add_argument("--verbose", action="store_true", help="print every imported record")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    sources = databases(args.db)
    if not sources:
        print(f"no opencode database found (looked for {DEFAULT_DB}); pass --db", file=sys.stderr)
        return 2
    targets = usage_files(args.usage)
    if not targets:
        print("no usage.jsonl found; start the extension once or pass --usage", file=sys.stderr)
        return 2
    records: list[dict] = []
    for source in sources:
        records += read_database(source)
    if args.since:
        records = [item for item in records if item["ts"][:10] >= args.since]
    records.sort(key=lambda item: item["ts"])
    state_path = Path(args.state) if args.state else Path(__file__).with_name(".import-opencode-state.json")
    state = load_state(state_path)
    print(f"databases  : {', '.join(str(source) for source in sources)}")
    print(f"deepseek   : {len(records)} assistant messages")
    for target in targets:
        ledger = state["targets"].setdefault(str(target), {"ids": []})
        known = set(ledger["ids"])
        pending = [item for item in records if item["id"] not in known]
        duplicates = len(records) - len(pending)
        models: dict[str, int] = {}
        tokens = 0
        for item in pending:
            models[item["model"]] = models.get(item["model"], 0) + 1
            tokens += item["total_tokens"]
        print(f"\n{target}")
        print(f"  new records: {len(pending)}   already imported: {duplicates}")
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
            with target.open("a", encoding="utf-8") as handle:
                for item in pending:
                    handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        ledger["ids"] = sorted(known | {item["id"] for item in pending})
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        print(f"  written    : {len(pending)} rows -> {target}")
    if args.dry_run:
        print(f"\ndry run: state file untouched ({state_path})")
    else:
        print(f"\nstate: {state_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
