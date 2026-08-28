import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 500;
const MAX_BYTES = 12 * 1024;

const parameters = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum entries to return (default: ${DEFAULT_LIMIT}, max: ${HARD_LIMIT})`,
    }),
  ),
});

function resolvePath(input: string | undefined, cwd: string): string {
  if (!input || input === ".") return cwd;
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

function normalizeLimit(limit: number | undefined): {
  value: number;
  clamped: boolean;
} {
  if (limit === undefined) return { value: DEFAULT_LIMIT, clamped: false };
  const integer = Math.max(1, Math.floor(limit));
  return {
    value: Math.min(integer, HARD_LIMIT),
    clamped: integer > HARD_LIMIT,
  };
}

export default function lsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ls",
    label: "ls",
    description:
      `List one directory using Node Dirent metadata (no per-entry stat calls). ` +
      `Entries are sorted, directories end with '/', and output is bounded to ` +
      `${DEFAULT_LIMIT} entries by default and ${formatSize(MAX_BYTES)}.`,
    promptSnippet: "List directory contents with bounded output",
    parameters,

    async execute(_id, { path, limit }, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const cwd = ctx?.cwd ?? process.cwd();
      const dirPath = resolvePath(path, cwd);
      const normalized = normalizeLimit(limit);

      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot list directory ${dirPath}: ${message}`);
      }

      if (signal?.aborted) throw new Error("Operation aborted");

      entries.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );

      const selected = entries.slice(0, normalized.value);
      const lines = selected.map((entry) =>
        entry.name + (entry.isDirectory() ? "/" : ""),
      );

      if (lines.length === 0) {
        return {
          content: [{ type: "text" as const, text: "(empty directory)" }],
          details: { total: 0, shown: 0 },
        };
      }

      const truncation = truncateHead(lines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: MAX_BYTES,
      });

      const notices: string[] = [];
      if (normalized.clamped) {
        notices.push(`limit clamped to ${HARD_LIMIT}`);
      }
      if (entries.length > selected.length) {
        const next = Math.min(normalized.value * 2, HARD_LIMIT);
        notices.push(
          next > normalized.value
            ? `${selected.length}/${entries.length} entries; use limit=${next} for more`
            : `${selected.length}/${entries.length} entries shown`,
        );
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(MAX_BYTES)} output limit reached`);
      }

      const suffix = notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: truncation.content + suffix,
          },
        ],
        details: {
          total: entries.length,
          shown: truncation.outputLines,
          truncated: truncation.truncated || entries.length > selected.length,
        },
      };
    },
  });
}
