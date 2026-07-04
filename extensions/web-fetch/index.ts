/**
 * Web Fetch Tool for Pi Coding Agent
 *
 * Fetches a URL and returns clean, readable content as markdown or plain text.
 *
 * Parameters:
 * - url (required): URL to fetch
 * - format: "markdown" (default) or "text"
 * - readerMode: use @mozilla/readability to extract main article content (default: false)
 *
 * Features:
 * - Proxy fallback: retries through a proxy-fetch worker when the direct fetch
 *   is blocked (403/451/network error/timeout). Disabled by default — enable via
 *   the WEB_FETCH_PROXY_URL env var or /proxy-fetch slash command.
 * - Relative link resolution: resolves relative URLs (href/src/action) in the
 *   DOM against the page's final URL before markdown conversion, so links like
 *   /docs/api become https://example.com/docs/api.
 * - Streaming fetch with hard 5MB raw response limit
 * - SSRF protection (blocks localhost, private/link-local IPs, non-HTTP protocols)
 *   — applied to both the initial URL and the final URL after redirects/proxy
 * - Binary content detection and blocking
 * - URL sanitization (strips wrapping quotes, @-prefixes, trailing junk)
 * - Optional reader mode via @mozilla/readability for article extraction
 * - linkedom + Turndown for HTML→markdown; recursive DOM extraction for plain text
 * - HTML noise removal (strips script, style, nav, footer, header, aside, noscript)
 * - Error redaction (truncates messages + redacts long opaque tokens)
 * - Request timeout (20s) with abort signal support
 * - Output truncation (50KB / 2000 lines via pi defaults) with temp file fallback
 * - Temp file cleanup on session shutdown
 */

import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { NodeFilter, parseHTML } from "linkedom";
import TurndownService from "turndown";

// ── Types ──────────────────────────────────────────────────────
interface FetchOutput {
  url: string;
  contentType: string;
  content: string;
  truncated: boolean;
  totalBytes: number; // processed content bytes
  outputBytes: number;
  format: "markdown" | "text";
  readerMode: boolean;
  viaProxy: boolean;
  tempFile?: string;
}

interface FetchedBody {
  body: string;
  contentType: string;
  baseUrl: string; // final URL after redirects (for relative link resolution)
}

/** HTTP error carrying the status code, so retry logic can decide. */
class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Errors that should never trigger a proxy retry (SSRF, binary, too large, etc.) */
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// ── Constants ──────────────────────────────────────────────────
const MAX_FETCH_SIZE = 5 * 1024 * 1024;

/**
 * Proxy URL for fallback fetching when the direct fetch is blocked.
 *
 * Empty by default — no proxy fallback. Enable by:
 *   - Setting the WEB_FETCH_PROXY_URL env var before starting pi
 *   - Running /proxy-fetch <url> during a session
 *
 * Can be changed at runtime via the /proxy-fetch slash command.
 */
let proxyUrl = process.env.WEB_FETCH_PROXY_URL ?? "";

/** URLs matching this pattern are already absolute or non-HTTP — skip resolution. */
const SKIP_URL_PATTERN = /^(https?:\/\/|data:|mailto:|tel:|#|javascript:)/i;

// ── HTTP helpers ───────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 20000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);

  try {
    const fetchSignal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    return await fetch(url, {
      ...options,
      signal: fetchSignal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Build a proxy-fetch URL for the given target. */
function buildProxyFetchUrl(targetUrl: string): string {
  const u = new URL(proxyUrl);
  u.searchParams.set("url", targetUrl);
  return u.href;
}

/**
 * Whether a failed direct fetch should be retried through the proxy.
 *
 * Retries on: 403 (forbidden/firewall), 451 (legal/geo-block), and network
 * errors / timeouts (any thrown error that isn't a NonRetryableError or
 * non-blocking HttpError).
 */
function shouldRetryViaProxy(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  if (err instanceof HttpError) {
    return err.status === 403 || err.status === 451;
  }
  // Network errors (TypeError from fetch), timeouts (AbortError/TimeoutError),
  // and any other unexpected thrown error — retry as a best-effort fallback.
  return true;
}

/** Shorten a proxy URL for display in status widgets and notifications. */
function shortenProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.length > 24 ? `${u.hostname.slice(0, 24)}...` : u.hostname;
    return `${u.protocol}//${host}`;
  } catch {
    return url.length > 30 ? `${url.slice(0, 30)}...` : url;
  }
}

// ── URL / content-type helpers ─────────────────────────────────

function cleanUrl(url: string): string {
  return url.trim().replace(/^[@\s"'`<>]+|[\s"'`<>]+$/g, "");
}

function isBinaryContent(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("image/") ||
    lower.includes("audio/") ||
    lower.includes("video/") ||
    lower.includes("application/pdf") ||
    lower.includes("application/zip") ||
    lower.includes("application/x-zip") ||
    lower.includes("application/octet-stream") ||
    lower.includes("font/")
  );
}

function isSafeUrl(urlString: string): { safe: boolean; error?: string } {
  try {
    const url = new URL(urlString);
    if (!["http:", "https:"].includes(url.protocol)) {
      return { safe: false, error: "Only http and https protocols are allowed" };
    }
    const host = url.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)) {
      return { safe: false, error: "Localhost access is blocked" };
    }
    if (/^127\.\d+\.\d+\.\d+$/.test(host)) {
      return { safe: false, error: "Loopback addresses are blocked" };
    }
    if (/^\d+$/.test(host)) {
      return { safe: false, error: "Decimal IP addresses are blocked" };
    }
    if (/^0x[0-9a-f]+$/i.test(host)) {
      return { safe: false, error: "Hexadecimal IP addresses are blocked" };
    }
    // Anchored patterns: only match at start of hostname (prevents false positives
    // on domain names that happen to contain these prefixes)
    if (
      /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|fd[0-9a-f]{2}:|fe80:)/.test(host)
    ) {
      return { safe: false, error: "Private network addresses are blocked (SSRF protection)" };
    }
    return { safe: true };
  } catch {
    return { safe: false, error: "Invalid URL format" };
  }
}

function redactError(text: string): string {
  return text.slice(0, 200).replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

function getCharset(contentType: string): string | undefined {
  const m = contentType.match(/charset=([^;]+)/i);
  if (!m) return undefined;
  return m[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

// ── Body reading ───────────────────────────────────────────────

/** Stream-read the response body with a hard size limit and charset decoding. */
async function readResponseBody(res: Response, contentType: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new NonRetryableError("Response body is not readable");

  let bodyText = "";
  let rawBytes = 0;

  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(getCharset(contentType) || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        rawBytes += value.byteLength;
        if (rawBytes > MAX_FETCH_SIZE) {
          await reader.cancel().catch(() => {});
          throw new NonRetryableError(
            `Response too large (exceeded ${formatSize(MAX_FETCH_SIZE)})`,
          );
        }
        bodyText += decoder.decode(value, { stream: true });
      }
    }
    // Flush any remaining bytes from the decoder
    bodyText += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return bodyText;
}

// ── Core fetch (direct or via proxy) ───────────────────────────

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0)",
  Accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*",
};

/**
 * Fetch a URL and read its body. Works for both direct and proxied fetches.
 *
 * For proxied fetches, the final URL (after redirects) comes from the
 * X-Final-URL response header that the proxy-fetch worker sets.
 * For direct fetches, res.url gives the final URL.
 */
async function fetchAndReadBody(
  url: string,
  signal: AbortSignal | undefined,
  useProxy: boolean,
): Promise<FetchedBody> {
  const fetchUrl = useProxy ? buildProxyFetchUrl(url) : url;

  const res = await fetchWithTimeout(fetchUrl, { signal, headers: FETCH_HEADERS }, 20000);

  // Extract final URL: proxy returns X-Final-URL header, direct fetch uses res.url
  const baseUrl = res.headers.get("X-Final-URL") || res.url;

  // Defense-in-depth: verify the final URL after redirects
  const finalSafety = isSafeUrl(baseUrl);
  if (!finalSafety.safe) {
    throw new NonRetryableError(`Redirected to blocked URL: ${finalSafety.error}`);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(`HTTP ${res.status} from ${baseUrl}: ${redactError(errText)}`, res.status);
  }

  const contentType = res.headers.get("content-type") || "text/plain";

  // Early content-type check before streaming the body
  if (isBinaryContent(contentType)) {
    throw new NonRetryableError(
      `Binary content detected (${contentType}). This tool only supports text/HTML/JSON.`,
    );
  }

  const body = await readResponseBody(res, contentType);
  return { body, contentType, baseUrl };
}

// ── Content Processing ─────────────────────────────────────────
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Resolve relative URLs (href, src, action) in the DOM against baseUrl.
 *
 * Turndown has no baseUrl option, so relative links like /docs/api would
 * become broken markdown links. This fixes them in the DOM before conversion.
 */
function resolveRelativeUrls(doc: Document, baseUrl: string): void {
  for (const el of doc.querySelectorAll("[href], [src], [action]")) {
    for (const attr of ["href", "src", "action"] as const) {
      const val = el.getAttribute(attr);
      if (!val || SKIP_URL_PATTERN.test(val)) continue;
      try {
        el.setAttribute(attr, new URL(val, baseUrl).href);
      } catch {
        // Ignore malformed URLs
      }
    }
  }
}

function cleanHtml(html: string): Document {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll(
    "script, style, nav, footer, header, aside, noscript",
  )) {
    el.remove();
  }
  // Strip HTML comments
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) {
    comments.push(walker.currentNode as Comment);
  }
  for (const comment of comments) {
    comment.parentNode?.removeChild(comment);
  }
  return document;
}

/** Recursive DOM text extractor with better spacing */
function extractTextFromDOM(node: Node): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType !== 1) return "";

  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  let text = "";

  for (const child of element.childNodes) {
    text += extractTextFromDOM(child);
  }

  const blockTags = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "TD",
    "TH",
    "TR",
    "BLOCKQUOTE",
    "PRE",
  ]);
  if (blockTags.has(tag)) {
    text = `\n${text.trim()}\n`;
  } else if (tag === "BR") {
    text += "\n";
  }

  return text;
}

/** Minimum meaningful content length for reader mode to be considered useful */
const MIN_READER_CONTENT_LENGTH = 100;

/** Optional high-quality extraction using Readability */
async function processHtml(
  html: string,
  format: "markdown" | "text",
  readerMode: boolean = false,
  baseUrl?: string,
): Promise<string> {
  // Create the fallback document FIRST (before Readability mutates it)
  const document = cleanHtml(html);

  let targetDoc = document;
  let readerSucceeded = false;

  if (readerMode) {
    try {
      // Clone the document for Readability — it mutates in-place (strips/moves/removes nodes)
      const { document: readerDoc } = parseHTML(html);
      for (const el of readerDoc.querySelectorAll(
        "script, style, nav, footer, header, aside, noscript",
      )) {
        el.remove();
      }

      const { Readability } = await import("@mozilla/readability");
      const reader = new Readability(readerDoc);
      const article = reader.parse();

      if (article?.content) {
        const { document: cleanDoc } = parseHTML(article.content);
        // Strip noise from Readability output (scripts, styles, noscript)
        for (const el of cleanDoc.querySelectorAll("script, style, noscript")) {
          el.remove();
        }

        // Quality check: render to final format and measure
        let readerContent: string;
        try {
          if (format === "markdown") {
            readerContent = turndownService.turndown(cleanDoc.body || cleanDoc.documentElement);
          } else {
            const rawText = extractTextFromDOM(cleanDoc.body || cleanDoc.documentElement);
            readerContent = rawText
              .replace(/\n{3,}/g, "\n\n")
              .replace(/[ \t]+/g, " ")
              .trim();
          }
        } catch {
          readerContent = "";
        }

        // Only use reader mode output if it's meaningful
        if (readerContent.length >= MIN_READER_CONTENT_LENGTH) {
          targetDoc = cleanDoc;
          readerSucceeded = true;
        } else {
          console.warn(
            `[web_fetch] Readability output too short (${readerContent.length} chars), ` +
              "falling back to raw DOM extraction",
          );
        }
      }
    } catch (err) {
      console.warn("[web_fetch] Readability failed, falling back to raw DOM", err);
    }
  }

  try {
    // Resolve relative URLs against the page's base URL before conversion.
    // Applied to targetDoc so it covers both the fallback and reader-mode paths.
    if (baseUrl) {
      resolveRelativeUrls(targetDoc, baseUrl);
    }

    let result: string;
    if (format === "markdown") {
      result = turndownService.turndown(targetDoc.body || targetDoc.documentElement);
    } else {
      const rawText = extractTextFromDOM(targetDoc.body || targetDoc.documentElement);
      result = rawText
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+/g, " ")
        .trim();
    }

    // If reader mode was requested but produced no useful output, note it at the top
    // (top placement ensures visibility even when content is truncated)
    if (readerMode && !readerSucceeded) {
      result =
        "_Note: reader mode could not extract article content; fell back to full page._\n\n" +
        result;
    }

    return result;
  } catch (parseErr) {
    console.warn("[web_fetch] HTML processing failed, falling back to raw text", parseErr);
    return html;
  }
}

// ── Core Fetch ─────────────────────────────────────────────────
async function fetchUrl(
  url: string,
  format: "markdown" | "text" = "markdown",
  readerMode: boolean = false,
  signal?: AbortSignal,
): Promise<FetchOutput> {
  const normalizedUrl = cleanUrl(url);

  const safety = isSafeUrl(normalizedUrl);
  if (!safety.safe) {
    throw new NonRetryableError(`URL rejected: ${safety.error}`);
  }

  // Try direct fetch first, fall back to proxy on blocking errors
  // (403/451/firewall blocks, network errors, timeouts)
  let fetched: FetchedBody;
  let viaProxy = false;

  try {
    fetched = await fetchAndReadBody(normalizedUrl, signal, false);
  } catch (directErr) {
    if (!proxyUrl || !shouldRetryViaProxy(directErr)) {
      throw directErr;
    }
    // Retry through proxy
    try {
      fetched = await fetchAndReadBody(normalizedUrl, signal, true);
      viaProxy = true;
    } catch (proxyErr) {
      // Both direct and proxy failed — include both error messages for debugging
      const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
      const proxyMsg = proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
      throw new Error(`Direct fetch failed: ${directMsg}\nProxy fetch also failed: ${proxyMsg}`);
    }
  }

  const { body: bodyText, contentType, baseUrl } = fetched;

  // Process content
  let content: string;
  if (contentType.includes("application/json")) {
    content = bodyText;
  } else if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    content = await processHtml(bodyText, format, readerMode, baseUrl);
  } else {
    content = bodyText;
  }

  // Truncation
  const truncation = truncateHead(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const output: FetchOutput = {
    url: normalizedUrl,
    contentType,
    content: truncation.content,
    truncated: truncation.truncated,
    totalBytes: truncation.totalBytes,
    outputBytes: truncation.outputBytes,
    format,
    readerMode,
    viaProxy,
  };

  if (truncation.truncated) {
    try {
      const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-"));
      const tempFile = join(tempDir, "content.md");

      await writeFile(tempFile, content, "utf8");
      output.tempFile = tempFile;

      const omitted = truncation.totalBytes - truncation.outputBytes;
      output.content +=
        `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
        `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
        `${formatSize(omitted)} omitted. Full content saved to: ${tempFile}]`;
    } catch (_fsError) {
      // Best-effort failed, append a notice but don't crash
      output.content += `\n\n[Content truncated. Failed to save full content to temporary file.]`;
    }
  }

  return output;
}

// ── Tool Schema ────────────────────────────────────────────────
const FetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch" }),
  format: Type.Optional(
    StringEnum(["markdown", "text"] as const, {
      description: "'markdown' (default) preserves structure. 'text' returns plain text.",
    }),
  ),
  readerMode: Type.Optional(
    Type.Boolean({
      description:
        "Use @mozilla/readability to extract main article content (removes boilerplate). Defaults to false.",
      default: false,
    }),
  ),
});

// ── Extension ──────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const tempFiles = new Set<string>();

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a URL and return clean readable content.",
      "Use readerMode=true for better quality on news/articles/blogs.",
    ].join("\n"),
    parameters: FetchParams,

    async execute(_toolCallId, params, signal) {
      try {
        const output = await fetchUrl(
          params.url,
          params.format ?? "markdown",
          params.readerMode ?? false,
          signal,
        );

        if (output.tempFile) tempFiles.add(output.tempFile);

        return {
          content: [{ type: "text" as const, text: output.content }],
          details: output,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Fetch failed: ${msg}` }],
          details: null,
        };
      }
    },

    renderCall(args, theme) {
      const url = args.url;
      const format = args.format ?? "markdown";
      const reader = args.readerMode ? " [reader]" : "";
      const displayUrl = url.length > 80 ? `${url.slice(0, 80)}...` : url;
      const text =
        theme.fg("toolTitle", theme.bold("web_fetch ")) +
        theme.fg("accent", displayUrl) +
        theme.fg("muted", ` [${format}]${reader}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as FetchOutput | null;
      if (!details) {
        const firstContent = result.content[0];
        return new Text(firstContent?.type === "text" ? firstContent.text : "(no content)", 0, 0);
      }

      const lines: string[] = [];

      // Status line (no tool name/URL repeat — renderCall already shows those)
      const typeLabel = details.contentType.split(";")[0].trim();
      let status = theme.fg("muted", `${typeLabel}, ${formatSize(details.outputBytes)}`);
      if (details.format === "markdown" && typeLabel.includes("html")) {
        status += theme.fg("dim", " → markdown");
      }
      if (details.viaProxy) {
        status += theme.fg("dim", " via proxy");
      }
      if (details.truncated) {
        status += theme.fg("warning", ` (truncated, full: ${details.tempFile})`);
      }
      lines.push(status);

      // Preview: first few lines of content
      const content = result.content[0];
      if (content?.type === "text") {
        const previewLines = content.text.split("\n").slice(0, 8);
        for (const line of previewLines) {
          const display = line.length > 120 ? `${line.slice(0, 120)}...` : line;
          lines.push(theme.fg("toolOutput", display));
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // Cleanup temp files
  pi.on("session_shutdown", async () => {
    for (const file of tempFiles) {
      try {
        await unlink(file).catch(() => {});
        await rmdir(dirname(file)).catch(() => {});
      } catch (_) {}
    }
    tempFiles.clear();
  });

  // ── Proxy-fetch command ────────────────────────────────────
  pi.registerCommand("proxy-fetch", {
    description: "Configure the proxy-fetch URL used as a fallback when direct fetches are blocked",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        // Show current status
        const status = proxyUrl
          ? `Proxy-fetch: ${shortenProxyUrl(proxyUrl)}`
          : "Proxy-fetch: disabled (direct fetch only)";
        ctx.ui.notify(status, "info");
        return;
      }

      if (arg === "off" || arg === "disable") {
        proxyUrl = "";
        ctx.ui.notify("Proxy-fetch disabled", "info");
        ctx.ui.setStatus("proxy-fetch", "off");
        return;
      }

      if (arg === "default" || arg === "reset") {
        // Reset to the env var value (may be empty = disabled)
        proxyUrl = process.env.WEB_FETCH_PROXY_URL ?? "";
        const msg = proxyUrl
          ? `Proxy-fetch reset to: ${shortenProxyUrl(proxyUrl)}`
          : "Proxy-fetch reset: no URL configured (disabled)";
        ctx.ui.notify(msg, "info");
        ctx.ui.setStatus("proxy-fetch", proxyUrl ? shortenProxyUrl(proxyUrl) : "off");
        return;
      }

      // Try to parse as a URL
      try {
        const u = new URL(arg);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          ctx.ui.notify("Proxy URL must use http or https", "error");
          return;
        }
        proxyUrl = u.href;
        ctx.ui.notify(`Proxy-fetch set to: ${shortenProxyUrl(proxyUrl)}`, "info");
        ctx.ui.setStatus("proxy-fetch", shortenProxyUrl(proxyUrl));
      } catch {
        ctx.ui.notify(
          "Invalid URL. Use: /proxy-fetch <url> | off | default | <no args for status>",
          "error",
        );
      }
    },
  });

  // Show proxy status on session start (only if configured)
  pi.on("session_start", (_event, ctx) => {
    if (proxyUrl) {
      ctx.ui.setStatus("proxy-fetch", shortenProxyUrl(proxyUrl));
    }
  });
}
