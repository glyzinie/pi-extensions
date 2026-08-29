import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SummaryMode = "auto" | "concise" | "detailed";

const SUMMARY_MODE: SummaryMode = "concise";
const MAX_LABEL_LENGTH = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function extractLabel(text: string): string | undefined {
	const cleaned = text
		.replace(/<!--\s*-->/g, "")
		.trim();

	if (!cleaned) {
		return undefined;
	}

	// Codex reasoning summaries often contain headings like:
	// **Inspecting the repository**
	const headings = [...cleaned.matchAll(/\*\*([^*\n]+)\*\*/g)];

	let label = headings.at(-1)?.[1]?.trim();

	if (!label) {
		label = cleaned
			.split("\n")
			.map((line) =>
				line
					.replace(/^#+\s*/, "")
					.replace(/^[-*]\s*/, "")
					.trim(),
			)
			.find(Boolean);
	}

	if (!label) {
		return undefined;
	}

	if (label.length > MAX_LABEL_LENGTH) {
		return `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
	}

	return label;
}

export default function (pi: ExtensionAPI) {
	let thinking = "";

	/*
	 * Ask OpenAI Codex for a concise reasoning summary.
	 *
	 * Pi already requests "auto" by default. This simply makes
	 * the desired behavior explicit and keeps the UI compact.
	 */
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") {
			return;
		}

		const payload = asRecord(event.payload);
		if (!payload) {
			return;
		}

		const reasoning = asRecord(payload.reasoning);
		if (!reasoning) {
			return;
		}

		reasoning.summary = SUMMARY_MODE;

		return payload;
	});

	/*
	 * New model turn -> reset the accumulated reasoning summary.
	 */
	pi.on("turn_start", (_event, ctx) => {
		thinking = "";

		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage();
		}
	});

	/*
	 * Show the latest reasoning-summary heading in Pi's
	 * working indicator.
	 */
	pi.on("message_update", (event, ctx) => {
		if (!ctx.hasUI || ctx.model?.provider !== "openai-codex") {
			return;
		}

		const update = event.assistantMessageEvent;

		if (update.type === "thinking_delta") {
			thinking += update.delta;

			const label = extractLabel(thinking);

			if (label) {
				ctx.ui.setWorkingMessage(label);
			}

			return;
		}

		// Final answer started.
		if (update.type === "text_start") {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		ctx.ui.setHiddenThinkingLabel("Reasoning summary");
	});

	pi.on("agent_end", (_event, ctx) => {
		thinking = "";

		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage();
		}
	});
}
