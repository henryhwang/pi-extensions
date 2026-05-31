# Model Rotation & 429 Guard

Rotates through a pool of LLM models and guards against HTTP 429 rate-limit errors.

## Features

### Model Rotation (off by default)
Automatically switches to the next model in the pool after each turn. Only rotates when the current model is already in the configured pool.

### 429 Guard (on by default)
Detects rate-limit errors and applies model-specific cooldowns:

| 429 type | Detection | Cooldown | Behavior |
|----------|-----------|----------|----------|
| **RPM** (temporary rate limit) | `rate limit` / `too many requests` / `quota exceeded` / `exceeded your current quota` — **without explicit timeline** | 60 seconds | Waits for cooldown, then retries |
| **Quota** (daily/monthly exhausted) | Contains `try again tomorrow`, `today's quota`, `daily limit`, or `monthly limit` | 1 hour | Gives up immediately if all models at quota |

#### ModelScope Error Examples

ModelScope returns two distinct 429 formats with **opposite** handling from pi core:

**Error Type A** (retryable → RPM):
> *"You exceeded your current quota, please check your plan and billing details"*

- No explicit timeline ("tomorrow", "today") → classifies as **RPM**
- "Check your billing details" is informational, not a payment demand
- Wait ~60s, then retry or rotate to next model

**Error Type B** (non-retryable → Quota):
> *"You have exceeded today's quota for model ZhipuAI/GLM-5.1, please try again tomorrow, or consider using other models"*

- Contains `today's quota` + `try again tomorrow` → classifies as **Quota**
- Explicit 24-hour reset window — don't waste retries
- If all pool models hit this, extension gives up until tomorrow

## Configuration

Edit the `MODEL_POOL` array at the top of `index.ts`:

```ts
const MODEL_POOL: Array<{ provider: string; id: string }> = [
  { provider: "modelscope", id: "deepseek-ai/DeepSeek-V4-Pro" },
  { provider: "modelscope-xiaoxu", id: "deepseek-ai/DeepSeek-V4-Pro" },
];

const COOLDOWNS: Record<RateLimitType, number> = {
  rpm: 60_000,       // 1 minute
  quota: 3_600_000,  // 1 hour
};

const MAX_WAIT_MS = 120_000;  // Max total wait per request
```

## Commands

| Command | Description |
|---------|-------------|
| `/rotate-on` | Enable auto-rotation after each turn |
| `/rotate-off` | Disable auto-rotation |
| `/rotate-toggle` | Toggle auto-rotation on/off |
| `/rotate-now` | Manual one-shot rotation to next model |
| `/rotate-429-toggle` | Toggle 429 guard on/off |
| `/rotate-status` | Show pool with cooldown timers and types |

## CLI Flags

| Flag | Description |
|------|-------------|
| `--rotate` | Start with auto-rotation enabled |
| `--no-rotate-429` | Disable 429 guard at startup |

## Status Bar

Shows current state in pi's status bar:

- `429-guard (2 models)` — all models available
- `429-guard (1 avail, 1 rpm cooling)` — one model RPM-limited
- `429-guard (1 avail, 1 quota cooling)` — one model at daily quota
- `429-guard (rpm \| 1/2 avail)` — current model is RPM-limited
- `429-guard (quota \| 0/2 avail)` — current model at daily quota
- `auto+429-guard (2 models)` — both features active

## File

- `extensions/model-rotate/index.ts` — the extension source