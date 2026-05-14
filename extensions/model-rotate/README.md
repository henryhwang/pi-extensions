# Model Rotation & 429 Guard

Rotates through a pool of LLM models and guards against HTTP 429 rate-limit errors.

## Features

### Model Rotation (off by default)
Automatically switches to the next model in the pool after each turn. Only rotates when the current model is already in the configured pool.

### 429 Guard (on by default)
Detects rate-limit errors and applies model-specific cooldowns:

| 429 type | Detection | Cooldown | Behavior |
|----------|-----------|----------|----------|
| **RPM** (requests per minute) | `rate limit` / `too many requests` | 60 seconds | Waits for cooldown, then retries |
| **Quota** (daily exhausted) | `quota` / `exceeded your current` / `billing` | 1 hour | Gives up immediately if all models at quota |

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