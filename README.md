<h1 align="center">DeepSeek Status Bar for Copilot</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=zxzxo.deepseek-status-bar-for-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="Install from VS Code Marketplace"></a>
  <br/>
  <img src="https://img.shields.io/github/license/zxzxn3/deepseek-status-bar-for-copilot?style=for-the-badge" alt="License" />
  <img src="https://img.shields.io/github/v/release/zxzxn3/deepseek-status-bar-for-copilot?style=for-the-badge&label=Version" alt="Version" />
</p>

<p align="center">
  <strong>See exactly what DeepSeek is costing you — live, in the status bar, without leaving VS Code.</strong>
</p>

This extension puts a lightweight local proxy between Copilot Chat (via the [DeepSeek V4 for Copilot Chat](https://marketplace.visualstudio.com/items?itemName=Vizards.deepseek-v4-for-copilot) extension) and the DeepSeek API. It captures the **real `usage` object from every response** and turns it into today's cost and token totals — UTC day boundaries, peak pricing included.

<p align="center">
  <img src="status-bar.png" alt="Status bar showing today's DeepSeek cost and tokens" width="557"/>
</p>

## Why this extension?

- **Real numbers, not estimates.** It reads the `usage` DeepSeek returns on every request (`prompt_tokens` / `completion_tokens` / cache tokens) and prices it with the official rates. The totals match your DeepSeek bill — no heuristic token counting.
- **Lives in the status bar.** One glance: cost, cache-hit cost, total and cached tokens. Click it to switch between six display formats.
- **A real dashboard when you need it.** A webview panel with `Day / Week / Month / All` ranges, a stacked usage chart, per-model breakdown, recent requests, and CSV export.
- **Your API key never touches this extension.** The proxy forwards the `Authorization` header straight through to DeepSeek; the key stays wherever the Copilot extension stores it.
- **No external services.** Chart.js and dayjs are bundled into the extension itself — no separate service, no Python, no Docker.

## Why this is different

Every other DeepSeek usage tool answers *"how much is left in my account?"* — they poll the [`/user/balance`](https://api.deepseek.com/user/balance) endpoint and show your credit balance. This extension answers a different question: *"what did that request actually cost me?"*

It sits **in the traffic path** — a local proxy that captures the real `usage` object DeepSeek returns on every request and prices it with the official rate card:

- **Ground truth, not estimates.** `usage` is the exact field DeepSeek bills from (`prompt_tokens` / `completion_tokens` / `cache_hit` / `cache_miss`). No heuristic token counting.
- **Three-way pricing.** Cache hit vs miss, input vs output, and UTC peak vs off-peak (×2) — the same axes as your real bill.
- **Aborted generations still count.** Cancel mid-stream and the proxy keeps reading until it captures the final `usage` — so the numbers match what you're billed.
- **Your API key never touches this extension.** The proxy forwards the `Authorization` header straight through and never stores it.

## Features

### Live status bar

The status bar shows today's totals (UTC) and updates automatically:

<p align="center">
  <img src="display-formats.png" alt="Click the status bar to switch display formats" width="749"/>
</p>

- **Cost** — `￥9.8626/4.4522` total / cache-hit cost
- **Tokens** — `91.69M/89.04M` total / cached tokens
- **Balance** — `￥xx.xx` account balance, refreshed by the proxy on each request
- **Peak pricing aware** — costs double during peak hours (UTC weekdays 01:00–04:00 and 06:00–10:00, i.e. Beijing 09:00–12:00 and 14:00–18:00)
- **Six display formats** — click the status bar to pick: `full` (cost + tokens), `cost`, `tokens`, `totalT` (total tokens only), `totalCost` (total cost only), or `balance`
- **Low-balance warning** — the status bar turns amber when the balance drops below `deepseekStatusBar.lowBalanceWarnCny`

### Detail panel

<p align="center">
  <img src="details-view.png" alt="Detail panel with summary, usage chart, per-model breakdown and recent requests" width="760"/>
</p>

- **Custom time window** — drag two slider handles across your history, or enter exact start/end times (UTC, end exclusive). Release to apply; summaries and CSV follow the selection. Auto width targets at most 120 bars; fine manual widths widen if needed to stay within 2000 bars.
- **Range selector** — `Day` / `Week` / `Month` / `All`, with a **date picker** to view any specific day, week, or month
- **Usage-over-time chart** — Chart.js stacked bars (cache hit / cache miss / output) for cost or tokens, with an independent **Auto / 1, 5, 15 min / 1, 6 hour / 1, 7 day** bar width
- **Balance & latency curves** — toggleable overlays for the account balance and the average request latency over time, each on its own axis with a legend
- **Per-model breakdown** — cost & tokens per model (V4.1 Flash / V4 Pro), plus average latency per model
- **Recent requests** — timestamp, model, prompt/completion, total/cache, cost, latency, status, error
- **Export CSV** — dump the selected range to a CSV with cost columns

### True streaming proxy

A local OpenAI-compatible proxy that forwards `chat/completions` with real streaming:

- **Chunked streaming passthrough** — responses stream to Copilot as DeepSeek produces them, no buffering
- **SSE-safe** — handles usage chunks split across network boundaries
- **Disconnect-safe** — if the client cancels, the proxy keeps reading upstream to capture the final `usage` (aborted generations still cost money and are still counted)
- **Auto-start** — starts with VS Code (`autoStart`) and takes over `deepseek-copilot.baseUrl`, restoring it when stopped

Reused proxies are verified against this extension's health endpoint and storage location. All participating windows monitor availability. If the owner closes or the proxy fails, the previous global API URL is restored (manual edits are preserved); restart the proxy to resume tracking. Closing a window that only reuses a healthy proxy leaves the shared connection intact. Explicitly stopping a reused proxy restores the global URL for all windows without killing the other window's process.

### Account balance (on-request)

The proxy already holds your API key on every forwarded request, so it also queries [`/user/balance`](https://api.deepseek.com/user/balance) along the way and shows your balance in the status bar and the panel:

- **No extra key setup** — the key is used in-flight and never stored
- **Throttled** — at most once per minute; forced immediately after an HTTP 402
- **402 awareness** — insufficient-balance responses are surfaced in the detail panel, together with a fresh balance query

### Request latency

The proxy timestamps every request, so the panel knows how long each one took:

- **Per-request latency** — shown in the recent-requests table
- **Average latency** — an overall summary card, a per-model column, and an optional curve overlaid on the usage chart
- **No cost to old data** — latency is recorded from new requests onward; historical rows simply show `—`

### Configurable pricing & currency

- **Pricing overrides** — the built-in price table (per model, yuan per million tokens) can be overridden per model in settings
- **CNY or USD display** — switch currency with a single setting; USD uses a live exchange rate fetched from a public API, falling back to a configurable rate when offline
- **Language** — the UI follows your VS Code display language (English / 简体中文)

## How it works

```
Copilot Chat (DeepSeek V4 for Copilot)
        │  baseUrl → http://127.0.0.1:8080
        ▼
  local proxy (Node.js, spawned by this extension)
        │  forwards with your Authorization header
        ▼
  api.deepseek.com
        │  response.usage captured
        ▼
  usage.jsonl  →  status bar + detail panel (cost computed on display)
```

Data is stored as one JSON line per request in VS Code's global storage: raw facts only (UTC timestamp + token counts). Cost is computed at display time, so price or currency changes are reflected immediately — no re-processing of history.

## Getting Started

### Prerequisites

- **VS Code 1.85** or later
- **DeepSeek V4 for Copilot Chat** — installed automatically as a dependency of this extension
- A **DeepSeek API key** configured in that extension (this extension never sees it)

### Installation

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=zxzxo.deepseek-status-bar-for-copilot) (or build from source below).
2. Reload VS Code. The proxy starts automatically.

### Usage

1. Open Copilot Chat and pick a DeepSeek V4 model (the companion extension).
2. Chat as usual — the status bar starts showing today's cost and tokens.
3. Click the status bar to switch its format, or run **DeepSeek Status Bar: Today's Details** for the full panel.

## Settings

| Setting | Default | Description |
|---|---|---|
| `deepseekStatusBar.port` | `8080` | Local proxy listen port |
| `deepseekStatusBar.autoStart` | `true` | Start the proxy automatically when VS Code launches |
| `deepseekStatusBar.manageBaseUrl` | `true` | Point `deepseek-copilot.baseUrl` at the proxy while running, and restore it when stopped |
| `deepseekStatusBar.pollIntervalSeconds` | `10` | Status bar refresh interval (seconds, min 2) |
| `deepseekStatusBar.statusBarFormat` | `full` | Status bar format: `full` / `cost` / `tokens` / `totalT` / `totalCost` / `balance` |
| `deepseekStatusBar.pricing` | `{}` | Per-model price overrides (yuan / 1M tokens): `{"deepseek-flash": {"cache_hit": 0.02, "cache_miss": 1, "output": 4}}` |
| `deepseekStatusBar.holidays` | `2026-09-25~27`, `2026-10-01~07` | Chinese statutory holidays (Beijing calendar days, `YYYY-MM-DD`): these days are off-peak all day. Replaces the built-in list |
| `deepseekStatusBar.additionalWorkdays` | `2026-09-20` | Make-up workdays (Beijing calendar days): weekends that are official working days, billed at peak hours. Set to `[]` to keep every weekend off-peak |
| `deepseekStatusBar.currency` | `cny` | Cost currency: `cny` (￥) or `usd` ($) |
| `deepseekStatusBar.cnyPerUsd` | `6.74` | Fallback CNY-per-USD rate, used when the live rate can't be fetched |
| `deepseekStatusBar.lowBalanceWarnCny` | `10` | Account balance (yuan) below which the status bar warns; `0` disables |
| `deepseekStatusBar.recentRequestsCount` | `30` | Number of recent requests shown in the detail panel (1–200) |

**Pricing model** — built-in defaults + your overrides; peak = off-peak × 2 during UTC weekdays 01:00–04:00 and 06:00–10:00 (the official rate card's UTC wording, identical to Beijing 09:00–12:00 and 14:00–18:00). Timed pricing only starts at 2026-08-17 00:00 Beijing time, so earlier records are never retroactively doubled; weekends have been off-peak all day only since 2026-08-23 00:00 Beijing time (the official 2026-08-22 notice), so the weekend of 2026-08-22–23 is still split into peak and off-peak windows. USD display uses a live rate (fetched from a public API, refreshed every 6 hours) and falls back to `cnyPerUsd` offline.

**Holidays** — the official rate card footnotes exclude Chinese statutory holidays from weekday peak hours, so the built-in calendar follows the relevant part of the 2026 State Council schedule (Guobanfamingdian [2025] No. 7): `2026-09-25~27` (Mid-Autumn) and `2026-10-01~07` (National Day) are off-peak for the whole Beijing calendar day. Earlier 2026 holidays (New Year, Spring Festival, Qingming, Labour Day, Dragon Boat) are deliberately absent: timed pricing only started on 2026-08-17, so they can never be doubled.

**Make-up workdays.** DeepSeek's wording (rate card and the 2026-08-22 notice) defines peak hours as *Monday–Friday* excluding Chinese public holidays, with weekends off-peak all day. A make-up workday — the Saturday or Sunday you have to work, which China counts as a working day — sits on the weekend side of that wording, so it is billed off-peak here. `additionalWorkdays` therefore defaults to just the past `2026-09-20`, kept as a worked example of the format; add a date yourself if your bill ever shows a make-up day charged at peak. Both lists are plain `YYYY-MM-DD` arrays you can replace wholesale — swap in new dates once the State Council publishes them, and if a date appears in both lists it is treated as a holiday. Changing either list re-prices your history instantly; the raw `usage.jsonl` is never rewritten.

**Pricing schedule** — From September 10, 2026 at 12:00 Beijing time, V4.1 Flash costs CNY 0.02 / 1 / 4 per million tokens (cache hit / cache miss / output) off-peak; peak prices are double. The legacy IDs `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are routed to V4.1-Flash and billed at the Flash price. `deepseek-v4-pro` keeps its own rates (0.15 / 4.5 / 13.5 off-peak, doubled at peak): the official changelog of 2026-09-10 states V4 Pro stays available past September 14 with unchanged billing, and the rate card still lists it separately. Historical records use the price effective at their timestamp; custom overrides take priority across all dates. Prices and effective times follow the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and [changelog](https://api-docs.deepseek.com/zh-cn/updates). Earlier records retain the repository's initial rates.

## Commands

| Command | Description |
|---|---|
| `DeepSeek Status Bar: Today's Details` | Open the detail panel |
| `DeepSeek Status Bar: Start Proxy` / `Stop Proxy` | Toggle the proxy (the palette entry reflects the current state) |
| `DeepSeek Status Bar: Display Format` | Choose the status bar display format |

## Notes & limitations

- **Vision requests are not counted.** The companion extension's vision feature uses a separate `/v1/responses` endpoint configured independently of `baseUrl`, so it doesn't pass through this proxy.
- **Only proxied requests are counted.** Requests made with the same key from another client, machine, or endpoint (the vision endpoint above, Codex, Claude Code, scripts) are billed by DeepSeek but never reach this proxy, so the status bar can read lower than your real balance drop. Everything the proxy does see reconciles with the account balance to within a rounding error — bursts you can't attribute to a captured request are external traffic, not a pricing bug.
- **`baseUrl` is global.** Taking over `deepseek-copilot.baseUrl` affects all windows. It's restored when the proxy stops, but if VS Code is force-killed the value may be left pointing at the proxy — it recovers on next launch since `autoStart` is on.
- **The official dashboard is authoritative.** Costs are computed from the same pricing model, but always trust `platform.deepseek.com` for billing.

## Build from source

```powershell
npm install
npm run compile      # or npm run watch
npm run typecheck
npm run smoke
npm test

# package into a .vsix
powershell -ExecutionPolicy Bypass -File .\package.ps1

# install / reinstall (--force overwrites the same version)
code --install-extension .\deepseek-status-bar-for-copilot.vsix --force
```

## License

[MIT](LICENSE)
