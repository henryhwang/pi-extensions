/**
 * Requests tracker — shows LLM API request count per model for monitoring.
 *
 * Save to ~/.pi/agent/extensions/requests.ts and /reload.
 *
 * Each assistant message = one API call to the LLM provider.
 * Use this to track against provider rate limits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("requests", {
    description: "Show LLM API request count and per-model breakdown for the current session branch",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const byModel = new Map<string, number>();
      let assistantTotal = 0;
      let userTotal = 0;
      let toolTotal = 0;

      for (const entry of branch) {
        if (entry.type === "message") {
          const msg = (entry as any).message;
          if (!msg) continue;
          if (msg.role === "assistant") {
            assistantTotal++;
            if (msg.model) {
              const key = `${msg.provider ?? "unknown"}/${msg.model}`;
              byModel.set(key, (byModel.get(key) ?? 0) + 1);
            }
          } else if (msg.role === "user") {
            userTotal++;
          } else if (msg.role === "toolResult") {
            toolTotal++;
          }
        }
      }

      const lines: string[] = [];
      lines.push(`Total LLM requests: ${assistantTotal}`);
      lines.push(`Messages: ${userTotal} user, ${assistantTotal} assistant, ${toolTotal} tool results`);
      lines.push("");

      if (assistantTotal === 0) {
        lines.push("  (no assistant messages yet)");
      } else {
        // Note: tool calls > assistant because pi runs parallel tools in a single turn
        for (const [model, count] of byModel.entries()) {
          const bar = "█".repeat(Math.min(count, 40));
          lines.push(`  ${bar} ${model}: ${count}`);
        }
        lines.push("");
        lines.push("  Each assistant message = 1 API call to the LLM provider.");
        lines.push("  Tool calls can exceed assistant count due to parallel execution.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
