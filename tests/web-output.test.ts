import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import { truncateJinaMarkdown } from "../extensions/jina/output.ts";
import {
  formatKagiOutput,
  type KagiResult,
} from "../extensions/kagi/output.ts";

describe("Jina output", () => {
  test("truncates Markdown with a format-specific notice", () => {
    const output = truncateJinaMarkdown("paragraph\n".repeat(DEFAULT_MAX_LINES + 1));

    expect(output.truncated).toBe(true);
    expect(output.text).toEndWith(
      `[Markdown output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`,
    );
    expect(output.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
  });
});

describe("Kagi output", () => {
  test("formats complete result blocks", () => {
    const results: KagiResult[] = [
      {
        title: "Example",
        url: "https://example.test",
        snippet: "A result snippet.",
        published: "2026-01-01",
      },
    ];

    const output = formatKagiOutput("example query", results);

    expect(output.truncated).toBe(false);
    expect(output.shown).toBe(1);
    expect(output.text).toContain("1. Example");
    expect(output.text).toContain("URL: https://example.test");
    expect(output.text).toContain("Published: 2026-01-01");
    expect(output.text).toContain("A result snippet.");
  });

  test("reports field-level truncation without splitting a result block", () => {
    const output = formatKagiOutput("field truncation", [
      {
        title: "Example",
        url: "https://example.test",
        snippet: "x".repeat(4_001),
      },
    ]);

    expect(output.shown).toBe(1);
    expect(output.truncated).toBe(true);
    expect(output.text).toContain("x".repeat(3_999) + "…");
    expect(output.text).toEndWith(
      `[Search output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`,
    );
  });

  test("drops whole result blocks when the byte budget is exhausted", () => {
    const results: KagiResult[] = Array.from({ length: 20 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.test/${"x".repeat(4_000)}`,
      snippet: "あ".repeat(4_000),
    }));

    const output = formatKagiOutput("large results", results);

    expect(output.truncated).toBe(true);
    expect(output.shown).toBeGreaterThan(0);
    expect(output.shown).toBeLessThan(results.length);
    expect(output.text).toEndWith(
      `[Search output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`,
    );
    expect(output.text).not.toContain(`${output.shown + 1}. Result`);
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
    expect(output.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  });
});
