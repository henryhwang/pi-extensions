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
 * - Streaming fetch with hard 5MB raw response limit
 * - SSRF protection (blocks localhost, private/link-local IPs, non-HTTP protocols)
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

import { Type, StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import TurndownService from "turndown";
import { parseHTML } from "linkedom";

// ── Types ──────────────────────────────────────────────────────
interface FetchOutput {
	url: string;
	contentType: string;
	content: string;
	truncated: boolean;
	totalBytes: number;    // processed content bytes
	outputBytes: number;
	format: "markdown" | "text";
	readerMode: boolean;
	tempFile?: string;
}

// ── Constants ──────────────────────────────────────────────────
const MAX_FETCH_SIZE = 5 * 1024 * 1024;

// ── Helpers ────────────────────────────────────────────────────

// ── HTTP with timeout ──────────────────────────────────────────

async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs: number = 20000
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

function cleanUrl(url: string): string {
	return url
		.trim()
		.replace(/^[@\s"'`<>]+|[\s"'`<>]+$/g, "");
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
		if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|fd[0-9a-f]{2}:|fe80:)/.test(host)) {
			return { safe: false, error: "Private network addresses are blocked (SSRF protection)" };
		}
		return { safe: true };
	} catch {
		return { safe: false, error: "Invalid URL format" };
	}
}

function redactError(text: string): string {
	return text.slice(0, 200).replace(/\b[A-Za-z0-9_\-]{20,}\b/g, "[REDACTED]");
}

function getCharset(contentType: string): string | undefined {
	const m = contentType.match(/charset=([^;]+)/i);
	if (!m) return undefined;
	return m[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
}

// ── Content Processing ─────────────────────────────────────────
const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

function cleanHtml(html: string): Document {
	const { document } = parseHTML(html);
	for (const el of document.querySelectorAll("script, style, nav, footer, header, aside, noscript")) {
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

	const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'TR', 'BLOCKQUOTE', 'PRE']);
	if (blockTags.has(tag)) {
		text = "\n" + text.trim() + "\n";
	} else if (tag === "BR") {
		text += "\n";
	}

	return text;
}

/** Optional high-quality extraction using Readability */
async function processHtml(
	html: string,
	format: "markdown" | "text",
	readerMode: boolean = false
): Promise<string> {
	const document = cleanHtml(html);

	let targetDoc = document;

	if (readerMode) {
		try {
			const { Readability } = await import("@mozilla/readability");
			const reader = new Readability(document);
			const article = reader.parse();

			if (article?.content) {
				const { document: cleanDoc } = parseHTML(article.content);
				// Strip noise from Readability output (scripts, styles, noscript)
				for (const el of cleanDoc.querySelectorAll("script, style, noscript")) {
					el.remove();
				}
				targetDoc = cleanDoc;
			}
		} catch (err) {
			console.warn("[web_fetch] Readability failed, falling back to raw DOM", err);
		}
	}

	try {
		if (format === "markdown") {
			return turndownService.turndown(targetDoc.body || targetDoc.documentElement);
		} else {
			const rawText = extractTextFromDOM(targetDoc.body || targetDoc.documentElement);
			return rawText
				.replace(/\n{3,}/g, "\n\n")
				.replace(/[ \t]+/g, " ")
				.trim();
		}
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
	signal?: AbortSignal
): Promise<FetchOutput> {
	const normalizedUrl = cleanUrl(url);

	const safety = isSafeUrl(normalizedUrl);
	if (!safety.safe) {
		throw new Error(`URL rejected: ${safety.error}`);
	}

	const res = await fetchWithTimeout(normalizedUrl, {
		signal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; PiWebFetch/1.0)",
			"Accept": "text/html,application/xhtml+xml,text/plain,application/json,*/*",
		},
	}, 20000);

	// Defense-in-depth: verify the final URL after redirects
	const finalSafety = isSafeUrl(res.url);
	if (!finalSafety.safe) {
		throw new Error(`Redirected to blocked URL: ${finalSafety.error}`);
	}

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`HTTP ${res.status}: ${redactError(errText)}`);
	}

	const contentType = res.headers.get("content-type") || "text/plain";

	if (isBinaryContent(contentType)) {
		throw new Error(`Binary content detected (${contentType}). This tool only supports text/HTML/JSON.`);
	}

	// Streaming read with size limit
	const reader = res.body?.getReader();
	if (!reader) throw new Error("Response body is not readable");

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
					await reader.cancel().catch(() => { });
					throw new Error(`Response too large (exceeded ${formatSize(MAX_FETCH_SIZE)})`);
				}
				bodyText += decoder.decode(value, { stream: true });
			}
		}
		// Flush any remaining bytes from the decoder
		bodyText += decoder.decode();
	} finally {
		reader.releaseLock();
	}

	// Process content
	let content: string;
	if (contentType.includes("application/json")) {
		content = bodyText;
	} else if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
		content = await processHtml(bodyText, format, readerMode);
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
		} catch (fsError) {
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
		})
	),
	readerMode: Type.Optional(
		Type.Boolean({
			description: "Use @mozilla/readability to extract main article content (removes boilerplate). Defaults to false.",
			default: false,
		})
	),
});

// ── Extension ──────────────────────────────────────────────────
export default function(pi: ExtensionAPI) {
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
					signal
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

		// ... keep your existing renderCall and renderResult ...
		renderCall(args, theme) {
			const url = args.url;
			const format = args.format ?? "markdown";
			const reader = args.readerMode ? " [reader]" : "";
			const displayUrl = url.length > 80 ? url.slice(0, 80) + "..." : url;
			const text = theme.fg("toolTitle", theme.bold("web_fetch ")) +
				theme.fg("accent", displayUrl) +
				theme.fg("muted", ` [${format}]${reader}`);
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

	// Cleanup temp files
	pi.on("session_shutdown", async () => {
		for (const file of tempFiles) {
			try {
				await unlink(file).catch(() => { });
				await rmdir(dirname(file)).catch(() => { });
			} catch (_) { }
		}
		tempFiles.clear();
	});
}
