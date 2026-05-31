# ModelScope Rate-Limit Status Bar

Real-time ModelScope quota monitoring in pi's status bar with low-quota warnings.

## Features

- **Status bar indicator**: shows current model-level quota as `quota: 42/100` after every ModelScope request
- **Low-quota warning**: when remaining ≤ 5, status bar shows `[⚠️ LOW: 3/100]` with a popup notification
- **Provider-flexible**: matches any ModelScope provider (`modelscope`, `modelscope-cn`, etc.)
- **Zero config**: works automatically — just use a ModelScope model

## How it works

1. Listens to `after_provider_response` events
2. If the provider starts with `"modelscope"`, reads the response headers:
   - `modelscope-ratelimit-model-requests-limit`
   - `modelscope-ratelimit-model-requests-remaining`
3. Updates the status bar in real time
4. Triggers a warning notification when remaining drops to ≤ 5

## Status bar states

| Remaining | Status bar |
|-----------|-----------|
| > 5 | `quota: 42/100` |
| ≤ 5 | `[⚠️ LOW: 3/100]` |
| No header | (cleared) |

## Companion extension

Pairs well with [`model-usage`](../model-usage) which provides persistent quota storage and the `/model-usage` command for detailed breakdowns.

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

Or symlink locally for development:

```bash
ln -s /path/to/pi-extensions/extensions/modelscope-rate-limit.ts ~/.pi/agent/extensions/modelscope-rate-limit.ts
```

## Files

- `extensions/modelscope-rate-limit.ts` — the extension source