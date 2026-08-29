import { describe, expect, test } from "bun:test";

import {
  formatReasoningStatus,
  localizeReasoningLabel,
  reasoningLanguageFromSettings,
  updateReasoningLanguageSettings,
} from "../extensions/codex-reasoning-summary/index.ts";

describe("localizeReasoningLabel", () => {
  test("keeps Japanese headings", () => {
    expect(localizeReasoningLabel("現在の実装を確認中")).toBe(
      "現在の実装を確認中",
    );
  });

  test("maps English headings to Japanese status categories", () => {
    expect(localizeReasoningLabel("Finalizing the response")).toBe(
      "結果を整理中…",
    );
    expect(localizeReasoningLabel("Running tests and typecheck")).toBe(
      "動作を検証中…",
    );
    expect(localizeReasoningLabel("Implementing the fix")).toBe(
      "変更を実装中…",
    );
    expect(localizeReasoningLabel("Planning the approach")).toBe(
      "方針を検討中…",
    );
    expect(localizeReasoningLabel("Reviewing repository structure")).toBe(
      "情報を確認中…",
    );
  });

  test("does not expose unknown English headings", () => {
    expect(localizeReasoningLabel("Synchronizing moonbeams")).toBe(
      "内容を検討中…",
    );
  });

  test("removes terminal control sequences before classification", () => {
    expect(localizeReasoningLabel("\u001b[31mReviewing code\u001b[0m")).toBe(
      "情報を確認中…",
    );
  });
});

describe("formatReasoningStatus", () => {
  test("keeps English as the default-compatible display", () => {
    expect(formatReasoningStatus("Reviewing code", "en")).toBe(
      "Reasoning: Reviewing code",
    );
  });

  test("renders a deterministic Japanese status", () => {
    expect(formatReasoningStatus("Reviewing code", "ja")).toBe(
      "推論：情報を確認中…",
    );
  });
});

describe("reasoning summary settings", () => {
  test("defaults to English when the setting is absent", () => {
    expect(reasoningLanguageFromSettings({ theme: "dark" })).toBe("en");
  });

  test("reads Japanese from the extension settings section", () => {
    expect(
      reasoningLanguageFromSettings({
        codexReasoningSummary: { language: "ja" },
      }),
    ).toBe("ja");
  });

  test("rejects invalid language values", () => {
    expect(() =>
      reasoningLanguageFromSettings({
        codexReasoningSummary: { language: "fr" },
      })
    ).toThrow('codexReasoningSummary.language must be "en" or "ja".');
  });

  test("updates only the extension setting and preserves other fields", () => {
    const updated = JSON.parse(
      updateReasoningLanguageSettings(
        JSON.stringify({
          theme: "dark",
          codexReasoningSummary: { language: "en", futureOption: true },
        }),
        "ja",
      ),
    );

    expect(updated).toEqual({
      theme: "dark",
      codexReasoningSummary: { language: "ja", futureOption: true },
    });
  });

  test("creates a settings object when the file does not exist", () => {
    expect(JSON.parse(updateReasoningLanguageSettings(undefined, "ja"))).toEqual({
      codexReasoningSummary: { language: "ja" },
    });
  });
});
