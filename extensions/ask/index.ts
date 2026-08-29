/**
 * pi-ask - compact interactive question tool for pi-coding-agent.
 *
 * Goals:
 * - Tiny model-facing schema.
 * - Use Pi's built-in select/input dialogs instead of a custom TUI.
 * - Always allow free-form input ("Other…").
 * - Remove answered ask tool calls/options from future LLM context while
 *   preserving the original session transcript on disk.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "ask";
const MAX_PROMPT_IN_CONTEXT = 120;

const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      prompt: Type.String(),
      options: Type.Array(Type.String(), { maxItems: 8 }),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

type Answer = {
  answer: string;
  kind: "selected" | "text";
  optionIndex?: number;
};

type AskDetails = {
  answers: Answer[];
  cancelled: boolean;
};

type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
};

type ToolResultLike = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  timestamp?: number;
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shortPrompt(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = oneLine(value);
  if (!text) return fallback;
  if (text.length <= MAX_PROMPT_IN_CONTEXT) return text;
  return `${text.slice(0, MAX_PROMPT_IN_CONTEXT - 1)}…`;
}

function uniqueOptions(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))];
}

function otherLabel(options: string[]): string {
  const preferred = [
    "✎ Other…",
    "✎ Type another answer…",
    "✎ Free text…",
    "✎ Custom answer…",
  ];
  for (const label of preferred) {
    if (!options.includes(label)) return label;
  }

  let suffix = 2;
  while (options.includes(`✎ Custom answer ${suffix}…`)) suffix += 1;
  return `✎ Custom answer ${suffix}…`;
}

function toolResultText(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

function isAskDetails(value: unknown): value is AskDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<AskDetails>;
  return typeof details.cancelled === "boolean" && Array.isArray(details.answers);
}

function formatDecision(call: ToolCallBlock, result: ToolResultLike): string {
  const details = isAskDetails(result.details) ? result.details : undefined;

  if (!details) {
    const fallback = toolResultText(result);
    return fallback ? `[User decision]\n${fallback}` : "[User decision] Ask completed.";
  }

  if (details.cancelled) return "[User decision] User cancelled the question.";

  const args = call.arguments as { questions?: Array<{ prompt?: unknown }> } | undefined;
  const questions = args?.questions ?? [];
  const lines = details.answers.map((answer, index) => {
    const prompt = shortPrompt(questions[index]?.prompt, `Q${index + 1}`);
    return `- ${prompt} → ${oneLine(answer.answer) || "(blank)"}`;
  });

  return `[User decisions]\n${lines.join("\n")}`;
}

/**
 * Context-only rewrite.
 *
 * Pi passes a deep copy to the `context` hook, so this does not modify the
 * session JSONL. Completed `ask` calls and their option payloads disappear from
 * future provider requests and are replaced by a short user-decision summary.
 */
function compactAskContext(messages: AgentMessage[]): AgentMessage[] | undefined {
  const out: AgentMessage[] = [];
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as any;

    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(messages[i]);
      continue;
    }

    const content = message.content as unknown[];
    const askCalls: ToolCallBlock[] = content.filter(
      (block: unknown): block is ToolCallBlock =>
        !!block &&
        typeof block === "object" &&
        (block as ToolCallBlock).type === "toolCall" &&
        (block as ToolCallBlock).name === TOOL_NAME,
    );

    if (askCalls.length === 0) {
      out.push(messages[i]);
      continue;
    }

    // Tool results for one assistant tool-call batch are adjacent in Pi's
    // message stream. Collect them before rewriting so mixed tool batches keep
    // valid assistant -> toolResult ordering.
    let j = i + 1;
    const followingResults: ToolResultLike[] = [];
    while (j < messages.length && (messages[j] as any)?.role === "toolResult") {
      followingResults.push(messages[j] as any);
      j++;
    }

    const resultsById = new Map(followingResults.map((result) => [result.toolCallId, result]));
    if (!askCalls.every((call) => resultsById.has(call.id))) {
      // An incomplete/corrupt exchange should be left untouched.
      out.push(messages[i]);
      continue;
    }

    const askIds = new Set(askCalls.map((call) => call.id));
    const remainingContent = content.filter(
      (block: any) => !(block?.type === "toolCall" && askIds.has(block.id)),
    );
    const hasOtherToolCalls = remainingContent.some((block: any) => block?.type === "toolCall");

    if (hasOtherToolCalls) {
      // Preserve thinking/signatures when another tool call from the same
      // assistant message still needs its protocol pairing.
      out.push({ ...message, content: remainingContent } as AgentMessage);
      for (const result of followingResults) {
        if (!askIds.has(result.toolCallId)) out.push(result as unknown as AgentMessage);
      }
    } else {
      // Once ask is the only tool interaction, prior thinking is no longer
      // useful context. Keep only visible assistant text, if any.
      const textContent = remainingContent.filter(
        (block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim(),
      );
      if (textContent.length > 0) {
        out.push({ ...message, content: textContent } as AgentMessage);
      }
    }

    const summaries = askCalls.map((call) => formatDecision(call, resultsById.get(call.id)!));
    const timestamp =
      followingResults.find((result) => typeof result.timestamp === "number")?.timestamp ??
      (typeof message.timestamp === "number" ? message.timestamp : Date.now());

    out.push({
      role: "user",
      content: summaries.join("\n"),
      timestamp,
    } as AgentMessage);

    changed = true;
    i = j - 1;
  }

  return changed ? out : undefined;
}

export default function piAsk(pi: ExtensionAPI) {
  pi.on("context", (event) => {
    const messages = compactAskContext(event.messages);
    return messages ? { messages } : undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask",
    description: "Ask the user 1-4 questions. options=[] is free text; otherwise choices plus Other are shown.",
    parameters: AskParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "Ask failed: interactive UI is unavailable." }],
          details: { answers: [], cancelled: true } satisfies AskDetails,
        };
      }

      const answers: Answer[] = [];
      const total = params.questions.length;

      for (let i = 0; i < total; i++) {
        const question = params.questions[i];
        const prompt = oneLine(question.prompt) || `Question ${i + 1}`;
        const options = uniqueOptions(question.options);
        const title = total > 1 ? `${i + 1}/${total} ${prompt}` : prompt;

        let answer: Answer;

        if (options.length === 0) {
          const typed = await ctx.ui.input(title, "Type your answer…", { signal });
          if (typed === undefined) {
            return {
              content: [{ type: "text" as const, text: "User cancelled." }],
              details: { answers, cancelled: true } satisfies AskDetails,
            };
          }
          answer = { answer: typed.trim() || "(blank)", kind: "text" };
        } else {
          const other = otherLabel(options);
          const selected = await ctx.ui.select(title, [...options, other], { signal });
          if (selected === undefined) {
            return {
              content: [{ type: "text" as const, text: "User cancelled." }],
              details: { answers, cancelled: true } satisfies AskDetails,
            };
          }

          if (selected === other) {
            const typed = await ctx.ui.input(prompt, "Type your answer…", { signal });
            if (typed === undefined) {
              return {
                content: [{ type: "text" as const, text: "User cancelled." }],
                details: { answers, cancelled: true } satisfies AskDetails,
              };
            }
            answer = { answer: typed.trim() || "(blank)", kind: "text" };
          } else {
            const optionIndex = options.indexOf(selected);
            answer = {
              answer: selected,
              kind: "selected",
              optionIndex: optionIndex >= 0 ? optionIndex + 1 : undefined,
            };
          }
        }

        answers.push(answer);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: answers.map((answer, i) => `Q${i + 1}: ${answer.answer}`).join("\n"),
          },
        ],
        details: { answers, cancelled: false } satisfies AskDetails,
      };
    },
  });
}
