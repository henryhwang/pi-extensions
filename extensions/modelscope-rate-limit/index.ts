import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Track quota in status bar for ModelScope providers
  pi.on("after_provider_response", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    const providerName = (model?.provider || "").toLowerCase();
    if (!providerName.startsWith("modelscope")) return;

    const headers = event.headers;
    const limit = headers["modelscope-ratelimit-model-requests-limit"];
    const remaining = headers["modelscope-ratelimit-model-requests-remaining"];

    // Parse remaining as number
    const remainingNum = remaining ? Number(remaining) : NaN;

    if (ctx.hasUI) {
      if (!Number.isNaN(remainingNum) && remainingNum <= 5) {
        // Prominent warning in status bar + popup notification
        ctx.ui.setStatus("modelscope-quota", `[⚠️ LOW: ${remainingNum}/${limit}]`);
        ctx.ui.notify(`ModelScope quota low: ${remainingNum} requests remaining!`, "warning");
      } else if (remaining !== undefined || limit !== undefined) {
        // Normal status with remaining/limit
        ctx.ui.setStatus("modelscope-quota", `quota: ${remaining ?? "?"}/${limit ?? "?"}`);
      } else {
        // No quota header available - clear status
        ctx.ui.setStatus("modelscope-quota", undefined);
      }
    }
  });
}
