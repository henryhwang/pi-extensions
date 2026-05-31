# ModelScope Quota Tracker

Tracks ModelScope API rate-limit quotas from HTTP response headers and displays them via `/model-usage`.

## Features

- **Auto-capture**: listens to `after_provider_response` events and extracts ModelScope quota headers
- **Four metrics tracked per model**:

| Header | Metric | Description |
|--------|--------|-------------|
| `modelscope-ratelimit-requests-limit` | User limit | Total user-level request quota |
| `modelscope-ratelimit-requests-remaining` | User remaining | Remaining user-level requests |
| `modelscope-ratelimit-model-requests-limit` | Model limit | Per-model request quota |
| `modelscope-ratelimit-model-requests-remaining` | Model remaining | Remaining per-model requests |

- **Supports all ModelScope variants**: tracks responses from `modelscope`, `modelscope-xiaoxu`, and any other provider name starting with `modelscope`
- **Session persistence**: quota data is saved to the session via `pi.appendEntry` and restored on start/reload
- **Per-model storage**: separate quota tracking for each model ID (e.g., `deepseek-ai/DeepSeek-V4-Pro`)

## Commands

| Command | Description |
|---------|-------------|
| `/model-usage` | Show all tracked ModelScope quota data (limit & remaining for user and model) |

### Example output

```
  deepseek-ai/DeepSeek-V4-Pro
    User:    1,000 limit, 847 remaining
    Model:   200 limit, 153 remaining
    Updated: 14:23:05
```

## How it works

1. After every provider response, the extension checks `ctx.model?.provider`
2. If `"modelscope"`, it reads the four quota headers from the HTTP response
3. Quota info is stored in memory (keyed by model ID) and saved to the session branch
4. On session start, it rebuilds the store by scanning for `"modelscope_quota"` custom entries
5. `/model-usage` reads from the in-memory store and displays the data

## Usage

Just send requests with a ModelScope model — quota data is captured automatically:

```
# Make a request using a ModelScope model
# (quota headers are captured silently)

/model-usage
# → Shows quota data as soon as one response is received
```

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

Or symlink locally for development:

```bash
ln -s /path/to/pi-extensions/extensions/model-usage ~/.pi/agent/extensions/model-usage
```

## File

- `extensions/model-usage/index.ts` — the extension source