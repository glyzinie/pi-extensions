import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TRASH = "/usr/bin/trash";

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validatePath(input: string, cwd: string, workspace: string): string {
  const target = resolve(cwd, input);

  if (!isInside(target, workspace)) {
    throw new Error(`Refusing to trash path outside workspace: ${input}`);
  }
  if (target === workspace) {
    throw new Error("Refusing to trash the workspace root");
  }

  lstatSync(target); // Require the target to exist; do not dereference a final symlink.

  const parent = realpathSync(dirname(target));
  if (!isInside(parent, workspace)) {
    throw new Error(`Refusing path through symlinked parent outside workspace: ${input}`);
  }

  return target;
}

function runTrash(paths: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TRASH, ["-s", ...paths], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const abort = () => child.kill("SIGKILL");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);

      if (signal?.aborted) {
        reject(new Error("aborted"));
      } else if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(stderr.trim() || `trash exited with code ${code}`));
      }
    });
  });
}

export default function trashExtension(pi: ExtensionAPI) {
  let workspace = realpathSync(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    workspace = realpathSync(ctx.cwd);
  });

  pi.registerTool({
    name: "trash",
    label: "trash",
    description: "Move files or directories inside the current workspace to the macOS Trash. Use this instead of rm for deletions.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Workspace-relative or absolute paths to move to Trash. Globs are not expanded.",
      }),
    }),

    async execute(_id, { paths }, signal, _onUpdate, ctx) {
      if (process.platform !== "darwin") {
        throw new Error("trash tool requires macOS");
      }

      const cwd = realpathSync(ctx.cwd);
      if (!isInside(cwd, workspace)) {
        throw new Error(`Current cwd is outside workspace: ${cwd}`);
      }

      const targets = paths.map((path) => validatePath(path, cwd, workspace));
      await runTrash(targets, signal);

      return {
        content: [{
          type: "text" as const,
          text: `Moved to Trash:\n${paths.map((path) => `- ${path}`).join("\n")}`,
        }],
        details: { paths: targets },
      };
    },
  });
}
