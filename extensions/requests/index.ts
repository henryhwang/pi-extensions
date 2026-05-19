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

interface ModelStats {
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

const ZERO: ModelStats = { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

export default function(pi: ExtensionAPI) {
  pi.registerCommand("requests", {
    description: "Show LLM API request count and per-model breakdown for the current session branch",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const byModel = new Map<string, ModelStats>();
      let assistantTotal = 0;
      let userTotal = 0;
      let toolTotal = 0;

      for (const entry of branch) {
        if (entry.type === "message") {
          const msg = (entry as any).message;
          if (!msg) continue;
          if (msg.role === "assistant") {
            assistantTotal++;
            const usage = msg.usage;
            if (msg.model) {
              const key = `${msg.provider ?? "unknown"}/${msg.model}`;
              const cur = byModel.get(key) ?? { ...ZERO };
              cur.count++;
              const inp = usage?.input ?? 0;
              const out = usage?.output ?? 0;
              const cr = usage?.cacheRead ?? 0;
              const cw = usage?.cacheWrite ?? 0;
              cur.input += inp;
              cur.output += out;
              cur.cacheRead += cr;
              cur.cacheWrite += cw;
              cur.totalTokens += usage?.totalTokens ?? 0;
              byModel.set(key, cur);
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
        const models = Array.from(byModel.entries());
        for (const [model, m] of models) {
          lines.push(`  ${model}: ${m.count}`);
        }
        lines.push("");

        const totals = models.reduce((acc, [, m]) => ({
          input: acc.input + m.input,
          output: acc.output + m.output,
          cacheRead: acc.cacheRead + m.cacheRead,
          cacheWrite: acc.cacheWrite + m.cacheWrite,
          totalTokens: acc.totalTokens + m.totalTokens,
          count: 0,
        }), { ...ZERO });

        lines.push("## Tokens");
        lines.push(`Total: ${formatK(totals.totalTokens)} (in: ${formatK(totals.input)} / out: ${formatK(totals.output)} / cache\u00A0read: ${formatK(totals.cacheRead)} / cache\u00A0write: ${formatK(totals.cacheWrite)})`);
        lines.push("");
        for (const [model, m] of models) {
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
