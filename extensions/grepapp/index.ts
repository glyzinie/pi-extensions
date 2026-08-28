import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SEARCH_URL = "https://grep.app/api/search";
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 5;
const MAX_SNIPPET_CHARS = 1_500;
const MAX_OUTPUT_CHARS = 12_000;

type RawField = string | { raw?: string } | null | undefined;

type GrepAppHit = {
  repo?: RawField;
  path?: RawField;
  branch?: RawField;
  content?: { snippet?: string };
};

type GrepAppResponse = {
  hits?: {
    total?: number;
    hits?: GrepAppHit[];
  };
};

function raw(value: RawField): string {
  if (typeof value === "string") return value;
  return value?.raw ?? "";
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
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(Number.parseInt(n, 16)),
    )
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name] ?? entity);
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

function combinedSignal(signal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("grep.app request timed out")),
    REQUEST_TIMEOUT_MS,
  );

  const onAbort = () => controller.abort(signal?.reason);

  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchSearch(
  url: URL,
  signal?: AbortSignal,
): Promise<GrepAppResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const abort = combinedSignal(signal);

    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "pi-grepapp/0.2",
        },
        signal: abort.signal,
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        const error = new Error(
          `grep.app HTTP ${response.status}${body ? `: ${body}` : ""}`,
        );

        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          lastError = error;
          continue;
        }

        throw error;
      }

      return (await response.json()) as GrepAppResponse;
    } catch (error) {
      if (signal?.aborted || abort.signal.aborted || attempt === 1) throw error;
      lastError = error;
    } finally {
      abort.cleanup();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("grep.app search failed");
}

function formatResults(response: GrepAppResponse, limit: number): string {
  const hits = response.hits?.hits ?? [];
  const selected = hits.slice(0, limit);
  const total = response.hits?.total ?? hits.length;

  if (selected.length === 0) return "No matches.";

  const blocks = selected.map((hit, index) => {
    const repo = raw(hit.repo) || "?";
    const path = raw(hit.path) || "?";
    const branch = raw(hit.branch);
    const location = `${repo}:${path}${branch ? `@${branch}` : ""}`;
    const snippet = snippetToText(hit.content?.snippet ?? "").slice(
      0,
      MAX_SNIPPET_CHARS,
    );

    return snippet ? `[${index + 1}] ${location}\n${snippet}` : `[${index + 1}] ${location}`;
  });

  const output = [
    `${total} match${total === 1 ? "" : "es"}; showing ${selected.length}.`,
    "",
    blocks.join("\n\n"),
  ].join("\n");

  if (output.length <= MAX_OUTPUT_CHARS) return output;

  const truncated = output.slice(0, MAX_OUTPUT_CHARS).replace(/\n[^\n]*$/, "");
  return `${truncated}\n[truncated]`;
}

export default function grepAppExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gh_code_search",
    label: "GitHub Code Search",
    description: "Search public GitHub code via grep.app.",
    promptSnippet: "Search public GitHub code",

    parameters: Type.Object({
      query: Type.String(),
      repo: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      lang: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
      regex: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),

    async execute(_toolCallId, params, signal) {
      const url = new URL(SEARCH_URL);
      url.searchParams.set("q", params.query);
      url.searchParams.set("page", "1");

      if (params.repo) url.searchParams.set("f.repo.pattern", params.repo);
      if (params.path) url.searchParams.set("f.path.pattern", params.path);
      for (const lang of params.lang ?? []) {
        url.searchParams.append("f.lang", lang);
      }
      if (params.regex) url.searchParams.set("regexp", "true");

      const response = await fetchSearch(url, signal);
      const limit = params.limit ?? DEFAULT_LIMIT;
      const text = formatResults(response, limit);

      return {
        content: [{ type: "text", text }],
        details: {
          provider: "grep.app",
          total: response.hits?.total ?? response.hits?.hits?.length ?? 0,
          shown: Math.min(response.hits?.hits?.length ?? 0, limit),
        },
      };
    },
  });
}
