import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Check } from "typebox/value";

import lsExtension from "../extensions/ls/index.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-ls-test-"));
  temporaryRoots.push(root);
  return root;
}

function lsTool(): any {
  let tool: any;
  lsExtension({
    registerTool(definition: any) {
      tool = definition;
    },
  } as any);
  return tool;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ls", () => {
  test("declares the implemented integer limit range", () => {
    const schema = lsTool().parameters;
    expect(Check(schema, {})).toBe(true);
    expect(Check(schema, { limit: 1 })).toBe(true);
    expect(Check(schema, { limit: 500 })).toBe(true);
    expect(Check(schema, { limit: 0 })).toBe(false);
    expect(Check(schema, { limit: 1.5 })).toBe(false);
    expect(Check(schema, { limit: 501 })).toBe(false);
  });

  test("accepts file URLs and returns built-in-compatible entry limit details", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "b"));

    const result = await lsTool().execute(
      "ls-file-url",
      { path: pathToFileURL(root).href, limit: 1 },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.content[0].text).toContain("a.txt");
    expect(result.details).toEqual({ entryLimitReached: 1 });
  });

  test("returns built-in-compatible byte truncation details", async () => {
    const root = temporaryRoot();
    for (let index = 0; index < 100; index += 1) {
      const name = `${String(index).padStart(3, "0")}-${"x".repeat(140)}`;
      writeFileSync(join(root, name), "");
    }

    const result = await lsTool().execute(
      "ls-truncated",
      { path: root, limit: 500 },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.details?.entryLimitReached).toBeUndefined();
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details).not.toHaveProperty("total");
    expect(result.details).not.toHaveProperty("shown");
  });
});
