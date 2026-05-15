/**
 * Web Fetch Tool for Coding Agents
 *
 * Fetches a specific URL and extracts readable content (markdown or plain text).
 * Companion to web_search: search finds URLs, web_fetch reads them in depth.
 *
 * Features:
 *   - HTML → markdown conversion (preserves headings, links, code blocks)
 *   - HTML → plain text stripping (removes all formatting)
 *   - JSON passthrough (returns raw JSON as-is)
 *   - Output truncation (50KB / 2000 lines) with temp file for full content
 *   - Request timeout (20s) with AbortSignal support
 *   - Error message redaction (strips long API-key-like strings)
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import TurndownService from "turndown";

// ── Types ──────────────────────────────────────────────────────

interface FetchOutput {
  url: string;
  contentType: string;
  content: string;
  truncated: boolean;
  totalBytes: number;
  outputBytes: number;
  format: "markdown" | "text";
  tempFile?: string;
}

// ── Constants ──────────────────────────────────────────────────

/** Max response body size to fetch (5MB) */
const MAX_FETCH_SIZE = 5 * 1024 * 1024;

// ── HTTP with timeout ──────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError")
    );
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

// ── Content extraction ─────────────────────────────────────────

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** Strip noise elements before conversion */
function cleanHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Convert HTML to readable markdown */
function htmlToMarkdown(html: string): string {
  return turndownService.turndown(cleanHtml(html));
}

/** Convert HTML to plain text (strips all tags) */
function htmlToText(html: string): string {
  const cleaned = cleanHtml(html);
  return cleaned
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Fetch implementation ───────────────────────────────────────

function redactError(text: string): string {
  return text
    .slice(0, 200)
    .replace(/\b[A-Za-z0-9_\-]{20,}\b/g, "[REDACTED]");
}

async function fetchUrl(
  url: string,
  format: "markdown" | "text" = "markdown",
  signal?: AbortSignal
): Promise<FetchOutput> {
  // Normalize URL — strip leading @ (some LLMs add this)
  const normalizedUrl = url.startsWith("@") ? url.slice(1) : url;

  const res = await fetchWithTimeout(normalizedUrl, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0)",
      "Accept": "text/html,text/plain,application/json,*/*",
    },
  }, 20000);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} fetching ${normalizedUrl}: ${redactError(errText)}`);
  }

  const contentType = res.headers.get("content-type") || "text/plain";
  const body = await res.text();

  // Convert based on content type and requested format
  let content: string;

  if (contentType.includes("application/json")) {
    // JSON: return as-is (already structured)
    content = body;
  } else if (contentType.includes("text/html")) {
    // HTML: convert to markdown or text
    content = format === "markdown" ? htmlToMarkdown(body) : htmlToText(body);
  } else {
    // Plain text or other: return as-is
    content = body;
  }

  // Truncate output
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
  };

  // Save full content to temp file when truncated
  if (truncation.truncated) {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-"));
    const tempFile = join(tempDir, "content.md");
    await writeFile(tempFile, content, "utf8");
    output.tempFile = tempFile;

    // Append truncation notice to the content
    const omittedBytes = truncation.totalBytes - truncation.outputBytes;
    output.content +=
      `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
      ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
      ` ${formatSize(omittedBytes)} omitted.` +
      ` Full content saved to: ${tempFile}]`;
  }

  return output;
}

// ── Tool schema ────────────────────────────────────────────────

const FetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch and read" }),
  format: Type.Optional(
    StringEnum(["markdown", "text"] as const, {
      description:
        "Output format for HTML pages. 'markdown' preserves headings, links, and code blocks (default, best for LLM consumption). 'text' strips all formatting. JSON and plain-text URLs are returned as-is regardless of this setting.",
    }),
  ),
});

// ── Extension ──────────────────────────────────────────────────

/**
 * The Web Fetch extension.
 * Registers the `web_fetch` tool for reading specific URLs in depth.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a specific URL and extract its readable content.",
      "",
      "Use this after web_search to read promising results in depth,",
      "or when you already know the exact URL you need.",
      "",
      "HTML pages are converted to markdown (headings, links, code blocks preserved).",
      "JSON responses are returned as-is. Output is truncated to 50KB.",
    ].join("\n"),
    parameters: FetchParams,

    async execute(_toolCallId, params, signal) {
      const url = params.url;
      const format = params.format ?? "markdown";

      try {
        const output = await fetchUrl(url, format, signal);

        return {
          content: [{ type: "text" as const, text: output.content }],
          details: {
            url: output.url,
            contentType: output.contentType,
            format: output.format,
            truncated: output.truncated,
            totalBytes: output.totalBytes,
            outputBytes: output.outputBytes,
            tempFile: output.tempFile,
          },
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
      const displayUrl = url.length > 80 ? url.slice(0, 80) + "..." : url;

      let text =
        theme.fg("toolTitle", theme.bold("web_fetch ")) +
        theme.fg("accent", displayUrl) +
        theme.fg("muted", ` [${format}]`);

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as FetchOutput | null;
      if (!details) {
        const firstContent = result.content[0];
        return new Text(
          firstContent?.type === "text" ? firstContent.text : "(no content)",
          0,
          0,
        );
      }

      const lines: string[] = [];

      // Status line (no tool name/URL repeat — renderCall already shows those)
      const typeLabel = details.contentType.split(";")[0].trim();
      let status = theme.fg("muted", `${typeLabel}, ${formatSize(details.outputBytes)}`);
      if (details.format === "markdown" && typeLabel.includes("html")) {
        status += theme.fg("dim", " → markdown");
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
          const display = line.length > 120 ? line.slice(0, 120) + "..." : line;
          lines.push(theme.fg("toolOutput", display));
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}