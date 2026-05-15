# Web Fetch Extension for Pi Coding Agent

Fetches a specific URL and extracts readable content. Companion to [web_search](../web-search/): search finds URLs, web_fetch reads them in depth.

## Features

- **HTML → markdown**: preserves headings, links, and code blocks (ideal for LLM consumption)
- **HTML → plain text**: strips all formatting for minimal output
- **JSON passthrough**: returns raw JSON as-is (API responses, etc.)
- **Output truncation**: capped at 50KB / 2000 lines; full content saved to temp file when truncated
- **Noise removal**: strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>` before conversion
- **Request timeout**: 20 seconds, cancellable via agent abort signal

## Installation

```bash
ln -s /path/to/pi-extensions/extensions/web-fetch ~/.pi/agent/extensions/web-fetch
```

Then run `npm install` in the pi-extensions project directory (for the `turndown` dependency) and `/reload` in pi.

## Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | (required) | URL to fetch and read |
| `format` | "markdown" / "text" | "markdown" | Output format for HTML pages. JSON and plain text are returned as-is. |

## Usage with web_search

The typical workflow is: `web_search` → get URLs → `web_fetch` to read promising ones:

```
# Step 1: search
web_search("rust async traits best practices")

# Step 2: fetch a promising result
web_fetch(url: "https://blog.rust-lang.org/2026/01/01/async-traits.html")
```

## Format comparison

| Format | Best for | Example |
|--------|----------|---------|
| `markdown` (default) | LLM consumption, docs, blog posts | Preserves `# headings`, `[links]`, ```code blocks``` |
| `text` | Minimal extraction, quick scanning | Strips all HTML, just plain text |

## Truncation

Output is truncated to ~50KB (~10k tokens) and 2000 lines. When truncated:

- The tool appends a notice: `[Content truncated: showing 200 of 500 lines (12KB of 30KB). Full content saved to: /tmp/pi-fetch-xxx/content.md]`
- The LLM can use the `read` tool to access the full temp file if needed

## Error handling

- HTTP errors: shows status code and redacted error message
- Timeout: 20-second limit, auto-cancels if the agent turn is aborted
- Large responses: capped at 5MB raw fetch size

## Dependencies

- `turndown` — HTML to markdown conversion