# 429 Error Rewrite Proxy

A pi extension that spawns a separate child process running an HTTP → HTTPS reverse proxy, intercepts 429 rate-limit JSON responses, and rewrites error messages so pi's retry logic makes correct decisions.

By default it targets ModelScope, but any OpenAI-compatible API can be proxied via `TARGET_URL`.

## Why

ModelScope returns two distinct 429 shapes that pi core handles oppositely:

| 429 shape | pi's reaction | Desired | Fix |
|-----------|--------------|---------|-----|
| `"...billing details"` | Treats as quota exhaustion → gives up | Should **retry** (temporary RPM) | Remove `"billing"` → pi backoff kicks in |
| `"...today's quota... try again tomorrow"` | Treats as retryable RPM → keeps hitting | Should **give up** (daily quota gone) | Add `"billing-related"` → pi blocks retries |

This proxy sits between pi and the upstream API, rewriting only those 429 JSON bodies. Everything else (including streaming SSE) passes through untouched.

## Features

- **Auto-start** — proxy starts when pi session starts, stops on quit
- **Process isolation** — proxy runs in a separate Node.js child process; crashes don't affect pi
- **Visible via `ps`** — child process can be inspected with `ps`, `ss`, `lsof` etc.
- **Footer indicator** — shows proxy state and rewrite count in pi's status bar
- **Targeted rewriting** — only touches 429 JSON responses matching known patterns
- **Streaming-safe** — SSE responses (`stream: true`) pipe through with zero buffering
- **Header pass-through** — all request/response headers flow through (except hop-by-hop headers stripped per RFC)
- **HTTP → HTTPS** — accepts plain HTTP from pi, forwards to HTTPS upstream
- **Configurable target** — set `TARGET_URL` to proxy any OpenAI-compatible endpoint
- **Graceful shutdown** — handles pi quit cleanly; survives reload/session switch

## Footer indicator

The status bar shows a persistent indicator when the proxy is running:

| Indicator | Meaning |
|-----------|---------|
| `localhost:11435` | Proxy running, no rewrites yet |
| `localhost:11435 │ 2 rewrites` | Proxy running, 2 rewrites happened |
| `localhost:11435 │ 2 rewrites │ 1 err` | Proxy running, 2 rewrites, 1 upstream error |
| (empty) | Proxy stopped |

## Commands

| Command | Description |
|---------|-------------|
| `/proxy-status` | Show detailed proxy state: target, port, rewrite count, last rewrite details |

### Example `/proxy-status` output

```
State:    running
Target:   https://api-inference.modelscope.cn
Port:     11435
Rewrites: 2
Pass-thru: 1
Errors:   0
PID:      12345
Last rewrite: 45s ago
  FROM: You exceeded your current quota, please check your plan and billing details
  TO:   You exceeded your current quota, please check your plan and usage details
```

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--proxy-port` | string | `"11435"` | Override proxy listen port |
| `--proxy-target` | string | ModelScope URL | Override upstream target URL (requires restart with env var) |

## Rewrite rules

Defined in `REWRITE_RULES` at the top of `index.ts`:

| Rule | Match | Replacement | Effect |
|------|-------|-------------|--------|
| 1a | `billing details` | `usage details` | pi retries with backoff |
| 1b | `check your plan and billing` | `check your plan and usage` | pi retries with backoff |
| 2 | `exceeded today's quota... try again tomorrow` | appends `This is a billing-related daily quota exhaustion.` | pi gives up immediately |

Only the **first** matching rule is applied. Rules are skipped if the response is compressed (`Content-Encoding: gzip` etc.).

## Configuration

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | `11435` | Port the proxy listens on |
| `TARGET_URL` | `https://api-inference.modelscope.cn` | Upstream API base URL |

## How it works

```
pi → HTTP GET/POST → localhost:11435 → HTTPS → upstream API
                            │
                            ├─ non-429 or non-JSON → pipe through (incl. SSE streaming)
                            │
                            └─ 429 + JSON + uncompressed
                               ├─ match rewrite rule → rewrite body, update headers
                               └─ no match → pass through unchanged
```

The proxy runs as a **separate child process** (via `fork()`), communicating with pi via IPC messages for stats and lifecycle control. This provides process isolation and makes the proxy visible in system tools like `ps` and `ss`.

### Lifecycle

| pi event | Extension action | Child process action |
|----------|-----------------|---------------------|
| `session_start` | Fork `proxy-server.ts` as child process | Start listening on configured port |
| `session_shutdown` (quit) | Send `shutdown` IPC message | Close server, exit |
| `session_shutdown` (reload/new/resume) | Send `shutdown`, new session re-forks | Close server, exit |
| `after_provider_response` (429) | Refresh footer indicator | — |
| `/proxy-status` command | Send `get_stats` IPC, display result | Respond with full stats via IPC |

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

Or symlink locally for development:

```bash
ln -s /path/to/pi-extensions/extensions/proxy-429 ~/.pi/agent/extensions/proxy-429
```

Then update `~/.pi/agent/models.json` to point the provider at `http://localhost:11435`:

```json
{
  "providers": {
    "modelscope": {
      "baseURL": "http://localhost:11435/v1"
    }
  }
}
```

## File

- `extensions/proxy-429/index.ts` — pi extension (spawns child, handles IPC, UI)
- `extensions/proxy-429/proxy-server.ts` — proxy server logic (runs as child process)