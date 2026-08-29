import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TRASH = "/usr/bin/trash";

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function selectTopLevelTrashEntries(
  entries: ReadonlyMap<string, string>,
): Map<string, string> {
  const values = [...entries];
  return new Map(values.filter(([target]) =>
    !values.some(([parent]) => parent !== target && isInside(target, parent))
  ));
}

export function validateTrashPath(input: string, workspace: string): string {
  const value = input.startsWith("@") ? input.slice(1) : input;
  const target = resolve(workspace, value);

  if (!isInside(target, workspace)) {
    throw new Error(`Refusing to trash path outside workspace: ${input}`);
  }
  if (target === workspace) throw new Error("Refusing to trash the workspace root");

  lstatSync(target); // Check existence without dereferencing the final symlink.
  const parent = realpathSync(dirname(target));
  if (!isInside(parent, workspace)) {
    throw new Error(`Refusing path through symlinked parent outside workspace: ${input}`);
  }
  return resolve(parent, basename(target));
}

export default function trashExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "trash",
    label: "trash",
    description: "Move files or directories inside the current workspace to the macOS Trash.",
    promptSnippet: "Move workspace files or directories to the macOS Trash",
    promptGuidelines: [
      "Use trash instead of bash rm or rmdir when deleting files or directories inside the workspace.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 100,
        description: "Workspace-relative or absolute paths to move to Trash. Globs are not expanded.",
      }),
    }),
    executionMode: "sequential",

    async execute(_id, { paths }, signal, _onUpdate, ctx) {
      if (process.platform !== "darwin" || !existsSync(TRASH)) {
        throw new Error("trash requires macOS 15 or later");
      }

      const workspace = realpathSync(ctx.cwd);
      const entries = new Map<string, string>();
      for (const input of paths) {
        const target = validateTrashPath(input, workspace);
        if (!entries.has(target)) entries.set(target, input);
      }

      const selectedEntries = selectTopLevelTrashEntries(entries);
      const targets = [...selectedEntries.keys()];
      const result = await pi.exec(TRASH, ["-s", ...targets], {
        cwd: workspace,
        signal,
      });
      if (result.killed) {
        throw new Error(signal?.aborted ? "trash aborted" : "trash was terminated");
      }
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `trash exited with code ${result.code}`);
      }

      const moved = [...selectedEntries.values()];
      const shown = moved.slice(0, 10);
      const omitted = moved.length - shown.length;
      const covered = entries.size - selectedEntries.size;
      const summary = shown.map((path) => `- ${path}`).join("\n") +
        (omitted > 0 ? `\n- …and ${omitted} more` : "") +
        (covered > 0
          ? `\n(${covered} nested path${covered === 1 ? "" : "s"} covered by a parent path.)`
          : "");

      return {
        content: [{ type: "text" as const, text: `Moved to Trash:\n${summary}` }],
        details: { paths: targets },
      };
    },
  });
}
