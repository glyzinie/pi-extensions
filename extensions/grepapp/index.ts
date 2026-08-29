import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_URL = "https://grep.app/api/search";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5;
const MAX_SNIPPET_CHARS = 1_500;

type RawField = string | { raw?: string } | null | undefined;
type GrepAppHit = {
  repo?: RawField;
  path?: RawField;
  branch?: RawField;
  content?: { snippet?: string };
};
type GrepAppResponse = {
  hits?: { total?: number; hits?: GrepAppHit[] };
};

function raw(value: RawField): string {
  return typeof value === "string" ? value : value?.raw ?? "";
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value
    .replace(/&#(\d+);/g, (entity, value: string) => {
      const codePoint = Number(value);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&#x([0-9a-f]+);/gi, (entity, value: string) => {
      const codePoint = Number.parseInt(value, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(
      /&([a-z]+);/gi,
      (entity, name: string) => named[name.toLowerCase()] ?? entity,
    );
}

function snippetToText(snippet: string): string {
  return decodeHtml(
    snippet
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|pre|tr|td|li)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  const suffix = "\n\n[Search output truncated.]";
  const output = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix),
    maxLines: DEFAULT_MAX_LINES - 2,
  });

  return output.truncated
    ? { text: output.content + suffix, truncated: true }
    : { text, truncated: false };
}

function formatResults(response: GrepAppResponse, limit: number) {
  const hits = response.hits?.hits ?? [];
  const selected = hits.slice(0, limit);
  const total = response.hits?.total ?? hits.length;

  if (selected.length === 0) {
    return { text: "No matches.", total, shown: 0, truncated: false };
  }

  const blocks = selected.map((hit, index) => {
    const repo = raw(hit.repo) || "?";
    const path = raw(hit.path) || "?";
    const branch = raw(hit.branch);
    const location = `${repo}:${path}${branch ? `@${branch}` : ""}`;
    const fullSnippet = snippetToText(hit.content?.snippet ?? "");
    const snippet = fullSnippet.length > MAX_SNIPPET_CHARS
      ? `${fullSnippet.slice(0, MAX_SNIPPET_CHARS)}…`
      : fullSnippet;

    return snippet
      ? `[${index + 1}] ${location}\n${snippet}`
      : `[${index + 1}] ${location}`;
  });

  const output = truncateOutput(
    `${total} match${total === 1 ? "" : "es"}; showing ${selected.length}.\n\n${blocks.join("\n\n")}`,
  );
  return { ...output, total, shown: selected.length };
}

export default function grepAppExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gh_code_search",
    label: "GitHub Code Search",
    description:
      "Search public GitHub code via grep.app. Output is truncated to 50KB or 2000 lines.",
    promptSnippet: "Search public GitHub code",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      repo: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      lang: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
      regex: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),

    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (!query) throw new Error("Search query must not be empty.");

      const url = new URL(SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("page", "1");
      if (params.repo) url.searchParams.set("f.repo.pattern", params.repo);
      if (params.path) url.searchParams.set("f.path.pattern", params.path);
      for (const lang of params.lang ?? []) url.searchParams.append("f.lang", lang);
      if (params.regex) url.searchParams.set("regexp", "true");

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "pi-grepapp/0.2",
        },
        signal: requestSignal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500).trim();
        throw new Error(
          `grep.app HTTP ${response.status}${body ? `: ${body}` : ""}`,
        );
      }

      const payload = await response.json() as GrepAppResponse;
      const output = formatResults(payload, params.limit ?? DEFAULT_LIMIT);
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          provider: "grep.app",
          total: output.total,
          shown: output.shown,
          truncated: output.truncated,
        },
      };
    },
  });
}
