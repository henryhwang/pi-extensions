/**
 * Model Rotation & 429 Guard Extension
 *
 * Rotates through a pool of models. Off by default.
 * Toggle on/off with /rotate-on, /rotate-off, /rotate-toggle.
 * Only rotates when the current model is already in the pool.
 *
 * 429 Guard: when a provider returns HTTP 429 (rate limited),
 * marks it as rate-limited and tries to rotate to a clean model.
 * If all models are rate-limited, waits for the shortest cooldown
 * to expire instead of wasting retries. Toggle with /rotate-429-toggle.
 *
 * Two types of 429 are recognized:
 *   - RPM (temporary): wait ~1 minute
 *   - Quota (daily exhausted): wait 1 hour (effectively rest of day)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── Configure your model pool here ──────────────────────────────
const MODEL_POOL: Array<{ provider: string; id: string }> = [
  { provider: "modelscope", id: "deepseek-ai/DeepSeek-V4-Pro" },
  { provider: "modelscope-xiaoxu", id: "deepseek-ai/DeepSeek-V4-Pro" },
  // Add more models here...
];

// ── 429 classification ────────────────────────────────────────
// DeepSeek (and most providers) return two kinds of 429:
//   1. RPM/TPM rate limit  → temporary, wait ~1 minute
//   2. Daily quota/billing → wait until next day (hours)

type RateLimitType = "rpm" | "quota";

/** Cooldown durations per 429 type */
const COOLDOWNS: Record<RateLimitType, number> = {
  rpm: 60_000, // 1 minute — RPM limits reset quickly
  quota: 3_600_000, // 1 hour — daily quota won't reset sooner
};

function classify429(errorMessage: string): RateLimitType {
  const lower = errorMessage.toLowerCase();
  // Daily quota / billing keywords from DeepSeek/Aliyun error messages
  if (/quota|exceeded your current|billing|daily|insufficient.?balance|token.?limit/i.test(lower)) {
    return "quota";
  }
  // Everything else is RPM (rate limit, too many requests, etc.)
  return "rpm";
}

/** Maximum total time to wait in turn_start before giving up */
const MAX_WAIT_MS = 120_000;
// ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let rotateOn429 = true;
  let currentIndex = 0;

  /** Track when each pool entry's cooldown expires */
  const rateLimitedUntil = new Map<number, number>();
  /** Track the type of rate limit (rpm vs quota) for display */
  const rateLimitType = new Map<number, RateLimitType>();

  function isInPool(provider: string, id: string): boolean {
    return MODEL_POOL.some((m) => m.provider === provider && m.id === id);
  }

  function isRateLimited(index: number): boolean {
    const until = rateLimitedUntil.get(index);
    return until !== undefined && Date.now() < until;
  }

  function getRateLimitLabel(index: number): string {
    const type = rateLimitType.get(index);
    if (type === "quota") return "quota";
    if (type === "rpm") return "rpm";
    return "limited";
  }

  function markRateLimited(provider: string, id: string, type: RateLimitType) {
    const idx = MODEL_POOL.findIndex((m) => m.provider === provider && m.id === id);
    if (idx >= 0) {
      const existingUntil = rateLimitedUntil.get(idx);
      const newUntil = Date.now() + COOLDOWNS[type];
      // Always extend cooldown (don't shorten an existing longer cooldown)
      if (existingUntil === undefined || newUntil > existingUntil) {
        rateLimitedUntil.set(idx, newUntil);
        rateLimitType.set(idx, type);
      }
    }
  }

  function clearExpiredCooldowns() {
    const now = Date.now();
    for (const [idx, until] of rateLimitedUntil) {
      if (now >= until) {
        rateLimitedUntil.delete(idx);
        rateLimitType.delete(idx);
      }
    }
  }

  /** Returns ms until the soonest cooldown expires, or 0 if none are active */
  function getMinCooldownRemaining(): number {
    const now = Date.now();
    let min = Infinity;
    for (const [, until] of rateLimitedUntil) {
      const remaining = until - now;
      if (remaining > 0 && remaining < min) min = remaining;
    }
    return min === Infinity ? 0 : min;
  }

  function countRateLimited(): number {
    clearExpiredCooldowns();
    let count = 0;
    for (let i = 0; i < MODEL_POOL.length; i++) {
      if (isRateLimited(i)) count++;
    }
    return count;
  }

  function countByType(type: RateLimitType): number {
    let count = 0;
    for (let i = 0; i < MODEL_POOL.length; i++) {
      if (isRateLimited(i) && rateLimitType.get(i) === type) count++;
    }
    return count;
  }

  /** Check if ALL rate-limited models are quota-exhausted (not just RPM) */
  function allRateLimitedAreQuota(): boolean {
    let hasAny = false;
    for (let i = 0; i < MODEL_POOL.length; i++) {
      if (isRateLimited(i)) {
        hasAny = true;
        if (rateLimitType.get(i) !== "quota") return false;
      }
    }
    return hasAny;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (enabled || rotateOn429) {
      const current = ctx.model;
      const parts: string[] = [];
      if (enabled) parts.push("auto");
      if (rotateOn429) parts.push("429-guard");
      const modeStr = parts.join("+");

      const cooling = countRateLimited();
      const quotaCount = countByType("quota");
      const rpmCount = countByType("rpm");
      const available = MODEL_POOL.length - cooling;

      if (current && isInPool(current.provider, current.id)) {
        const currentIdx = MODEL_POOL.findIndex(
          (m) => m.provider === current.provider && m.id === current.id,
        );
        if (currentIdx >= 0 && isRateLimited(currentIdx)) {
          const label = getRateLimitLabel(currentIdx);
          ctx.ui.setStatus(
            "rotate",
            `${modeStr} (${label} | ${available}/${MODEL_POOL.length} avail)`,
          );
        } else if (cooling > 0) {
          const detail: string[] = [];
          if (quotaCount > 0) detail.push(`${quotaCount} quota`);
          if (rpmCount > 0) detail.push(`${rpmCount} rpm`);
          ctx.ui.setStatus(
            "rotate",
            `${modeStr} (${available} avail, ${detail.join(", ")} cooling)`,
          );
        } else {
          ctx.ui.setStatus("rotate", `${modeStr} (${MODEL_POOL.length} models)`);
        }
      } else {
        ctx.ui.setStatus("rotate", `${modeStr} idle (not in pool)`);
      }
    } else {
      ctx.ui.setStatus("rotate", "");
    }
  }

  /**
   * Try to rotate to a non-rate-limited model in the pool.
   * Returns true if rotation succeeded, false if all models are rate-limited.
   */
  function rotateModel(
    ctx: ExtensionContext | ExtensionCommandContext,
    direction: "next" | "prev" = "next",
    reason?: string,
  ): boolean {
    const currentModel = ctx.model;
    if (!currentModel) return false;

    // Only rotate if current model is in the pool
    if (!isInPool(currentModel.provider, currentModel.id)) {
      ctx.ui.notify(
        `Not rotating: ${currentModel.provider}/${currentModel.id} is not in the pool`,
        "info",
      );
      return false;
    }

    // Find current position in pool
    const foundIdx = MODEL_POOL.findIndex(
      (m) => m.provider === currentModel.provider && m.id === currentModel.id,
    );
    if (foundIdx >= 0) {
      currentIndex = foundIdx;
    }

    clearExpiredCooldowns();

    // Try next entries, skipping rate-limited ones
    const attempts = MODEL_POOL.length;
    for (let i = 0; i < attempts; i++) {
      if (direction === "next") {
        currentIndex = (currentIndex + 1) % MODEL_POOL.length;
      } else {
        currentIndex = (currentIndex - 1 + MODEL_POOL.length) % MODEL_POOL.length;
      }

      if (!isRateLimited(currentIndex)) {
        break;
      }

      if (i === attempts - 1) {
        // All models are rate-limited — caller handles
        return false;
      }
    }

    const next = MODEL_POOL[currentIndex];
    const model = ctx.modelRegistry.find(next.provider, next.id);
    if (model) {
      pi.setModel(model);
      const reasonStr = reason ? ` [${reason}]` : "";
      ctx.ui.notify(
        `Rotated to ${next.provider}/${next.id} (${currentIndex + 1}/${MODEL_POOL.length})${reasonStr}`,
        "info",
      );
      return true;
    } else {
      ctx.ui.notify(`Model ${next.provider}/${next.id} not available (no API key?)`, "error");
      return false;
    }
  }

  // ── 429 guard hooks ──────────────────────────────────────────

  // Hook 1: turn_end — detect 429, classify it, mark model, try to rotate.
  pi.on("turn_end", async (event, ctx) => {
    if (!rotateOn429) return;

    const msg = event.message;
    if (msg.role === "assistant" && (msg.stopReason === "error" || msg.errorMessage)) {
      const errText = msg.errorMessage || "";
      if (errText.includes("429") || /rate.?limit|too many requests/i.test(errText)) {
        const type = classify429(errText);
        const typeLabel = type === "quota" ? "daily quota" : "RPM";

        const currentModel = ctx.model;
        if (currentModel) {
          markRateLimited(currentModel.provider, currentModel.id, type);
          if (isInPool(currentModel.provider, currentModel.id)) {
            const ok = rotateModel(ctx, "next", `turn_end ${typeLabel}`);
            if (!ok) {
              if (allRateLimitedAreQuota()) {
                ctx.ui.notify(
                  "All models at daily quota. No models available until tomorrow.",
                  "error",
                );
              } else {
                const waitS = Math.ceil(getMinCooldownRemaining() / 1000);
                ctx.ui.notify(
                  `All models rate-limited. Cooldown ~${waitS}s remaining. 429-guard will delay retries.`,
                  "warning",
                );
              }
            }
          }
        }
        updateStatus(ctx);
      }
    }
  });

  // Hook 2: turn_start — before every LLM request, if the current model
  // is rate-limited, try to rotate away. If all models are rate-limited:
  //   - quota-exhausted models → give up immediately (no point waiting)
  //   - RPM-limited models → sleep until the shortest cooldown expires
  pi.on("turn_start", async (_event, ctx) => {
    if (!rotateOn429) return;

    let waited = 0;

    while (true) {
      const currentModel = ctx.model;
      if (!currentModel) return;

      // Check if current model is rate-limited
      const currentIdx = MODEL_POOL.findIndex(
        (m) => m.provider === currentModel.provider && m.id === currentModel.id,
      );
      if (currentIdx < 0) return; // not in pool, let it proceed
      if (!isRateLimited(currentIdx)) return; // clean model, proceed

      // Try to rotate to a clean model
      clearExpiredCooldowns();
      const rotated = rotateModel(ctx, "next", "turn_start guard");
      if (rotated) {
        updateStatus(ctx);
        continue; // loop back to check the new model
      }

      // All models are rate-limited
      if (allRateLimitedAreQuota()) {
        // Daily quota exhausted everywhere — waiting won't help
        ctx.ui.notify("429-guard: all models at daily quota. No point waiting.", "error");
        updateStatus(ctx);
        return; // let the request fail, nothing we can do
      }

      // At least some are RPM-limited — wait for the soonest cooldown
      const waitMs = getMinCooldownRemaining();
      if (waitMs <= 0) {
        // All cooldowns expired — models should be clean now
        clearExpiredCooldowns();
        updateStatus(ctx);
        return;
      }

      if (waited + waitMs > MAX_WAIT_MS) {
        ctx.ui.notify(
          "429-guard: max wait exceeded, proceeding with rate-limited model",
          "warning",
        );
        updateStatus(ctx);
        return;
      }

      const waitS = Math.ceil(waitMs / 1000);
      ctx.ui.notify(
        `429-guard: all models rate-limited. Waiting ${waitS}s for cooldown...`,
        "warning",
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waited += waitMs;
      clearExpiredCooldowns();
      updateStatus(ctx);
    }
  });

  // ── Auto-rotate after each agent turn (when enabled) ──────────

  pi.on("agent_end", async (_event, ctx) => {
    if (enabled) {
      rotateModel(ctx, "next");
      updateStatus(ctx);
    }
  });

  // ── Update status on model change ─────────────────────────────

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  // ── Toggle commands ──────────────────────────────────────────

  pi.registerCommand("rotate-on", {
    description: "Enable automatic model rotation",
    handler: async (_args, ctx) => {
      enabled = true;
      updateStatus(ctx);
      const poolList = MODEL_POOL.map((m) => `${m.provider}/${m.id}`).join(", ");
      ctx.ui.notify(`Rotation enabled. Pool: ${poolList}`, "info");
    },
  });

  pi.registerCommand("rotate-off", {
    description: "Disable automatic model rotation",
    handler: async (_args, ctx) => {
      enabled = false;
      updateStatus(ctx);
      ctx.ui.notify("Rotation disabled", "info");
    },
  });

  pi.registerCommand("rotate-toggle", {
    description: "Toggle model rotation on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      updateStatus(ctx);
      ctx.ui.notify(`Rotation ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("rotate-now", {
    description: "Manually rotate to next model (works even when auto is off)",
    handler: async (_args, ctx) => {
      rotateModel(ctx, "next");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("rotate-429-toggle", {
    description: "Toggle automatic rotation on 429 rate-limit errors",
    handler: async (_args, ctx) => {
      rotateOn429 = !rotateOn429;
      updateStatus(ctx);
      ctx.ui.notify(`429 rotation ${rotateOn429 ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("rotate-status", {
    description: "Show rotation pool status including rate-limit cooldowns",
    handler: async (_args, ctx) => {
      clearExpiredCooldowns();
      const currentModel = ctx.model;
      const lines = MODEL_POOL.map((m, i) => {
        const isCurrent =
          currentModel && currentModel.provider === m.provider && currentModel.id === m.id;
        const isCoolingDown = isRateLimited(i);
        const untilVal = rateLimitedUntil.get(i);
        const type = rateLimitType.get(i);
        let marker = "";
        if (isCurrent) marker = " ← current";
        if (isCoolingDown) {
          const remaining = Math.ceil(((untilVal ?? 0) - Date.now()) / 1000);
          const typeLabel = type === "quota" ? "quota" : "rpm";
          marker += ` ⏳ ${remaining}s (${typeLabel})`;
        }
        return `  ${i + 1}. ${m.provider}/${m.id}${marker}`;
      }).join("\n");

      const autoStatus = enabled ? "ON" : "OFF";
      const guard429Status = rotateOn429 ? "ON" : "OFF";
      ctx.ui.notify(`Auto-rotate: ${autoStatus} | 429-guard: ${guard429Status}\n${lines}`, "info");
    },
  });

  // ── CLI flags ─────────────────────────────────────────────────

  pi.registerFlag("rotate", {
    description: "Start with model auto-rotation enabled",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("no-rotate-429", {
    description: "Disable 429 auto-rotation on startup",
    type: "boolean",
    default: false,
  });

  // ── Startup ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("rotate")) {
      enabled = true;
    }
    if (pi.getFlag("no-rotate-429")) {
      rotateOn429 = false;
    }
    updateStatus(ctx);

    const poolList = MODEL_POOL.map((m, i) => {
      const marker =
        ctx.model && ctx.model.provider === m.provider && ctx.model.id === m.id ? " ← current" : "";
      return `  ${i + 1}. ${m.provider}/${m.id}${marker}`;
    }).join("\n");

    const autoStatus = enabled ? "ON" : "OFF";
    const guard429Status = rotateOn429 ? "ON" : "OFF";

    ctx.ui.notify(
      `Model rotation ready.\nAuto-rotate: ${autoStatus} | 429-guard: ${guard429Status}\nPool:\n${poolList}\nCommands: /rotate-on, /rotate-off, /rotate-toggle, /rotate-429-toggle, /rotate-status`,
      "info",
    );
  });
}
