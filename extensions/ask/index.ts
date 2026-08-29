import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const AskParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      prompt: Type.String(),
      options: Type.Array(Type.String(), { maxItems: 8 }),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

type AskDetails = {
  answers: string[];
  cancelled: boolean;
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueOptions(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))];
}

function otherLabel(options: string[]): string {
  let label = "✎ Other…";
  let suffix = 1;
  while (options.includes(label)) label = `✎ Other ${++suffix}…`;
  return label;
}

function askResult(answers: string[], cancelled: boolean) {
  const lines = answers.map((answer, index) => `Q${index + 1}: ${answer}`);
  if (cancelled) lines.push("User cancelled.");

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { answers: [...answers], cancelled } satisfies AskDetails,
  };
}

export default function piAsk(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user 1-4 questions. options=[] is free text; otherwise choices plus Other are shown.",
    parameters: AskParams,
    executionMode: "sequential",

    async execute(_toolCallId, { questions }, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("ask requires an interactive UI");
      }

      const answers: string[] = [];

      for (let index = 0; index < questions.length; index++) {
        const question = questions[index];
        const prompt = oneLine(question.prompt) || `Question ${index + 1}`;
        const title = questions.length > 1
          ? `${index + 1}/${questions.length} ${prompt}`
          : prompt;
        const options = uniqueOptions(question.options);

        let answer: string | undefined;
        if (options.length === 0) {
          answer = await ctx.ui.input(title, "Type your answer…", { signal });
        } else {
          const other = otherLabel(options);
          const selected = await ctx.ui.select(title, [...options, other], {
            signal,
          });
          if (selected === undefined) return askResult(answers, true);
          answer = selected === other
            ? await ctx.ui.input(title, "Type your answer…", { signal })
            : selected;
        }

        if (answer === undefined) return askResult(answers, true);
        answers.push(answer.trim() || "(blank)");
      }

      return askResult(answers, false);
    },
  });
}
