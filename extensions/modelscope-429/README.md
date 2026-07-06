# ModelScope 429 Error Rewrite

An in-process pi extension that hooks `message_end` to rewrite ModelScope's mislabeled 429 error messages so pi's retry logic (`isRetryableAssistantError`) makes correct decisions.

Replaces [`proxy-429`](../proxy-429) — no child process, HTTP proxy, IPC, or port management needed.

## Why

ModelScope mislabels several 429 error types, causing pi's retry classifier to make wrong decisions:

| ModelScope says | pi thinks | Reality | Fix |
|----------------|-----------|---------|-----|
| `"too frequent request"` | no match → not retried | Transient rate limit | Rewrite to `rate_limit_exceeded` → retry |
| `"insufficient_quota"` (code) | NON_RETRYABLE matches → gives up | Transient rate limit (wrong wording) | Strip quota/insufficient from all fields → retry |
| `"billing details"` / `"check your plan and billing"` | NON_RETRYABLE matches `billing` → gives up | Transient rate limit (wrong wording) | Strip `"billing"` → retry |
| `"exceeded today's quota... try again tomorrow"` | no match → retried forever | Genuine daily quota exhaustion | Add `"billing-related"` → gives up |

## How it works

```
message_end fires (assistant, stopReason "error")
  → parse JSON body from errorMessage
  → detect ModelScope flat format { code, message, param, type }
  → rewrite errorMessage in-place
  → agent_end → _willRetryAfterAgentEnd() → isRetryableAssistantError()
    reads the rewritten errorMessage
```

The extension returns `{ message: replacement }` from the `message_end` handler, which mutates the agent's message object in-place before persistence and the retry check.

## Rewrite rules

Evaluated in order; the first match wins.

| Type | Match | Effect | Result |
|------|-------|--------|--------|
| A | `too frequent request` (message) | Rewrite to `rate_limit_exceeded` | retry |
| C | `exceeded today's quota... try again tomorrow` (message) | Append `billing-related daily quota exhaustion` | **give up** |
| B | `quota` / `insufficient` (code) | Strip from code + message + type | retry |
| B2 | `billing` (message) | Strip `billing` → `usage` | retry |
| D | any other ModelScope 429 | Strip non-retryable keywords, append `[429 rate limit]` | retry |

Type C is checked before B and B2 as a fail-safe: it's the only non-retryable case, so a daily-quota message that also contains "quota" or "billing" should give up, not retry. In practice these patterns appear mutually exclusive, but Type C first is the safer failure mode.

Type D strips non-retryable keywords (`insufficient_quota`, `quota exceeded`, `quota`, `billing`, `out of budget`) before appending the retryable hint, because pi checks NON_RETRYABLE before RETRYABLE — surviving keywords would otherwise block retry.

## Detection

Only ModelScope's **flat** JSON format is rewritten:

```json
{ "code": "...", "message": "...", "param": null, "type": "..." }
```

OpenAI's nested `{ "error": { ... } }` format is left untouched, so OpenAI's genuine `insufficient_quota` is never affected.

## Companion extensions

- [`modelscope-rate-limit`](../modelscope-rate-limit) — real-time quota monitoring in the status bar
- [`model-usage`](../model-usage) — persistent quota storage and `/model-usage` command

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

Or symlink locally for development:

```bash
ln -s /path/to/pi-extensions/extensions/modelscope-429 ~/.pi/agent/extensions/modelscope-429
```

Disable the `proxy-429` extension if enabled — this replaces it entirely.

## File

- `extensions/modelscope-429/index.ts` — the extension source
