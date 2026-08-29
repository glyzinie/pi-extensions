import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateTrashPath } from "../extensions/trash/index.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryRoots.push(root);
  return realpathSync(root);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("validateTrashPath", () => {
  test("resolves workspace paths and strips the model-facing @ prefix", () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const target = join(workspace, "file.txt");
    writeFileSync(target, "test");

    expect(validateTrashPath("file.txt", workspace)).toBe(target);
    expect(validateTrashPath("@file.txt", workspace)).toBe(target);
  });

  test("rejects the workspace root and paths outside it", () => {
    const workspace = temporaryRoot("pi-trash-workspace");

    expect(() => validateTrashPath(".", workspace)).toThrow(
      "Refusing to trash the workspace root",
    );
    expect(() => validateTrashPath("../outside", workspace)).toThrow(
      "Refusing to trash path outside workspace",
    );
  });

  test("allows a final symlink but rejects a symlinked parent outside workspace", () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const outside = temporaryRoot("pi-trash-outside");
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside");

    const finalLink = join(workspace, "final-link");
    symlinkSync(outsideFile, finalLink);
    expect(validateTrashPath("final-link", workspace)).toBe(finalLink);

    const linkedParent = join(workspace, "linked-parent");
    symlinkSync(outside, linkedParent, "dir");
    expect(() =>
      validateTrashPath(join(workspace, "linked-parent", "outside.txt"), workspace)
    ).toThrow("Refusing path through symlinked parent outside workspace");
  });
});
