import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KAGI_ENDPOINT = "https://kagi.com/api/v1/search";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

type KagiItem = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  time?: unknown;
};
type KagiPayload = {
  data?: { search?: KagiItem[] };
};
type KagiResult = {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
};

function cleanInline(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\s+/g, " ").trim() || undefined;
}

function extractResults(payload: KagiPayload): KagiResult[] {
  const results: KagiResult[] = [];
  for (const item of payload.data?.search ?? []) {
    const title = cleanInline(item.title);
    const url = cleanInline(item.url);
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet: cleanInline(item.snippet),
      published: cleanInline(item.time),
    });
  }
  return results;
}

function formatResults(query: string, results: readonly KagiResult[]) {
  const lines = [`Kagi search results for: ${query}`];
  for (const [index, result] of results.entries()) {
    lines.push("", `${index + 1}. ${result.title}`, `   URL: ${result.url}`);
    if (result.published) lines.push(`   Published: ${result.published}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  }

  const text = lines.join("\n");
  const suffix = "\n\n[Search output truncated.]";
  const output = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix),
    maxLines: DEFAULT_MAX_LINES - 2,
  });
  return output.truncated
    ? { text: output.content + suffix, truncated: true }
    : { text, truncated: false };
}

export default function piKagi(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web with Kagi. Returns titles, URLs, snippets, and publication dates when available. Use web_fetch to read a result in full. Output is capped at 50KB or 2000 lines.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query.",
        minLength: 1,
        maxLength: MAX_QUERY_CHARS,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          minimum: 1,
          maximum: MAX_LIMIT,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.KAGI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "Kagi search is not configured: set KAGI_API_KEY before starting Pi.",
        );
      }

      const query = params.query.replace(/\s+/g, " ").trim();
      if (!query) throw new Error("Search query must not be empty.");
      const limit = params.limit ?? DEFAULT_LIMIT;
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const response = await fetch(KAGI_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, workflow: "search", limit }),
        signal: requestSignal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_000).trim();
        throw new Error(
          `Kagi API error ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`,
        );
      }

      const payload = await response.json() as KagiPayload;
      const results = extractResults(payload).slice(0, limit);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No Kagi search results found for: ${query}` }],
          details: {
            provider: "kagi",
            query,
            count: 0,
            truncated: false,
          },
        };
      }

      const output = formatResults(query, results);
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          provider: "kagi",
          query,
          count: results.length,
          truncated: output.truncated,
        },
      };
    },
  });
}
