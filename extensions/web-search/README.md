# Web Search Extension for Pi Coding Agent

Multi-provider web search with automatic fallback: **Tavily → Exa → Serper**.

## Providers

| Provider | Free tier | Resets? | Strength | API key env var |
|----------|-----------|---------|----------|----------------|
| **Tavily** | 1,000/mo | ✅ Monthly | Keyword search + AI summaries (best for docs, exact-match) | `TAVILY_API_KEY` |
| **Exa** | 1,000/mo | ✅ Monthly | Semantic/neural search (finds by meaning, best for conceptual discovery) | `EXA_API_KEY` |
| **Serper** | 2,500 total | ❌ One-time | Google SERP (broadest coverage, cheapest at scale) | `SERPER_API_KEY` |

### When does each provider fire?

Default priority: `tavily → exa → serper`

1. **Tavily** fires first if key is set
2. If Tavily fails (HTTP error, rate limit), falls through to **Exa**
3. If Exa also fails, falls through to **Serper**
4. If all configured providers fail, returns the last error
5. Unconfigured providers are skipped (no key → no attempt)

### Override priority at runtime

```
/web-search-config priority exa,tavily,serper
```

This makes Exa fire first (semantic search for conceptual queries).

## Setup

### Option 1: Environment variables (persistent)

```bash
# Add to ~/.bashrc or ~/.zshrc
export TAVILY_API_KEY="tvly-xxxxxxxxxxxxxxxx"    # https://tavily.com
export EXA_API_KEY="exa-xxxxxxxxxxxxxxxx"          # https://exa.ai
export SERPER_API_KEY="xxxxxxxxxxxxxxxx"            # https://serper.dev
```

### Option 2: Runtime config (per-session, no restart)

```
/web-search-config tavily tvly-xxxxxxxxxxxxxxxx
/web-search-config exa exa-xxxxxxxxxxxxxxxx
/web-search-config serper xxxxxxxxxxxxxxxx
```

### Option 3: Show current config

```
/web-search-config
```

Shows all configured keys (masked) and current priority order.

## Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Search query |
| `max_results` | number | 5 | Max results (1-10) |
| `search_depth` | "basic" / "advanced" | "basic" | Tavily only. Advanced returns full content + AI summary. |
| `include_domains` | string[] | — | Limit results to these domains |
| `exclude_domains` | string[] | — | Exclude domains. Only supported by Exa; ignored by others. |

## Exa-specific features

- **Semantic search**: finds pages by meaning, not just keyword match
- **`exclude_domains`**: filter out noise (e.g., `exclude_domains: ["pinterest.com"]`)
- **Author & date**: Exa results include `publishedDate` and `author` when available
- **Auto search type**: Exa's `type: "auto"` picks the best method (neural vs keyword) per query

## Example queries

```
# Exact-match debugging (Tavily wins)
web_search("python asyncio 429 error handling pattern")

# Conceptual discovery (Exa wins with priority override)
/web-search-config priority exa,tavily,serper
web_search("how to build a resilient retry mechanism with backoff")

# Domain-specific docs
web_search("rust async traits", include_domains=["docs.rust-lang.org", "github.com"])

# Exclude noise
web_search("react hooks tutorial", exclude_domains=["medium.com", "pinterest.com"])
```

## Combined free quota

| Period | Searches available |
|--------|--------------------|
| First month | 3,500 (1,000 Tavily + 1,000 Exa + 2,500 Serper) |
| After Serper exhausted | 2,000/mo (1,000 Tavily + 1,000 Exa) |
| After one provider rate-limited | Remaining providers continue seamlessly |

## File

- `~/.pi/agent/extensions/web-search/index.ts`
