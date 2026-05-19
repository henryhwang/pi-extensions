/**
 * Requests tracker — shows LLM API request count per model for monitoring.
 *
 * Save to ~/.pi/agent/extensions/requests.ts and /reload.
 *
 * Each assistant message = one API call to the LLM provider.
 * Use this to track against provider rate limits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("requests", {
    description: "Show LLM API request count and per-model breakdown for the current session branch",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const byModel = new Map<string, {
        count: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
      }>();
      let assistantTotal = 0;
      let userTotal = 0;
      let toolTotal = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalTokens = 0;

      for (const entry of branch) {
        if (entry.type === "message") {
          const msg = (entry as any).message;
          if (!msg) continue;
          if (msg.role === "assistant") {
            assistantTotal++;
            const usage = msg.usage;
            const inp = usage?.input ?? 0;
            const out = usage?.output ?? 0;
            const cr = usage?.cacheRead ?? 0;
            const cw = usage?.cacheWrite ?? 0;
            const tok = usage?.totalTokens ?? 0;
            totalInput += inp;
            totalOutput += out;
            totalCacheRead += cr;
            totalCacheWrite += cw;
            totalTokens += tok;
            if (msg.model) {
              const key = `${msg.provider ?? "unknown"}/${msg.model}`;
              const cur = byModel.get(key) ?? { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
              byModel.set(key, {
                count: cur.count + 1,
                input: cur.input + inp,
                output: cur.output + out,
                cacheRead: cur.cacheRead + cr,
                cacheWrite: cur.cacheWrite + cw,
                totalTokens: cur.totalTokens + tok,
              });
            }
          } else if (msg.role === "user") {
            userTotal++;
          } else if (msg.role === "toolResult") {
            toolTotal++;
          }
        }
      }

      const lines: string[] = [];
      lines.push(`Messages: ${userTotal} user, ${assistantTotal} assistant, ${toolTotal} tool results`);
      lines.push("");

      if (assistantTotal === 0) {
        lines.push("No assistant messages yet.");
      } else {
        lines.push("## Requests");
        lines.push(`Total: ${assistantTotal}`);
        for (const [model, m] of byModel.entries()) {
          lines.push(`  ${model}: ${m.count}`);
        }
        lines.push("");
        lines.push("## Tokens");
        lines.push(`Total: ${formatK(totalTokens)} (in: ${formatK(totalInput)} / out: ${formatK(totalOutput)} / cache\u00A0read: ${formatK(totalCacheRead)} / cache\u00A0write: ${formatK(totalCacheWrite)})`);
        lines.push("");
        for (const [model, m] of byModel.entries()) {
          lines.push(`  ${model}: ${formatK(m.totalTokens)} (in: ${formatK(m.input)} / out: ${formatK(m.output)} / cache\u00A0read: ${formatK(m.cacheRead)} / cache\u00A0write: ${formatK(m.cacheWrite)})`);
        }
        lines.push("");
        lines.push("Each assistant message = 1 API call to the LLM provider.");
        lines.push("Tool calls can exceed assistant count due to parallel execution.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
