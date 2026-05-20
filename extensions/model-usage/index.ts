import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface QuotaInfo {
	userLimit: number;
	userRemaining: number;
	modelLimit: number;
	modelRemaining: number;
	updated: number;
}

export default function (pi: ExtensionAPI) {
	const store = new Map<string, QuotaInfo>();

	// ── Restore state from session history ──
	function rebuild(ctx: any) {
		store.clear();
		try {
			const branch = ctx.sessionManager?.getBranch?.();
			if (!branch) return;
			for (const entry of branch) {
				if (entry.type === "custom" && (entry as any).customType === "modelscope_quota") {
					const d = (entry as any).data;
					store.set(d.model, {
						userLimit: d.userLimit ?? -1,
						userRemaining: d.userRemaining ?? -1,
						modelLimit: d.modelLimit ?? -1,
						modelRemaining: d.modelRemaining ?? -1,
						updated: d.updated,
					});
				}
			}
		} catch {}
	}

	pi.on("session_start", (_e, ctx) => rebuild(ctx));

	// ── Capture ModelScope quota headers from HTTP response ──
	pi.on("after_provider_response", (event: any, ctx) => {
		if (ctx.model?.provider !== "modelscope") return;

		const headers = event.headers ?? {};

		const userLimit = headers["modelscope-ratelimit-requests-limit"];
		const userRemaining = headers["modelscope-ratelimit-requests-remaining"];
		const modelLimit = headers["modelscope-ratelimit-model-requests-limit"];
		const modelRemaining = headers["modelscope-ratelimit-model-requests-remaining"];

		if (userRemaining == null && modelRemaining == null) return;

		const data: QuotaInfo = {
			userLimit: userLimit != null ? Number(userLimit) : -1,
			userRemaining: userRemaining != null ? Number(userRemaining) : -1,
			modelLimit: modelLimit != null ? Number(modelLimit) : -1,
			modelRemaining: modelRemaining != null ? Number(modelRemaining) : -1,
			updated: Date.now(),
		};

		store.set(ctx.model.id, data);
		pi.appendEntry("modelscope_quota", { model: ctx.model.id, ...data });
	});

	// ── /model-usage command ──
	pi.registerCommand("model-usage", {
		description: "Show ModelScope rate-limit quota for user and current model",
		handler: async (_args, ctx) => {
			if (store.size === 0) {
				ctx.ui.notify("No ModelScope quota data yet.\nSend a request with a ModelScope model first.", "info");
				return;
			}

			const lines: string[] = [];
			for (const [model, q] of store) {
				const time = new Date(q.updated).toLocaleTimeString();
				lines.push(`  ${model}`);

				const userParts: string[] = [];
				if (q.userLimit >= 0) userParts.push(`${q.userLimit.toLocaleString()} limit`);
				if (q.userRemaining >= 0) userParts.push(`${q.userRemaining.toLocaleString()} remaining`);
				if (userParts.length > 0) lines.push(`    User:    ${userParts.join(", ")}`);

				const modelParts: string[] = [];
				if (q.modelLimit >= 0) modelParts.push(`${q.modelLimit.toLocaleString()} limit`);
				if (q.modelRemaining >= 0) modelParts.push(`${q.modelRemaining.toLocaleString()} remaining`);
				if (modelParts.length > 0) lines.push(`    Model:   ${modelParts.join(", ")}`);

				lines.push(`    Updated: ${time}\n`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}