import { describe, expect, test } from "bun:test";

import { analyzeBashSource } from "../extensions/permission-tree-sitter-bash/index.ts";

describe("permission-tree-sitter-bash", () => {
  test("parses a static read-only command", async () => {
    const result = await analyzeBashSource("ls -la");
    expect(result.complete).toBe(true);
    expect(result.dynamic).toBe(false);
    expect(result.opaque).toBe(false);
    expect(result.commands[0]?.resolvedArgv).toEqual(["ls", "-la"]);
    expect(result.writeTargetsComplete).toBe(true);
  });

  test("does not prove commands with environment assignments safe", async () => {
    const result = await analyzeBashSource("PATH=/tmp ls");
    expect(result.dynamic).toBe(true);
    expect(result.writeTargetsComplete).toBe(false);
  });

  test("preserves Bash tilde quote semantics", async () => {
    const unquoted = await analyzeBashSource("touch ~/.pi/agent/file");
    expect(unquoted.writeTargets[0]?.path).toMatchObject({
      value: "~/.pi/agent/file",
      expandTilde: true,
      quoted: false,
    });

    const quoted = await analyzeBashSource("touch '~/literal-file'");
    expect(quoted.writeTargets[0]?.path).toMatchObject({
      value: "~/literal-file",
      expandTilde: false,
      quoted: true,
    });
  });

  test("retains read redirects for credential policy", async () => {
    const result = await analyzeBashSource("cat < ~/.ssh/id_ed25519");
    expect(result.commands[0]?.redirects[0]).toMatchObject({
      operator: "<",
      write: false,
      target: { value: "~/.ssh/id_ed25519", expandTilde: true },
    });
  });

  test("does not trust relative executable aliases or complex utilities", async () => {
    const relative = await analyzeBashSource("./cat file");
    const treeOutput = await analyzeBashSource("tree -o output.txt");
    const treeLongOutput = await analyzeBashSource("tree --output=output.txt");
    const copy = await analyzeBashSource("cp source /outside/destination");
    expect(relative.writeTargetsComplete).toBe(false);
    expect(treeOutput.writeTargetsComplete).toBe(false);
    expect(treeLongOutput.writeTargetsComplete).toBe(false);
    expect(copy.writeTargetsComplete).toBe(false);
  });

  test("treats shell state changes as opaque", async () => {
    for (const command of ["PATH=.; ls", "printf -v PATH .; ls", "cd; cat .ssh/id_ed25519"]) {
      const result = await analyzeBashSource(command);
      expect(result.opaque || result.dynamic).toBe(true);
      expect(result.writeTargetsComplete).toBe(false);
    }
  });

  test("fails closed on syntax errors", async () => {
    const result = await analyzeBashSource("if true; then");
    expect(result.complete).toBe(false);
    expect(result.writeTargetsComplete).toBe(false);
  });
});
