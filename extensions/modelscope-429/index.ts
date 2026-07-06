/**
 * ModelScope 429 Error Rewrite — Pi Extension
 *
 * Hooks message_end to rewrite ModelScope's mislabeled 429 error messages so
 * pi's retry logic (isRetryableAssistantError) makes correct decisions.
 *
 * Replaces the proxy-429 extension — no child process or HTTP proxy needed.
 *
 * @see {@link https://github.com/earendil-works/pi-coding-agent pi-ai retry logic}
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, _ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || msg.stopReason !== "error") return;

    const orig = msg.errorMessage ?? "";
    if (!orig) return;

    // ── Parse the JSON body embedded in the error message ──
    // Pi wraps provider errors as: 'Error: 429: {json body}'
    const jsonMatch = orig.match(/\{.*\}/s);
    if (!jsonMatch) return;

    let body: any;
    try {
      body = JSON.parse(jsonMatch[0]);
    } catch {
      return;
    }

    // Only touch ModelScope-flat-format errors.
    // ModelScope uses a flat JSON schema: { code, message, param, type }
    // where "param" is usually null. OpenAI uses nested { error: { ... } }.
    // This prevents accidentally rewriting OpenAI's "insufficient_quota".
    const isModelScopeFlat =
      (body.param === null || body.param === undefined) &&
      typeof body.code === "string" &&
      typeof body.type === "string" &&
      typeof body.message === "string" &&
      !body.error;

    if (!isModelScopeFlat) return;

    const code = body.code.toLowerCase();
    const message = body.message.toLowerCase();

    // ── Helper: build a rewritten errorMessage ──
    function rewrite(newCode: string, newMessage: string, newType: string) {
      return {
        message: {
          ...msg,
          errorMessage: `Error: 429: ${JSON.stringify({
            code: newCode,
            message: newMessage,
            param: null,
            type: newType,
          })}`,
        },
      };
    }

    // ── Type A: "too frequent request" — transient rate limit ──
    if (/too\s*frequent/i.test(message)) {
      return rewrite(
        "rate_limit_exceeded",
        "rate limit exceeded — too many requests",
        "rate_limit_exceeded",
      );
    }

    // ── Type C: "exceeded today's quota... try again tomorrow" — genuine daily quota ──
    // Checked before Types B and B2 as a fail-safe: this is the only NON-retryable
    // case. If a daily-quota message also contains "quota" (code) or "billing"
    // (message), the retryable rules below would otherwise win. In practice these
    // patterns appear mutually exclusive, but Type C first is the safer failure mode.
    if (/exceeded today'?s quota.*try again tomorrow/i.test(message)) {
      const newMsg = `${body.message} This is a billing-related daily quota exhaustion.`;
      return rewrite("daily_quota_exhausted", newMsg, "daily_quota_exhausted");
    }

    // ── Type B: "insufficient_quota" in code — ModelScope mislabels rate limits as quota ──
    // Pi's NON_RETRYABLE pattern matches "insufficient_quota"; strip from all fields.
    if (/quota|insufficient/.test(code)) {
      const cleanMsg = body.message
        .replace(/insufficient_quota/gi, "rate_limit_reached")
        .replace(/quota/gi, "limit")
        .replace(/billing/gi, "usage");

      return rewrite("rate_limit_reached", cleanMsg, "rate_limit_reached");
    }

    // ── Type B2: "billing" in message but not in code — ModelScope labels rate limits as billing ──
    // Pi's NON_RETRYABLE pattern matches "billing", so strip it.
    if (/billing/.test(message)) {
      const cleanMsg = body.message
        .replace(/billing details/gi, "usage details")
        .replace(/check your plan and billing/gi, "check your plan and usage")
        .replace(/billing/gi, "usage");

      return rewrite("rate_limit_exceeded", cleanMsg, "rate_limit_exceeded");
    }

    // ── Type D: other ModelScope 429s — strip non-retryable keywords, then make retryable ──
    // Pi checks NON_RETRYABLE before RETRYABLE, so any surviving "quota"/"billing"
    // keywords in the original message would block retry despite the appended hint.
    if (body.message) {
      const cleanMsg = body.message
        .replace(/insufficient_quota/gi, "rate_limit_reached")
        .replace(/quota exceeded/gi, "rate limit exceeded")
        .replace(/quota/gi, "limit")
        .replace(/billing/gi, "usage")
        .replace(/out of budget/gi, "rate limit");
      const newMsg = `${cleanMsg} [429 rate limit — too many requests]`;

      return rewrite("rate_limit_error", newMsg, "rate_limit_error");
    }
  });
}
