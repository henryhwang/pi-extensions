# Web Fetch Extension for Pi Coding Agent

Fetches a specific URL and extracts readable content. Companion to [web_search](../web-search/): search finds URLs, web_fetch reads them in depth.

## Features

- **HTML → markdown**: preserves headings, links, and code blocks via Turndown (ideal for LLM consumption)
- **HTML → plain text**: recursive DOM extraction strips all formatting for minimal output
- **JSON passthrough**: returns raw JSON as-is (API responses, etc.)
- **Reader mode**: optional `@mozilla/readability` integration extracts the main article, removing boilerplate (nav, ads, sidebars)
- **Output truncation**: capped at 50KB / 2000 lines (pi defaults); full content saved to temp file when truncated
- **Noise removal**: strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>`, `<noscript>`, and HTML comments before conversion
- **SSRF protection**: blocks localhost, loopback, private/link-local IPs, decimal/hex IP bypasses, and non-HTTP protocols; validates the final URL after redirects
- **Binary blocking**: rejects images, audio, video, PDFs, archives, fonts, and other binary content types
- **URL sanitization**: strips wrapping quotes, `@`-prefixes, and trailing junk characters
- **Error redaction**: truncates error messages and redacts long opaque tokens
- **Request timeout**: 20-second limit, cancellable via agent abort signal

## Installation

```bash
ln -s /path/to/pi-extensions/extensions/web-fetch ~/.pi/agent/extensions/web-fetch
```

Then run `npm install` in the pi-extensions project directory (for dependencies) and `/reload` in pi.

## Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | (required) | URL to fetch and read |
| `format` | "markdown" / "text" | "markdown" | Output format for HTML pages. JSON and plain text are returned as-is. |
| `readerMode` | boolean | false | Use `@mozilla/readability` to extract the main article content, removing boilerplate like navigation, ads, and sidebars. Best for news articles and blog posts. |

## Usage with web_search

The typical workflow is: `web_search` → get URLs → `web_fetch` to read promising ones:

```
# Step 1: search
web_search("rust async traits best practices")

# Step 2: fetch a promising result
web_fetch(url: "https://blog.rust-lang.org/2026/01/01/async-traits.html")

# Step 3: fetch with reader mode for a long article
web_fetch(url: "https://example.com/long-article", readerMode: true)
```

## Format comparison

| Format | Best for | Example |
|--------|----------|---------|
| `markdown` (default) | LLM consumption, docs, blog posts | Preserves `# headings`, `[links]`, ```code blocks``` |
| `text` | Minimal extraction, quick scanning | Strips all HTML, just plain text |

## Reader mode

Enable `readerMode: true` for article-heavy pages (news, blogs, documentation). It uses `@mozilla/readability` to:

- Extract the main article content
- Remove navigation, ads, sidebars, and other boilerplate
- Fall back to full content if Readability fails to parse

## Truncation

Output is truncated to ~50KB (~10k tokens) and 2000 lines (pi's default limits). When truncated:

- The tool appends a notice: `[Content truncated: showing 200 of 500 lines (12KB of 30KB). Full content saved to: /tmp/pi-fetch-xxx/content.md]`
- The LLM can use the `read` tool to access the full temp file if needed

## Error handling

- HTTP errors: shows status code and redacted error message
- Timeout: 20-second limit, auto-cancels if the agent turn is aborted
- Large responses: capped at 5MB raw fetch size
- SSRF: blocks private network addresses, localhost, decimal/hex IP bypasses, and non-HTTP protocols; also validates the final URL after redirects
- Binary content: rejected with a clear error message

## Dependencies

- `turndown` — HTML to markdown conversion
- `linkedom` — server-side DOM parsing (used by both Turndown and text extraction)
- `@mozilla/readability` (optional) — reader mode article extraction; if not installed, reader mode falls back to raw DOM

## File

- `extensions/web-fetch/index.ts` — the extension source
