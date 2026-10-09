# tool/

Helper scripts for the extension. Nothing in this folder is packaged into the
`.vsix` (see `tool/**` in `.vscodeignore`), and nothing here is imported by
`src/`.

| Script | Source | Ledger |
| --- | --- | --- |
| `import-codex-usage.py` | Codex CLI rollouts | `tool/.import-state.json` |
| `import-opencode-usage.py` | opencode SQLite database | `tool/.import-opencode-state.json` |

Both scripts are incremental and idempotent: rerun them as often as you like,
they only append what is new.

## import-codex-usage.py

Codex CLI records the real `usage` object of every API response, so DeepSeek
traffic that never passed through the extension's local proxy can still be
counted. This script converts those records into the extension's append-only
`usage.jsonl` format.

Why it is a tool instead of a feature: the extension only watches its own proxy,
and Codex talks to `api.deepseek.com` directly. There is no hook in the
extension host that could see those requests.

**Requirements:** Python 3.8+. Standard library only, no dependencies.

### Usage

```bash
# See what would be imported (nothing is written).
python3 tool/import-codex-usage.py --dry-run

# Import everything new.
python3 tool/import-codex-usage.py

# Only backfill part of the history, from an explicit home and usage file.
python3 tool/import-codex-usage.py --since 2026-09-24 \
  --codex-home ~/.codex \
  --usage "/mnt/c/Users/<you>/AppData/Roaming/Code/User/globalStorage/zxzxo.deepseek-status-bar-for-copilot/usage.jsonl"
```

Rerun it as often as you like: it is incremental and idempotent, so it can go in
a shell alias or a cron job (for example every 15 minutes).

### Where it reads from

By default it reads every `rollout-*.jsonl` under these Codex homes and appends
to the `usage.jsonl` of every VS Code flavour it finds:

| Source | Default |
| --- | --- |
| Codex homes | `$CODEX_HOME`, `~/.codex`, `~/.local/share/codex-deepseek/.codex` |
| `usage.jsonl` | native VS Code global storage (`~/.config/...` on Linux, `~/Library/Application Support/...` on macOS, `%APPDATA%\...` on Windows), plus `/mnt/c/Users/*/AppData/Roaming/...` when run under WSL |

Use `--codex-home` / `--usage` (both repeatable) to override.

### Field mapping

Codex `token_usage_record` → extension usage row:

| Extension field | Codex field |
| --- | --- |
| `ts` | event timestamp (already UTC, kept verbatim) |
| `model` | `turn_context.model`, falling back to the thread's setting |
| `prompt_tokens` | `usage.input_tokens` |
| `completion_tokens` | `usage.output_tokens` (includes reasoning tokens) |
| `total_tokens` | `usage.total_tokens` |
| `cache_hit_tokens` | `usage.cached_input_tokens` |
| `cache_miss_tokens` | `input_tokens - cached_input_tokens` |
| `stream` / `status` | always `true` / `200` |
| `source` / `id` | `codex` / `response_id` (extra fields; the extension ignores them) |

The extension stores facts and prices each row itself, so peak/off-peak pricing
and the Chinese holiday calendar still apply per timestamp. Do not rewrite `ts`.

### Deduplication

The script keeps a ledger in `tool/.import-state.json`: imported `response_id`
values plus the consumed byte offset per rollout file. A record is imported
once, even if a session file is rewritten, truncated, or resumed. Delete the
ledger to re-import from scratch — records already in `usage.jsonl` would then
be appended a second time, so truncate that file too if you do.

### Caveats

- Only DeepSeek traffic is imported. A Codex home can hold both kinds of session
  (`deepseek-*` on the `deepseek` provider, `gpt-*` on `openai`), and one thread
  can switch models mid-session, so the decision is made per response from
  `turn_context.model` plus `thread_settings_applied.model_provider_id`.
  Everything else is counted as skipped (`gpt-6-astra`, `gpt-6-luna`, ...).
- `ts` is the timestamp of the response, not of the request, so a request that
  straddles a peak boundary can be priced one segment off by a few seconds.
- Imported rows carry no `ms`; latency statistics for them stay empty.
- Rollouts that predate `token_usage_record` (very old CLI versions) fall back
  to `event_msg.token_count`; those rows use the default model name.
- Reasoning tokens are inside `output_tokens`, which is how DeepSeek bills them.

## import-opencode-usage.py

opencode stores one row per assistant message, with the answering model and the
tokens it reported, in `~/.local/share/opencode/opencode.db`. This script imports
the DeepSeek ones — useful for conversations that were moved into Codex later as
transcripts only, which carry no usage at all and therefore cannot be counted
from the Codex side. The database is opened read-only, so the copy in a backup
(or the trash) works as well as the live one.

```bash
python3 tool/import-opencode-usage.py --dry-run
python3 tool/import-opencode-usage.py
python3 tool/import-opencode-usage.py --db /path/to/backup/opencode.db
```

| Extension field | opencode field |
| --- | --- |
| `ts` | `time_created` of the assistant message (UTC) |
| `model` | `model.id` |
| `prompt_tokens` | `tokens.input + tokens.cache.read` |
| `completion_tokens` | `tokens.output + tokens.reasoning` |
| `cache_hit_tokens` | `tokens.cache.read` |
| `cache_miss_tokens` | `tokens.input` |
| `source` / `id` | `opencode` / the message id |

opencode reports cache misses in `tokens.input` and hits in
`tokens.cache.read` (so `read` is usually far larger than `input`), and bills
reasoning tokens as output — the same shape DeepSeek returns. Its own `cost`
column is ignored: the extension prices every row from `ts` + `model`, which
keeps peak/off-peak pricing in one place.

The mapping was checked against those `cost` values: all 3,416 billable messages
in the local database match it exactly (off-peak rows land on
`cost = 0.15 × CNY` and peak rows on exactly half that, i.e. ×2), so the fields
above are the right ones.

Only `model.providerID = "deepseek"` messages are imported. opencode's own free
models (`big-pickle`, `jev-1.13-free`) are skipped.
