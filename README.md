# Pi Extensions

A collection of extensions for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [**model-rotate**](extensions/model-rotate/) | Rotates through a pool of LLM models and guards against HTTP 429 rate-limit errors |
| [**requests**](extensions/requests/) | `/requests` command — shows per-model LLM API request count for monitoring rate-limit usage |
| [**subagent**](extensions/subagent/) | Delegates tasks to specialized agents (scout, planner, reviewer, worker) running in isolated pi processes |
| [**web-search**](extensions/web-search/) | Multi-provider web search (Tavily → Exa → Serper) with automatic fallback. Keys persist across sessions in pi's `auth.json` — set once via `/web-search-config`, survive restarts. |
| [**web-fetch**](extensions/web-fetch/) | Fetches a specific URL and extracts readable content (HTML → markdown) |

## Installation

Each extension is a self-contained directory. Symlink the ones you want into pi's extension directory:

```bash
# Global (all projects)
ln -s /path/to/pi-extensions/extensions/<name> ~/.pi/agent/extensions/<name>

# Project-local
mkdir -p .pi/extensions
ln -s ../../extensions/<name> .pi/extensions/<name>
```

For example, to install all extensions:

```bash
for ext in model-rotate requests subagent web-search web-fetch; do
  ln -s /path/to/pi-extensions/extensions/$ext ~/.pi/agent/extensions/$ext
done
```

Or one at a time:

```bash
ln -s /path/to/pi-extensions/extensions/model-rotate ~/.pi/agent/extensions/model-rotate
ln -s /path/to/pi-extensions/extensions/requests ~/.pi/agent/extensions/requests
ln -s /path/to/pi-extensions/extensions/subagent ~/.pi/agent/extensions/subagent
ln -s /path/to/pi-extensions/extensions/web-search ~/.pi/agent/extensions/web-search
ln -s /path/to/pi-extensions/extensions/web-fetch ~/.pi/agent/extensions/web-fetch
```

Then reload pi with `/reload` or restart.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent)
- Node.js dependencies: `npm install` (for TypeScript types and pi SDK packages)

## License

MIT
