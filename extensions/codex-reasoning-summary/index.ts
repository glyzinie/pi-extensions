import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type SummaryMode = "auto" | "concise" | "detailed";

const TARGET_API = "openai-codex-responses";
const SUMMARY_MODE: SummaryMode = "auto";
const STATUS_KEY = "codex-reasoning-summary";
const MAX_LABEL_LENGTH = 100;
const MAX_SOURCE_LINE_LENGTH = 512;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sanitizeLabel(value: string): string {
  return value
    // OSC, DCS/SOS/PM/APC, and CSI terminal control sequences.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    // Drop remaining control and Unicode formatting characters, including
    // incomplete escape sequences and bidi controls.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface CodeFence {
  character: "`" | "~";
  length: number;
}

function isIndentedCode(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

function updateCodeFence(line: string, current: CodeFence | undefined): {
  fence: CodeFence | undefined;
  marker: boolean;
} {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return { fence: current, marker: false };

  const sequence = match[1];
  const character = sequence[0] as "`" | "~";
  if (!current) {
    return { fence: { character, length: sequence.length }, marker: true };
  }

  const closes =
    character === current.character &&
    sequence.length >= current.length &&
    match[2].trim() === "";
  return { fence: closes ? undefined : current, marker: true };
}

function extractHeading(line: string): string | undefined {
  if (isIndentedCode(line)) return undefined;

  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("<!--")) return undefined;

  // Only accept explicit, whole-line headings. Do not promote arbitrary bold
  // phrases or reasoning details into the status indicator.
  const bold = trimmed.match(/^\*\*([^*]+)\*\*$/)?.[1];
  const markdown = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/)?.[1];
  const label = sanitizeLabel(bold ?? markdown ?? "");
  if (!label) return undefined;

  return label.length > MAX_LABEL_LENGTH
    ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : label;
}

function extractLatestHeading(text: string): string | undefined {
  let latest: string | undefined;
  let codeFence: CodeFence | undefined;
  let start = 0;

  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const lineLength = end - start;
    const line = lineLength <= MAX_SOURCE_LINE_LENGTH
      ? text.slice(start, end).replace(/\r$/, "")
      : "";
    const fenceUpdate = updateCodeFence(line, codeFence);
    codeFence = fenceUpdate.fence;
    if (!fenceUpdate.marker && !codeFence) {
      latest = extractHeading(line) ?? latest;
    }

    if (newline === -1) break;
    start = newline + 1;
  }

  return latest;
}

export default function codexReasoningSummary(pi: ExtensionAPI) {
  let pendingLine = "";
  let discardLongLine = false;
  let codeFence: CodeFence | undefined;
  let contentIndex: number | undefined;
  let activeLabel: string | undefined;

  const resetStreamState = () => {
    pendingLine = "";
    discardLongLine = false;
    codeFence = undefined;
    contentIndex = undefined;
  };

  const clearStatus = (ctx: ExtensionContext) => {
    if (activeLabel === undefined) return;
    activeLabel = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const showLabel = (label: string, ctx: ExtensionContext) => {
    if (label === activeLabel) return;
    activeLabel = label;
    ctx.ui.setStatus(STATUS_KEY, `Reasoning: ${label}`);
  };

  const consumeThinkingDelta = (delta: string, ctx: ExtensionContext) => {
    let start = 0;

    while (start < delta.length) {
      const newline = delta.indexOf("\n", start);
      const end = newline === -1 ? delta.length : newline;
      const completesLine = newline !== -1;
      const hasTrailingCarriageReturn =
        completesLine && end > start && delta[end - 1] === "\r";
      const segmentEnd = hasTrailingCarriageReturn ? end - 1 : end;

      if (!discardLongLine) {
        const segmentLength = segmentEnd - start;
        if (segmentLength > MAX_SOURCE_LINE_LENGTH - pendingLine.length) {
          pendingLine = "";
          discardLongLine = true;
        } else {
          pendingLine += delta.slice(start, segmentEnd);
          if (completesLine) {
            const fenceUpdate = updateCodeFence(pendingLine, codeFence);
            codeFence = fenceUpdate.fence;
            if (!fenceUpdate.marker && !codeFence) {
              const label = extractHeading(pendingLine);
              if (label) showLabel(label, ctx);
            }
          }
        }
      }

      if (!completesLine) break;
      pendingLine = "";
      discardLongLine = false;
      start = newline + 1;
    }
  };

  // `auto` selects the most detailed summary mode supported by each model.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.api !== TARGET_API) return;

    const payload = asRecord(event.payload);
    const reasoning = asRecord(payload?.reasoning);
    if (!payload || !reasoning || "summary" in reasoning) return;

    reasoning.summary = SUMMARY_MODE;
    return payload;
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode === "tui") clearStatus(ctx);
    resetStreamState();
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    if (
      event.message.role !== "assistant" ||
      event.message.api !== TARGET_API
    ) {
      clearStatus(ctx);
      resetStreamState();
      return;
    }

    const update = event.assistantMessageEvent;

    if (update.type === "thinking_start") {
      clearStatus(ctx);
      resetStreamState();
      contentIndex = update.contentIndex;
      return;
    }

    if (update.type === "thinking_delta") {
      if (contentIndex !== update.contentIndex) {
        clearStatus(ctx);
        resetStreamState();
        contentIndex = update.contentIndex;
      }
      consumeThinkingDelta(update.delta, ctx);
      return;
    }

    if (update.type === "thinking_end") {
      if (contentIndex !== update.contentIndex) return;

      const label = extractLatestHeading(update.content);
      if (label) showLabel(label, ctx);
      else clearStatus(ctx);
      pendingLine = "";
      discardLongLine = false;
      codeFence = undefined;
      contentIndex = undefined;
      return;
    }

    if (update.type === "text_start") {
      clearStatus(ctx);
      resetStreamState();
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") clearStatus(ctx);
    resetStreamState();
  });
}
