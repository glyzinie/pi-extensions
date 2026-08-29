import { describe, expect, test } from "bun:test";

import askExtension from "../extensions/ask/index.ts";

function askTool(): any {
  let tool: any;
  askExtension({
    registerTool(definition: any) {
      tool = definition;
    },
  } as any);
  return tool;
}

describe("ask", () => {
  test("uses built-in dialogs and normalizes options", async () => {
    const tool = askTool();
    const shownOptions: string[][] = [];
    let selectCount = 0;
    const inputs = [" custom answer ", " free answer "];

    const result = await tool.execute(
      "ask-1",
      {
        questions: [
          { prompt: " Choose   one ", options: [" A ", "A", "B"] },
          { prompt: "Custom", options: ["✎ Other…"] },
          { prompt: "Explain", options: [] },
        ],
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          async select(_title: string, options: string[]) {
            shownOptions.push(options);
            return selectCount++ === 0 ? "B" : options.at(-1);
          },
          async input() {
            return inputs.shift();
          },
        },
      },
    );

    expect(shownOptions[0]).toEqual(["A", "B", "✎ Other…"]);
    expect(shownOptions[1]).toEqual(["✎ Other…", "✎ Other 2…"]);
    expect(result.content[0].text).toBe(
      "Q1: B\nQ2: custom answer\nQ3: free answer",
    );
    expect(result.details).toEqual({
      answers: ["B", "custom answer", "free answer"],
      cancelled: false,
    });
  });

  test("returns completed answers when a later question is cancelled", async () => {
    const tool = askTool();
    let inputCount = 0;

    const result = await tool.execute(
      "ask-2",
      {
        questions: [
          { prompt: "First", options: [] },
          { prompt: "Second", options: [] },
        ],
      },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          async input() {
            return inputCount++ === 0 ? "done" : undefined;
          },
        },
      },
    );

    expect(result.content[0].text).toBe("Q1: done\nUser cancelled.");
    expect(result.details).toEqual({ answers: ["done"], cancelled: true });
  });

  test("fails as a tool error when interactive UI is unavailable", async () => {
    const tool = askTool();

    await expect(
      tool.execute(
        "ask-3",
        { questions: [{ prompt: "Question", options: [] }] },
        undefined,
        undefined,
        { hasUI: false },
      ),
    ).rejects.toThrow("ask requires an interactive UI");
  });
});
