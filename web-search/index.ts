/**
 * Web Search Tool for Coding Agents
 *
 * Three search providers with different strengths:
 *   1. Tavily  — keyword search + AI summaries (best for exact-match, docs)
 *   2. Exa     — neural/semantic search (best for conceptual discovery)
 *   3. Serper  — Google SERP (broadest coverage, cheapest at scale)
 *
 * Default order: Tavily → Exa → Serper (keyword → semantic → broad)
 * Users can override priority via /web-search-config priority <tavily|exa|serper>
 *
 * API keys can be set two ways:
 *   1. Environment:  TAVILY_API_KEY / EXA_API_KEY / SERPER_API_KEY  (persistent, preferred)
 *   2. Runtime:      /web-search-config <tavily|exa|serper> <key>  (per-session, convenient)
 *
 * Runtime keys are checked first, then env vars.
 * If neither is set, the tool returns a configuration error.
 */

import { Type } from "typebox";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Relevance score (0-1), Tavily & Exa */
  score?: number;
  /** Published date, Exa only */
  publishedDate?: string;
  /** Author, Exa only */
  author?: string;
}

interface SearchOutput {
  query: string;
  results: SearchResult[];
  /** AI-generated answer from Tavily's advanced mode */
  answer?: string;
  source: "tavily" | "exa" | "serper";
}

// ── Constants ──────────────────────────────────────────────────

const TAVILY_URL = "https://api.tavily.com/search";
const EXA_URL = "https://api.exa.ai/search";
const SERPER_URL = "https://google.serper.dev/search";

/** Maximum results per search */
const MAX_RESULTS = 10;

/** Default provider priority order */
const DEFAULT_PRIORITY: ProviderId[] = ["tavily", "exa", "serper"];

type ProviderId = "tavily" | "exa" | "serper";

// ── Search service config ──────────────────────────────────────

/** Runtime API keys (set via /web-search-config, per-session only). */
let runtimeKeys: { tavily?: string; exa?: string; serper?: string } = {};

/** Runtime provider priority override. */
let runtimePriority: ProviderId[] | undefined = undefined;

function getKey(service: ProviderId): string | undefined {
  switch (service) {
    case "tavily":
      return runtimeKeys.tavily || process.env.TAVILY_API_KEY;
    case "exa":
      return runtimeKeys.exa || process.env.EXA_API_KEY;
    case "serper":
      return runtimeKeys.serper || process.env.SERPER_API_KEY;
  }
}

function getPriority(): ProviderId[] {
  return runtimePriority ?? DEFAULT_PRIORITY;
}

// ── Search implementations ─────────────────────────────────────

async function searchTavily(
  query: string,
  maxResults: number,
  searchDepth: "basic" | "advanced",
  includeDomains?: string[],
): Promise<SearchOutput> {
  const apiKey = getKey("tavily");
  if (!apiKey) throw new Error("Tavily not configured. Set TAVILY_API_KEY or /web-search-config");

  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(maxResults, MAX_RESULTS),
    search_depth: searchDepth,
    include_answer: searchDepth === "advanced",
  };
  if (includeDomains?.length) body.include_domains = includeDomains;

  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tavily HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    query,
    answer: data.answer,
    results: (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.content || r.snippet || "",
      score: r.score,
    })),
    source: "tavily",
  };
}

async function searchExa(
  query: string,
  maxResults: number,
  includeDomains?: string[],
  excludeDomains?: string[],
): Promise<SearchOutput> {
  const apiKey = getKey("exa");
  if (!apiKey) throw new Error("Exa not configured. Set EXA_API_KEY or /web-search-config");

  const body: Record<string, unknown> = {
    query,
    numResults: Math.min(maxResults, MAX_RESULTS),
    type: "auto",
    contents: {
      text: true,       // full page text (first 10 free)
      highlights: true, // key sentence excerpts
    },
  };
  if (includeDomains?.length) body.includeDomains = includeDomains;
  if (excludeDomains?.length) body.excludeDomains = excludeDomains;

  const res = await fetch(EXA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Exa HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    query,
    results: (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      snippet:
        r.highlight?.join(" ... ") ||  // Exa highlights
        r.text?.slice(0, 300) ||       // fallback to text excerpt
        "",
      score: r.score,
      publishedDate: r.publishedDate || undefined,
      author: r.author || undefined,
    })),
    source: "exa",
  };
}

async function searchSerper(
  query: string,
  maxResults: number,
): Promise<SearchOutput> {
  const apiKey = getKey("serper");
  if (!apiKey) throw new Error("Serper not configured. Set SERPER_API_KEY or /web-search-config");

  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: Math.min(maxResults, MAX_RESULTS) }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Serper HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const results: SearchResult[] = [];

  for (const r of data.organic || []) {
    results.push({
      title: r.title || "",
      url: r.link || "",
      snippet: r.snippet || "",
    });
  }
  // Include knowledge graph / answer box if present
  if (data.knowledgeGraph?.description) {
    results.push({
      title: data.knowledgeGraph.title || "Knowledge Graph",
      url: data.knowledgeGraph.link || "",
      snippet: data.knowledgeGraph.description,
    });
  }
  if (data.answerBox?.snippet) {
    results.push({
      title: "Answer",
      url: data.answerBox.link || "",
      snippet: data.answerBox.snippet,
    });
  }

  return { query, results, source: "serper" };
}

// ── Multi-provider search with fallback ────────────────────────

const SEARCH_FN: Record<ProviderId, (query: string, maxResults: number, opts: SearchOpts) => Promise<SearchOutput>> = {
  tavily: (q, n, o) => searchTavily(q, n, o.searchDepth ?? "advanced", o.includeDomains),
  exa:    (q, n, o) => searchExa(q, n, o.includeDomains, o.excludeDomains),
  serper: (q, n, _o) => searchSerper(q, n),
};

interface SearchOpts {
  searchDepth?: "basic" | "advanced";
  includeDomains?: string[];
  excludeDomains?: string[];
}

async function searchWithFallback(
  query: string,
  maxResults: number,
  opts: SearchOpts,
): Promise<{ output: SearchOutput | null; lastError: string | null }> {
  const priority = getPriority();
  let lastError: string | null = null;

  for (const provider of priority) {
    if (!getKey(provider)) continue; // skip unconfigured providers

    try {
      const output = await SEARCH_FN[provider](query, maxResults, opts);
      return { output, lastError: null };
    } catch (err: any) {
      lastError = `${provider}: ${err.message}`;
      // Fall through to next provider
    }
  }

  return { output: null, lastError };
}

// ── Format results for the agent ───────────────────────────────

const SOURCE_LABEL: Record<ProviderId, string> = {
  tavily: "Tavily (keyword + AI)",
  exa:    "Exa (semantic/neural)",
  serper: "Serper (Google SERP)",
};

function formatOutput(output: SearchOutput): string {
  const lines: string[] = [];

  lines.push(`Web search results for: "${output.query}"`);
  lines.push(`Source: ${SOURCE_LABEL[output.source]} | ${output.results.length} results`);
  lines.push("");

  if (output.answer) {
    lines.push(output.answer);
    lines.push("");
  }

  for (let i = 0; i < output.results.length; i++) {
    const r = output.results[i];
    const scoreStr = r.score != null ? ` [relevance: ${r.score.toFixed(2)}]` : "";
    const dateStr = r.publishedDate ? ` [${r.publishedDate}]` : "";
    const authorStr = r.author ? ` by ${r.author}` : "";
    lines.push(`${i + 1}. ${r.title}${scoreStr}${dateStr}${authorStr}`);
    lines.push(`   ${r.url}`);
    lines.push(`   ${r.snippet}`);
    if (i < output.results.length - 1) lines.push("");
  }

  return lines.join("\n");
}

// ── Tool schema ────────────────────────────────────────────────

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  max_results: Type.Optional(
    Type.Number({
      description: "Max results (1-10).",
      minimum: 1,
      maximum: MAX_RESULTS,
      default: 5,
    }),
  ),
  search_depth: Type.Optional(
    Type.Union([
      Type.Literal("basic"),
      Type.Literal("advanced"),
    ] as const, {
      description:
        "Search depth. 'basic' is fast (snippets only). 'advanced' fetches full page content and returns an AI summary. Tavily only; Exa and Serper always return full snippets.",
      default: "advanced",
    }),
  ),
  include_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Limit to these domains. Useful for official docs, e.g. ['docs.python.org', 'github.com'].",
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude these domains. Only supported by Exa; ignored by Tavily and Serper.",
    }),
  ),
});

// ── Extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: [
      "Search the web for coding-related information: docs, GitHub issues,",
      "StackOverflow answers, blog posts, and more.",
      "Uses Tavily (keyword+AI) → Exa (semantic) → Serper (Google SERP) with automatic fallback.",
    ].join(" "),
    parameters: SearchParams,

    async execute(_toolCallId, params, _signal) {
      const query = params.query;
      const maxResults = params.max_results ?? 5;
      const searchDepth = params.search_depth ?? "advanced";
      const includeDomains = params.include_domains;
      const excludeDomains = params.exclude_domains;

      const { output, lastError } = await searchWithFallback(
        query,
        maxResults,
        { searchDepth, includeDomains, excludeDomains },
      );

      if (output) {
        return {
          content: [{ type: "text" as const, text: formatOutput(output) }],
          details: output,
        };
      }

      // No provider succeeded — check if any keys exist at all
      const hasAnyKey = getPriority().some(p => getKey(p));
      if (!hasAnyKey) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Web search is not configured.\n\n" +
                "Set at least one of these environment variables:\n" +
                "  TAVILY_API_KEY  — https://tavily.com  (1,000/mo free, keyword + AI summaries)\n" +
                "  EXA_API_KEY     — https://exa.ai     (1,000/mo free, semantic/neural search)\n" +
                "  SERPER_API_KEY  — https://serper.dev  (2,500 free total, Google SERP)",
            },
          ],
          details: null,
        };
      }

      // All configured providers failed
      return {
        content: [
          {
            type: "text" as const,
            text: `All web search providers failed. Last error: ${lastError}`,
          },
        ],
        details: null,
      };
    },

    renderCall(args, theme) {
      const query = args.query as string;
      const domains = args.include_domains as string[] | undefined;
      const excludeDomains = args.exclude_domains as string[] | undefined;
      const depth = (args.search_depth as string) ?? "advanced";
      const maxResults = (args.max_results as number) ?? 5;

      let text =
        theme.fg("toolTitle", theme.bold("web_search ")) +
        theme.fg("accent", query.length > 60
          ? query.slice(0, 60) + "..."
          : query) +
        theme.fg("muted", ` [${depth}, ${maxResults} results]`);

      if (domains?.length) {
        text +=
          "\n  " +
          theme.fg("dim", `domains: ${domains.join(", ")}`);
      }
      if (excludeDomains?.length) {
        text +=
          "\n  " +
          theme.fg("dim", `exclude: ${excludeDomains.join(", ")}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as SearchOutput | null;
      if (!details) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no results)",
          0,
          0,
        );
      }

      const lines: string[] = [];

      // Header
      lines.push(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("accent", details.query) +
          theme.fg("muted", `  (${SOURCE_LABEL[details.source]}, ${details.results.length} results)`),
      );

      // AI answer (Tavily advanced mode)
      if (details.answer) {
        lines.push("");
        lines.push(theme.fg("success", details.answer));
      }

      // Results
      const show = details.results.slice(0, 5);
      for (let i = 0; i < show.length; i++) {
        const r = show[i];
        const scoreStr =
          r.score != null ? ` ${theme.fg("dim", `[${r.score.toFixed(2)}]`)}` : "";
        const dateStr = r.publishedDate ? ` ${theme.fg("dim", `[${r.publishedDate}]`)}` : "";
        const authorStr = r.author ? ` ${theme.fg("dim", `by ${r.author}`)}` : "";
        lines.push("");
        lines.push(
          `${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", r.title)}${scoreStr}${dateStr}${authorStr}`,
        );
        lines.push("  " + theme.fg("dim", r.url));
        const snippet =
          r.snippet.length > 180
            ? r.snippet.slice(0, 180) + "..."
            : r.snippet;
        lines.push("  " + theme.fg("toolOutput", snippet));
      }

      if (details.results.length > 5) {
        lines.push(
          "",
          theme.fg("muted", `  +${details.results.length - 5} more results`),
        );
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── Runtime config command ──────────────────────────────────

  pi.registerCommand("web-search-config", {
    description:
      "Set web search API keys or priority at runtime.\n" +
      "Usage:\n" +
      "  /web-search-config <tavily|exa|serper> <key>\n" +
      "  /web-search-config priority <tavily|exa|serper>  (sets order, comma-separated)",
    handler: async (args, ctx) => {
      const input = (args as string) || "";

      // Show current config
      if (!input.includes(" ")) {
        const tKey = getKey("tavily");
        const eKey = getKey("exa");
        const sKey = getKey("serper");
        const mask = (k: string) => `✓ ${k.slice(0, 8)}...${k.slice(-4)}`;
        const priority = getPriority();
        ctx.ui.notify(
          `Web search config:\n` +
          `  Tavily:  ${tKey ? mask(tKey) : "✗ not set"}\n` +
          `  Exa:     ${eKey ? mask(eKey) : "✗ not set"}\n` +
          `  Serper:  ${sKey ? mask(sKey) : "✗ not set"}\n` +
          `  Priority: ${priority.join(" → ")}\n\n` +
          `Usage:\n` +
          `  /web-search-config <tavily|exa|serper> <key>\n` +
          `  /web-search-config priority <tavily,exa,serper>`,
          "info",
        );
        return;
      }

      const parts = input.split(" ");
      const target = parts[0].toLowerCase();

      // Priority override
      if (target === "priority") {
        const order = parts[1].split(",").map(s => s.trim().toLowerCase()) as ProviderId[];
        const validProviders: ProviderId[] = ["tavily", "exa", "serper"];
        const invalid = order.filter(p => !validProviders.includes(p));
        if (invalid.length) {
          ctx.ui.notify(`Invalid providers: ${invalid.join(", ")}. Valid: tavily, exa, serper`, "error");
          return;
        }
        runtimePriority = order;
        ctx.ui.notify(`Search priority set: ${order.join(" → ")}`, "info");
        return;
      }

      // API key config
      const key = parts.slice(1).join(" ");
      if (!validProviders().includes(target)) {
        ctx.ui.notify("Unknown service. Use 'tavily', 'exa', or 'serper'.", "error");
        return;
      }

      if (target === "tavily") runtimeKeys.tavily = key;
      else if (target === "exa") runtimeKeys.exa = key;
      else runtimeKeys.serper = key;

      const masked = `${key.slice(0, 8)}...${key.slice(-4)}`;
      ctx.ui.notify(
        `${target} key set: ${masked} (valid for this session)`,
        "info",
      );
    },
  });
}

function validProviders(): string[] {
  return ["tavily", "exa", "serper"];
}