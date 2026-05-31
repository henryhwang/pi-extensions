/**
 * 429 Error Rewrite Proxy — Child Process
 *
 * Runs as a standalone HTTP → HTTPS reverse proxy spawned by the Pi extension.
 * Communicates stats back to the parent via IPC messages.
 *
 * IPC protocol (child → parent):
 *   { type: "started",  port: number }
 *   { type: "rewrite",  from: string, to: string }
 *   { type: "passthrough" }
 *   { type: "error",    source: string, message: string }
 *
 * IPC protocol (parent → child):
 *   { type: "get_stats" }
 *   → responds with: { type: "stats", data: ProxyStats }
 *   { type: "shutdown" }
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

// ── Configuration ───────────────────────────────────────────────

// Priority: flag > env > default
const DEFAULT_TARGET = "https://api-inference.modelscope.cn";
const DEFAULT_PORT = 11435;

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) flags.port = argv[++i];
    else if (argv[i] === "--target" && argv[i + 1]) flags.target = argv[++i];
  }
  return flags;
}

const flags = parseArgs(process.argv);
const TARGET = flags.target || process.env.TARGET_URL || DEFAULT_TARGET;
const PORT = parseInt(flags.port || process.env.PORT || String(DEFAULT_PORT), 10);

// ── Rewrite rules ──────────────────────────────────────────────

interface RewriteRule {
  match: RegExp;
  replace: string | ((msg: string) => string);
}

const REWRITE_RULES: RewriteRule[] = [
  // Rule 1: remove "billing" → pi sees retryable 429, applies backoff
  { match: /billing details/i, replace: "usage details" },
  { match: /check your plan and billing/i, replace: "check your plan and usage" },

  // Rule 2: add "billing" → pi gives up on daily quota exhaustion
  {
    match: /exceeded today'?s quota.*try again tomorrow/i,
    replace: (msg: string) => `${msg}. This is a billing-related daily quota exhaustion.`,
  },
];

// ── Helpers ────────────────────────────────────────────────────

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type HeadersLike = Record<string, string | string[] | undefined>;

function filterHeaders(hdrs: HeadersLike): HeadersLike {
  const out: HeadersLike = {};
  for (const [k, v] of Object.entries(hdrs)) {
    if (v !== undefined && !HOP_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    }
  }
  return out;
}

function requestForProtocol(protocol: string) {
  return protocol === "https:" ? httpsRequest : httpRequest;
}

function isCompressed(ce?: string | string[]): boolean {
  if (!ce) return false;
  const v = Array.isArray(ce) ? ce.join(", ") : ce;
  return !/^\s*identity\s*$/i.test(v);
}

// ── Stats ───────────────────────────────────────────────────────

interface ProxyStats {
  rewrites: number;
  passThroughs: number;
  upstreamErrors: number;
  lastRewriteAt?: number;
  lastRewriteFrom?: string;
  lastRewriteTo?: string;
}

const stats: ProxyStats = {
  rewrites: 0,
  passThroughs: 0,
  upstreamErrors: 0,
};

function sendToParent(msg: object) {
  if (process.send) {
    process.send(msg);
  }
}

// ── Proxy server ────────────────────────────────────────────────

const target = new URL(TARGET);
const isHttps = target.protocol === "https:";
const proto = requestForProtocol(target.protocol);

function startProxy(port: number) {
  const server = createServer((clientReq, clientRes) => {
    const upstreamOpts = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...filterHeaders(clientReq.headers as HeadersLike),
        host: target.hostname,
      },
    };

    const proxyReq = proto(upstreamOpts, (proxyRes) => {
      const status = proxyRes.statusCode || 502;
      const ct = (proxyRes.headers["content-type"] || "") as string;
      const ce = proxyRes.headers["content-encoding"];

      proxyRes.on("error", (err) => {
        console.error(`[429-fix] Upstream response error: ${err.message}`);
        stats.upstreamErrors++;
        sendToParent({ type: "error", source: "upstream_response", message: err.message });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
          clientRes.end(JSON.stringify({ error: { message: err.message } }));
        } else {
          clientRes.destroy();
        }
      });

      // 429 + JSON + uncompressed → try rewrite
      if (status === 429 && ct.includes("application/json") && !isCompressed(ce)) {
        const chunks: Buffer[] = [];

        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let body: any;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            passThrough();
            return;
          }

          if (body?.error?.message) {
            let msg: string = body.error.message;
            let rewritten = false;

            for (const rule of REWRITE_RULES) {
              if (rule.match.test(msg)) {
                const newMsg =
                  typeof rule.replace === "function"
                    ? rule.replace(msg)
                    : msg.replace(rule.match, rule.replace);

                if (newMsg !== msg) {
                  console.log(`\n[429-fix] Rewrote:`);
                  console.log(`  FROM: ${msg.slice(0, 120)}`);
                  console.log(`  TO:   ${newMsg.slice(0, 120)}`);
                  stats.rewrites++;
                  stats.lastRewriteAt = Date.now();
                  stats.lastRewriteFrom = msg.slice(0, 80);
                  stats.lastRewriteTo = newMsg.slice(0, 80);
                  sendToParent({
                    type: "rewrite",
                    from: msg.slice(0, 80),
                    to: newMsg.slice(0, 80),
                  });
                  msg = newMsg;
                  rewritten = true;
                }
                break;
              }
            }

            if (rewritten) {
              body = { ...body, error: { ...body.error, message: msg } };
              const encoded = JSON.stringify(body);
              const respHeaders = filterHeaders(proxyRes.headers);
              respHeaders["content-length"] = String(Buffer.byteLength(encoded));
              delete respHeaders["content-encoding"];
              clientRes.writeHead(429, respHeaders);
              clientRes.end(encoded);
              return;
            }
          }

          passThrough();

          function passThrough() {
            stats.passThroughs++;
            sendToParent({ type: "passthrough" });
            clientRes.writeHead(status, filterHeaders(proxyRes.headers));
            for (const c of chunks) clientRes.write(c);
            clientRes.end();
          }
        });
        return;
      }

      // Everything else: pass through (incl. streaming/SSE)
      stats.passThroughs++;
      sendToParent({ type: "passthrough" });
      clientRes.writeHead(status, filterHeaders(proxyRes.headers));
      proxyRes.pipe(clientRes);

      clientRes.on("error", (err) => {
        console.error(`[429-fix] Client response error: ${err.message}`);
        proxyRes.destroy();
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[429-fix] Upstream request error: ${err.message}`);
      stats.upstreamErrors++;
      sendToParent({ type: "error", source: "upstream_request", message: err.message });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: { message: err.message } }));
      }
    });

    clientReq.on("error", (err) => {
      console.error(`[429-fix] Client request error: ${err.message}`);
      proxyReq.destroy();
    });

    clientReq.pipe(proxyReq);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[429-fix] Port ${port} already in use — assuming existing proxy`);
      sendToParent({ type: "started", port });
    } else {
      console.error(`[429-fix] Server error: ${err.message}`);
      sendToParent({ type: "error", source: "server", message: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`[429-fix] Proxying ${TARGET} → http://localhost:${port}`);
    sendToParent({ type: "started", port });
  });

  return server;
}

// ── Handle IPC from parent ────────────────────────────────────

process.on("message", (msg: any) => {
  if (msg.type === "get_stats") {
    sendToParent({ type: "stats", data: stats });
  } else if (msg.type === "shutdown") {
    console.log("[429-fix] Shutdown requested — closing proxy...");
    server.close(() => {
      sendToParent({ type: "shutdown_complete" });
      process.exit(0);
    });
  }
});

// ── Auto-start when run directly ──────────────────────────────

const server = startProxy(PORT);
