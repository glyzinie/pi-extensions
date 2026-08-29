import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type LsToolDetails,
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
    Type.Integer({
      description: `Maximum entries to return (default: ${DEFAULT_LIMIT}, max: ${HARD_LIMIT})`,
      minimum: 1,
      maximum: HARD_LIMIT,
    }),
  ),
});

function resolvePath(input: string | undefined, cwd: string): string {
  if (!input || input === ".") return cwd;

  const normalized = input.startsWith("@") ? input.slice(1) : input;
  if (!normalized || normalized === ".") return cwd;
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) {
    return resolve(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) return fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function displayEntryName(name: string): string {
  return JSON.stringify(name).slice(1, -1);
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
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

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

      const selected = entries.slice(0, effectiveLimit);
      const lines = selected.map(
        (entry) => displayEntryName(entry.name) + (entry.isDirectory() ? "/" : ""),
      );

      if (lines.length === 0) {
        return {
          content: [{ type: "text" as const, text: "(empty directory)" }],
          details: undefined,
        };
      }

      const truncation = truncateHead(lines.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: MAX_BYTES,
      });

      const notices: string[] = [];
      const details: LsToolDetails = {};
      if (entries.length > selected.length) {
        const next = Math.min(effectiveLimit * 2, HARD_LIMIT);
        notices.push(
          next > effectiveLimit
            ? `${selected.length}/${entries.length} entries; use limit=${next} for more`
            : `${selected.length}/${entries.length} entries shown`,
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(MAX_BYTES)} output limit reached`);
        details.truncation = truncation;
      }

      const suffix = notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: truncation.content + suffix,
          },
        ],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  });
}
