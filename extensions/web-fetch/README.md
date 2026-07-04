# Web Fetch Extension for Pi Coding Agent

Fetches a specific URL and extracts readable content. Companion to [web_search](../web-search/): search finds URLs, web_fetch reads them in depth.

## Features

- **Proxy fallback**: automatically retries through a [proxy-fetch](https://github.com/henryhwang/pi-extensions) Cloudflare worker when the direct fetch is blocked (403/451/network error/timeout). Configurable via `WEB_FETCH_PROXY_URL` env var (default: `https://proxy-fetch.436799.xyz`; set to empty string to disable)
- **Relative link resolution**: resolves relative URLs (`/docs/api`, `../page`, `//cdn.example.com/...`) in the DOM against the page's final URL before markdown conversion, so links are usable in the output
- **HTML → markdown**: preserves headings, links, and code blocks via Turndown (ideal for LLM consumption)
- **HTML → plain text**: recursive DOM extraction strips all formatting for minimal output
- **JSON passthrough**: returns raw JSON as-is (API responses, etc.)
- **Reader mode**: optional `@mozilla/readability` integration extracts the main article, removing boilerplate (nav, ads, sidebars)
- **Output truncation**: capped at 50KB / 2000 lines (pi defaults); full content saved to temp file when truncated
- **Noise removal**: strips `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`, `<aside>`, `<noscript>`, and HTML comments before conversion
- **SSRF protection**: blocks localhost, loopback, private/link-local IPs, decimal/hex IP bypasses, and non-HTTP protocols; validates the final URL after redirects/proxy
- **Binary blocking**: rejects images, audio, video, PDFs, archives, fonts, and other binary content types
- **URL sanitization**: strips wrapping quotes, `@`-prefixes, and trailing junk characters
- **Error redaction**: truncates error messages and redacts long opaque tokens
- **Request timeout**: 20-second limit, cancellable via agent abort signal

## Installation

```bash
pi install git:github.com/henryhwang/pi-extensions
```

This installs all extensions from the package. Dependencies (`turndown`, `linkedom`, `@mozilla/readability`) are installed automatically via the root `package.json`.

To load only web-fetch, filter in `settings.json`:

```json
{
  "packages": [{
    "source": "git:github.com/henryhwang/pi-extensions",
    "extensions": ["extensions/web-fetch"]
  }]
}
```

Or use `pi config` to toggle individual extensions after install.

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
- Automatically fall back to full page content when Readability produces empty or near-empty output
- Appends `_Note:` to the output when fallback occurs, so you know reader mode didn't activate

The fallback handles common Readability failure modes:
- **Tables / structured data**: pricing pages, comparison tables (few `<p>` tags → Readability sees no article)
- **Chinese portals**: heavily nested DOM with nav bars, lazy-loaded images, and non-standard layouts
- **Doc sites**: Docusaurus, ReadTheDocs — sidebar + TOC structure confuses article detection
- **Readability mutation**: Readability modifies the document in-place during `parse()`. The extension runs it on a cloned document so the fallback source is never corrupted.

## Proxy fallback

When the direct fetch is blocked — by a firewall (403), geo-block (451), network
error, or timeout — web_fetch can retry through a [proxy-fetch](https://github.com/henryhwang/cf-workers)
Cloudflare worker. The worker fetches the URL through Cloudflare's edge network,
bypassing local network restrictions.

**Proxy fallback is disabled by default.** Enable it by:
- Setting the `WEB_FETCH_PROXY_URL` env var before starting pi, or
- Running `/proxy-fetch <url>` during a session

| Command | Effect |
|---------|--------|
| `/proxy-fetch` | Show current proxy URL |
| `/proxy-fetch https://my-proxy.example.com` | Set a custom proxy URL (enable) |
| `/proxy-fetch off` (or `disable`) | Disable proxy fallback |
| `/proxy-fetch default` (or `reset`) | Reset to the env var value |

The current proxy state is shown in the footer status line throughout the session.

Only blocking errors trigger a proxy retry:
- **Retried:** HTTP 403, HTTP 451, network errors (connection refused, DNS failure), timeouts
- **Not retried:** HTTP 404/401/5xx, binary content, response too large, SSRF blocks

If both direct and proxy fetches fail, the error message includes both failure
reasons for debugging. The result display shows `via proxy` when the proxy was used.

The proxy-fetch worker is independent of this extension — it's a standalone
Cloudflare worker that simply proxies HTTP requests and returns the final URL
(after redirects) in the `X-Final-URL` response header.

## Relative link resolution

When fetching an HTML page and converting to markdown, relative links like
`<a href="/docs/api">` would become broken markdown links
(`[API Reference](/docs/api)`). This extension resolves relative URLs in the
DOM against the page's final URL before conversion:

- Handles `href`, `src`, and `action` attributes on all matching elements
- Resolves against the final URL after redirects (via `X-Final-URL` header for
  proxied fetches, `res.url` for direct fetches)
- Skips already-absolute URLs, `data:`, `mailto:`, `tel:`, `#` fragments, and
  `javascript:` pseudo-protocols
- Protocol-relative URLs (`//cdn.example.com/...`) are also resolved

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

These are declared in the project root `package.json` and installed automatically by `pi install`.

## File

- `extensions/web-fetch/index.ts` — the extension source
