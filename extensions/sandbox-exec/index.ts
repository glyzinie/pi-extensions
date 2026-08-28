import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  BashOperations,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROTOCOL_VERSION = 1;

const EVENTS = {
  discover: "pi-bash:discover",
  registerBackend: "pi-bash:register-backend",
} as const;

interface SandboxPaths {
  launchCwd: string;
  executionRoots: string[];
  writableRoots: string[];
  /** Files directly under this directory are writable, but subdirectories are not. */
  writableDirectChildRoot?: string;
}

function canonical(path: string): string {
  return realpathSync(resolve(path));
}

function canonicalOrResolve(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? canonical(resolved) : resolved;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => canonicalOrResolve(path)))];
}

function resolveSandboxPaths(launchCwd: string): SandboxPaths {
  const home = canonical(homedir());
  const cwd = canonical(launchCwd);
  const extraRoots = uniquePaths([
    resolve(home, ".pi", "agent"),
    resolve(home, ".codex"),
  ]);

  if (cwd === home) {
    return {
      launchCwd: cwd,
      executionRoots: [home],
      writableRoots: extraRoots,
      writableDirectChildRoot: home,
    };
  }

  return {
    launchCwd: cwd,
    executionRoots: uniquePaths([cwd, ...extraRoots]),
    writableRoots: uniquePaths([cwd, ...extraRoots]),
  };
}

function directChildWriteRule(root: string): string {
  const pattern = `^${escapeRegex(root)}/[^/]+$`;
  return `(allow file-write* (regex ${JSON.stringify(pattern)}))`;
}

function profile(paths: SandboxPaths): string {
  const tempRoots = uniquePaths([
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/private/var/tmp",
  ]);

  const writableFilters = uniquePaths([...paths.writableRoots, ...tempRoots])
    .map((root) => `  (subpath ${JSON.stringify(root)})`)
    .join("\n");

  const directChildRule = paths.writableDirectChildRoot
    ? `\n${directChildWriteRule(paths.writableDirectChildRoot)}`
    : "";

  return `
(version 1)
(deny default)
(import "bsd.sb")

(allow process-fork)
(allow process-exec)
(allow signal (target self))
(deny process-info*)
(allow process-info* (target self))

; Permission policy decides intent. Seatbelt is the final write boundary.
(allow file-read*)
(allow network*)

(allow file-write*
${writableFilters})${directChildRule}
`;
}

function createSandboxOperations(paths: SandboxPaths): BashOperations {
  const sandboxProfile = profile(paths);

  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (process.platform !== "darwin") {
        return Promise.reject(
          new Error("pi-sandbox-exec supports macOS only"),
        );
      }

      const current = canonical(cwd);
      if (!paths.executionRoots.some((root) => isInside(current, root))) {
        return Promise.reject(
          new Error(`bash cwd is outside sandbox execution roots: ${current}`),
        );
      }

      return new Promise((resolvePromise, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        const child = spawn(
          SANDBOX_EXEC,
          ["-p", sandboxProfile, "/bin/bash", "-c", command],
          {
            cwd: current,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
        };

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };

        const kill = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Process already exited.
            }
          }
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        if (signal?.aborted) kill();
        else signal?.addEventListener("abort", kill, { once: true });

        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }

        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => {
          finish(() => {
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolvePromise({ exitCode: code });
          });
        });
      });
    },
  };
}

export default function sandboxExec(pi: ExtensionAPI): void {
  let sandboxPaths: SandboxPaths | undefined;

  const register = () => {
    if (process.platform !== "darwin" || !sandboxPaths) return;

    pi.events.emit(EVENTS.registerBackend, {
      protocolVersion: PROTOCOL_VERSION,
      backend: {
        id: "sandbox-exec",
        priority: 100,
        operations: createSandboxOperations(sandboxPaths),
      },
    });
  };

  pi.events.on(EVENTS.discover, (data) => {
    if (
      typeof data === "object" &&
      data !== null &&
      (data as any).protocolVersion === PROTOCOL_VERSION
    ) {
      register();
    }
  });

  pi.on("session_start", (_event, ctx) => {
    sandboxPaths = resolveSandboxPaths(ctx.cwd);
    register();
  });
}
