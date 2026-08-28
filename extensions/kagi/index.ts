import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const KAGI_ENDPOINT = "https://kagi.com/api/v1/search";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_CHARS = 2_000;

type SearchParams = {
  query: string;
  limit?: number;
};

type NormalizedResult = {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
};

function textContent(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function cleanInline(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function extractResults(payload: unknown): NormalizedResult[] {
  if (!payload || typeof payload !== "object") return [];

  const root = payload as Record<string, unknown>;
  const data = root.data;

  let candidates: unknown[] = [];

  // Current Kagi v1 shape: { data: { search: [...] } }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const search = (data as Record<string, unknown>).search;
    if (Array.isArray(search)) candidates = search;
  }

  // Defensive compatibility with older/alternate response shapes.
  if (candidates.length === 0 && Array.isArray(data)) {
    candidates = data;
  }

  const results: NormalizedResult[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const result = item as Record<string, unknown>;

    const title = cleanInline(result.title);
    const url = cleanInline(result.url);
    if (!title || !url) continue;

    results.push({
      title,
      url,
      snippet: cleanInline(result.snippet),
      published: cleanInline(
        result.published ?? result.published_at ?? result.publishedAt,
      ),
    });
  }

  return results;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) abortFromOuter();
    else outerSignal.addEventListener("abort", abortFromOuter, { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

export default function piKagi(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web with Kagi. Returns titles, URLs, snippets, and publication dates when available. Use web_fetch to read a result in full.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query.",
        minLength: 1,
      }),
      limit: Type.Optional(
        Type.Integer({
          description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          minimum: 1,
          maximum: MAX_LIMIT,
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: SearchParams,
      signal?: AbortSignal,
    ) {
      const apiKey = process.env.KAGI_API_KEY?.trim();
      if (!apiKey) {
        return textContent(
          "Kagi search is not configured: set KAGI_API_KEY in the environment before starting Pi.",
        );
      }

      const query = params.query?.trim();
      if (!query) return textContent("Search query must not be empty.");

      const limit = Math.max(
        1,
        Math.min(MAX_LIMIT, params.limit ?? DEFAULT_LIMIT),
      );

      let response: Response;
      try {
        response = await fetchWithTimeout(
          KAGI_ENDPOINT,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query,
              workflow: "search",
              limit,
            }),
          },
          REQUEST_TIMEOUT_MS,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return textContent(`Kagi request failed: ${message}`);
      }

      const bodyText = await response.text();
      if (!response.ok) {
        const body = bodyText.slice(0, MAX_ERROR_BODY_CHARS).trim();
        return textContent(
          `Kagi API error ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return textContent("Kagi returned an invalid JSON response.");
      }

      const results = extractResults(payload).slice(0, limit);
      if (results.length === 0) {
        return textContent(`No Kagi search results found for: ${query}`);
      }

      const lines: string[] = [`Kagi search results for: ${query}`, ""];

      for (const [index, result] of results.entries()) {
        lines.push(`${index + 1}. ${result.title}`);
        lines.push(`   URL: ${result.url}`);
        if (result.published) lines.push(`   Published: ${result.published}`);
        if (result.snippet) lines.push(`   ${result.snippet}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
        details: {
          provider: "kagi",
          query,
          count: results.length,
          results,
        },
      };
    },
  });
}
