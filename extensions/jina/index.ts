import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { fetchTextWithLimits } from "../_shared/http.ts";
import { truncateJinaMarkdown } from "./output.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_CHARS = 50_000;
const MAX_MAX_CHARS = 200_000;
const REQUEST_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS = 2_000;

type FetchParams = {
  url: string;
  max_chars?: number;
};

type JinaPayload = {
  data?: {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    publishedTime?: unknown;
    published_time?: unknown;
  };
};

function textContent(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function normalizeTargetUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    // Do not forward credentials embedded in a URL to a third-party reader.
    if (url.username || url.password) return null;

    // URL fragments are client-side only and would become a fragment on r.jina.ai.
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export default function piJina(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Read a public HTTP/HTTPS URL through Jina Reader and return clean Markdown suitable for analysis. Use web_search first when you need to discover URLs.",
    parameters: Type.Object({
      url: Type.String({
        description: "Public HTTP or HTTPS URL to read.",
        minLength: 1,
      }),
      max_chars: Type.Optional(
        Type.Integer({
          description: `Maximum Markdown characters returned (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}).`,
          minimum: 1_000,
          maximum: MAX_MAX_CHARS,
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: FetchParams,
      signal?: AbortSignal,
    ) {
      const target = normalizeTargetUrl(params.url);
      if (!target) {
        throw new Error(
          "web_fetch requires a valid public http:// or https:// URL without embedded credentials.",
        );
      }

      const maxChars = Math.max(
        1_000,
        Math.min(MAX_MAX_CHARS, params.max_chars ?? DEFAULT_MAX_CHARS),
      );

      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Return-Format": "markdown",
        "X-Retain-Images": "none",
        "X-Timeout": "20",
      };

      const apiKey = process.env.JINA_API_KEY?.trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let response: Response;
      let bodyText: string;
      try {
        ({ response, bodyText } = await fetchTextWithLimits(
          `${JINA_READER_BASE}${target.toString()}`,
          { method: "GET", headers },
          {
            timeoutMs: REQUEST_TIMEOUT_MS,
            maxBytes: MAX_RESPONSE_BYTES,
            timeoutMessage: `Jina Reader request timed out after ${REQUEST_TIMEOUT_MS}ms`,
            signal,
          },
        ));
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Jina Reader request failed: ${message}`);
      }
      if (!response.ok) {
        const body = bodyText.slice(0, MAX_ERROR_BODY_CHARS).trim();
        throw new Error(
          `Jina Reader API error ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`,
        );
      }

      let payload: JinaPayload;
      try {
        payload = JSON.parse(bodyText) as JinaPayload;
      } catch {
        throw new Error("Jina Reader returned an invalid JSON response.");
      }

      const data = payload.data;
      const content = cleanText(data?.content);
      if (!content) return textContent("Jina Reader returned no readable content.");

      const title = cleanText(data?.title);
      const resolvedUrl = cleanText(data?.url) ?? target.toString();
      const published = cleanText(data?.publishedTime ?? data?.published_time);

      const truncated = content.length > maxChars;
      const returnedContent = truncated ? content.slice(0, maxChars) : content;

      const lines: string[] = [];
      if (title) lines.push(`Title: ${title}`);
      lines.push(`URL: ${resolvedUrl}`);
      if (published) lines.push(`Published: ${published}`);
      lines.push("", returnedContent);

      if (truncated) {
        lines.push(
          "",
          `[Content truncated at ${maxChars.toLocaleString()} characters; original length ${content.length.toLocaleString()} characters.]`,
        );
      }

      const output = truncateJinaMarkdown(lines.join("\n"));

      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          provider: "jina-reader",
          url: resolvedUrl,
          title,
          published,
          truncated: truncated || output.truncated,
          original_chars: content.length,
          returned_chars: returnedContent.length,
          output_truncated: output.truncated,
        },
      };
    },
  });
}
