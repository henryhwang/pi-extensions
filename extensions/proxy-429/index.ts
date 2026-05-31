/**
 * 429 Error Rewrite Proxy — Pi Extension
 *
 * Spawns a separate Node.js child process that runs an HTTP → HTTPS
 * reverse proxy. The proxy intercepts 429 rate-limit JSON responses
 * and rewrites error messages so pi's retry logic makes correct
 * decisions:
 *
 *   "billing details" → "usage details"
 *     → pi sees this as a retryable 429 → exponential backoff kicks in
 *
 *   "exceeded today's quota... try again tomorrow"
 *     → adds "billing-related" keyword → pi blocks pointless retries
 *
 * The proxy child process starts automatically when pi's session
 * starts and stops on quit. A footer status indicator shows the proxy
 * state and 429 rewrite count.
 *
 * Running as a separate process provides:
 *   - Process isolation: proxy crashes don't affect pi
 *   - Own event loop: no resource contention with pi
 *   - Visibility: can be inspected via `ps`, `ss`, `lsof` etc.
 */

import { type ChildProcess, fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Configuration ───────────────────────────────────────────────

// Resolve real path (follows symlinks) so fork() finds proxy-server.ts
// regardless of how the extension was discovered (.pi/extensions symlink vs direct)
const EXT_DIR = realpathSync(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_TARGET = "https://api-inference.modelscope.cn";
const DEFAULT_PORT = 11435;

// ── Stats (mirrored from child via IPC) ─────────────────────────

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

// ── Pi Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let child: ChildProcess | null = null;
  let running = false;
  // Priority: flag > env > default
  let proxyPort = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  let target = process.env.TARGET_URL || DEFAULT_TARGET;

  pi.registerFlag("proxy-port", {
    description: "Override proxy listen port (default: 11435)",
    type: "string",
    default: String(proxyPort),
  });

  pi.registerFlag("proxy-target", {
    description: "Override upstream target URL",
    type: "string",
    default: target,
  });

  function updateStatus(ctx: ExtensionContext) {
    if (!running) {
      ctx.ui.setStatus("proxy-429", "");
      return;
    }

    const parts: string[] = [`localhost:${proxyPort}`];
    if (stats.rewrites > 0) {
      parts.push(`${stats.rewrites} rewrite${stats.rewrites !== 1 ? "s" : ""}`);
    }
    if (stats.upstreamErrors > 0) {
      parts.push(`${stats.upstreamErrors} err`);
    }
    ctx.ui.setStatus("proxy-429", ctx.ui.theme.fg("accent", parts.join(" │ ")));
  }

  // ── Spawn proxy child process on session start ────────────

  pi.on("session_start", async (_event, ctx) => {
    if (running) {
      updateStatus(ctx);
      ctx.ui.notify(`429 proxy already running on port ${proxyPort}`, "info");
      return;
    }

    // Flags override env (flag default already resolves env)
    const flagPort = pi.getFlag("proxy-port");
    if (typeof flagPort === "string") {
      const parsed = parseInt(flagPort, 10);
      if (parsed > 0) proxyPort = parsed;
    }

    const flagTarget = pi.getFlag("proxy-target");
    if (typeof flagTarget === "string") target = flagTarget;

    const serverPath = join(EXT_DIR, "proxy-server.ts");

    child = fork(serverPath, [], {
      env: {
        ...process.env,
        TARGET_URL: target,
        PORT: String(proxyPort),
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    child.on("message", (msg: any) => {
      switch (msg.type) {
        case "started":
          running = true;
          updateStatus(ctx);
          ctx.ui.notify(
            `429 proxy started → http://localhost:${proxyPort}\nTarget: ${target}`,
            "info",
          );
          break;

        case "rewrite":
          stats.rewrites++;
          stats.lastRewriteAt = Date.now();
          stats.lastRewriteFrom = msg.from;
          stats.lastRewriteTo = msg.to;
          updateStatus(ctx);
          break;

        case "passthrough":
          stats.passThroughs++;
          break;

        case "error":
          stats.upstreamErrors++;
          updateStatus(ctx);
          break;

        case "stats":
          // Full stats update from child (used by /proxy-status)
          Object.assign(stats, msg.data);
          break;

        case "shutdown_complete":
          running = false;
          child = null;
          updateStatus(ctx);
          break;
      }
    });

    child.on("exit", (code, signal) => {
      if (running) {
        console.error(`[429-fix] Proxy child exited unexpectedly (code=${code}, signal=${signal})`);
        running = false;
        child = null;
        ctx.ui.notify(`429 proxy exited unexpectedly (code=${code}, signal=${signal})`, "error");
        updateStatus(ctx);
      }
    });

    child.on("error", (err) => {
      console.error(`[429-fix] Failed to spawn proxy child: ${err.message}`);
      ctx.ui.notify(`429 proxy failed to start: ${err.message}`, "error");
    });
  });

  // ── Stop proxy on shutdown (quit, reload, new, resume, fork) ────

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!running || !child) return;
    console.log("[429-fix] Requesting proxy shutdown...");
    child.send({ type: "shutdown" });

    // Give the child process a grace period to shut down
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[429-fix] Proxy did not shut down gracefully — killing");
        child?.kill("SIGKILL");
        running = false;
        child = null;
        resolve();
      }, 5000);

      child!.on("exit", () => {
        clearTimeout(timeout);
        running = false;
        child = null;
        resolve();
      });
    });
  });

  // ── /proxy-status command ──────────────────────────────────

  pi.registerCommand("proxy-status", {
    description: "Show 429 proxy state and rewrite stats",
    handler: async (_args, ctx) => {
      // Request fresh stats from child
      if (child && running) {
        child.send({ type: "get_stats" });
        // Give a small window for the IPC response
        await new Promise((r) => setTimeout(r, 100));
      }

      const lines: string[] = [];
      lines.push(`State:    ${running ? "running" : "stopped"}`);
      lines.push(`Target:   ${target}`);
      lines.push(`Port:     ${proxyPort}`);
      lines.push(`Rewrites: ${stats.rewrites}`);
      lines.push(`Pass-thru: ${stats.passThroughs}`);
      lines.push(`Errors:   ${stats.upstreamErrors}`);

      if (stats.lastRewriteAt) {
        const ago = Math.round((Date.now() - stats.lastRewriteAt) / 1000);
        lines.push(`Last rewrite: ${ago}s ago`);
        lines.push(`  FROM: ${stats.lastRewriteFrom}`);
        lines.push(`  TO:   ${stats.lastRewriteTo}`);
      }

      if (child && running) {
        lines.push(`PID:      ${child.pid}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
