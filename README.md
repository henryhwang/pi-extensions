# Pi Extensions

A collection of extensions for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [**model-rotate**](extensions/model-rotate/) | Rotates through a pool of LLM models and guards against HTTP 429 rate-limit errors |
| [**model-usage**](extensions/model-usage/) | `/model-usage` command — tracks ModelScope API rate-limit quotas (user limit/remaining + model limit/remaining) from response headers |
| [**requests**](extensions/requests/) | `/requests` command — shows per-model LLM API request count for monitoring rate-limit usage |
| [**subagent**](extensions/subagent/) | Delegates tasks to specialized agents (scout, planner, reviewer, worker) running in isolated pi processes |
| [**web-search**](extensions/web-search/) | Multi-provider web search (Tavily → Exa → Serper) with automatic fallback. Keys persist across sessions in pi's `auth.json` — set once via `/web-search-config`, survive restarts. |
| [**web-fetch**](extensions/web-fetch/) | Fetches a specific URL and extracts readable content (HTML → markdown) |
| [**edit**](extensions/edit/) | Enhanced `edit` tool — overrides pi's built-in to fix file corruption on fuzzy match, add tab/space fuzzy matching, and improve error messages with nearby context |

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

This installs all 7 extensions. Dependencies (`turndown`, `linkedom`, `@mozilla/readability` for web-fetch; `diff` for edit) are installed automatically.

To load only specific extensions, add a filtered entry to `settings.json`:

```json
{
  "packages": [{
    "source": "git:github.com/henryhwang/pi-extensions",
    "extensions": ["extensions/web-search", "extensions/web-fetch"]
  }]
}
```

Or use `pi config` to toggle individual extensions after install.

### Manual (symlink)

For local development, symlink individual extensions into pi's extension directory:

```bash
# Global (all projects)
ln -s /path/to/pi-extensions/extensions/<name> ~/.pi/agent/extensions/<name>

# Project-local
mkdir -p .pi/extensions
ln -s ../../extensions/<name> .pi/extensions/<name>
```

Then reload pi with `/reload` or restart. Run `npm install` in the project root for dependencies.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent)
- Node.js dependencies: `npm install` (for TypeScript types and pi SDK packages)

## License

MIT
