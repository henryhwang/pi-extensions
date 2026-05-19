# Requests Tracker

Shows LLM API request count per model for monitoring usage against provider rate limits.

## Command

| Command | Description |
|---------|-------------|
| `/requests` | Show total LLM API requests and per-model breakdown for the current session branch |

## Example output

```
Total LLM requests: 64
Messages: 8 user, 64 assistant, 80 tool results

Tokens: 512.3K total, 380.1K in, 132.2K out

  deepseek/deepseek-v4-flash: 48 requests, 320.0K tokens (250.0K in / 70.0K out)
  deepseek/deepseek-v4-pro: 16 requests, 192.3K tokens (130.1K in / 62.2K out)

  Each assistant message = 1 API call to the LLM provider.
  Tool calls can exceed assistant count due to parallel execution.
```

## How it counts

- **Each assistant message = 1 API call** to the LLM provider. An assistant message
  can contain multiple parallel tool calls (e.g., 3 `bash` calls at once), but that's
  still a single API request.
- **Only the current branch** is counted (via `getBranch()`). Messages on abandoned
  branches (from `/tree` navigation) are excluded.
- Counts are per-session (resets when you start a new session with `/new`)
- Displays as `provider/model` format
- Token counts use `K`/`M` suffixes (input = prompt tokens, output = completion tokens)

## Parallel execution note

Pi runs tool calls in parallel when the LLM requests multiple tools at once.
This means `tool results > assistant messages` is normal — e.g. 80 tool results
across 64 assistant messages means ~1.25 tools per turn on average, with some
turns running 2–5 tools in parallel.

## File

- `extensions/requests/index.ts` — the extension source
