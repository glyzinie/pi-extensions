import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_MAX_CHARS = 50_000;
const MAX_MAX_CHARS = 200_000;
const REQUEST_TIMEOUT_MS = 35_000;

type JinaPayload = {
  data?: {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    publishedTime?: unknown;
    published_time?: unknown;
  };
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function normalizeTargetUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  const suffix = "\n\n[Markdown output truncated.]";
  const output = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix),
    maxLines: DEFAULT_MAX_LINES - 2,
  });

  return output.truncated
    ? { text: output.content + suffix, truncated: true }
    : { text, truncated: false };
}

export default function piJina(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Read a public HTTP/HTTPS URL through Jina Reader and return clean Markdown. Use web_search first when you need to discover URLs. Output is capped at 50KB or 2000 lines.",
    parameters: Type.Object({
      url: Type.String({
        description: "Public HTTP or HTTPS URL to read.",
        minLength: 1,
      }),
      max_chars: Type.Optional(
        Type.Integer({
          description: `Maximum content characters before the tool-output cap (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}).`,
          minimum: 1_000,
          maximum: MAX_MAX_CHARS,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const target = normalizeTargetUrl(params.url);
      if (!target) {
        throw new Error(
          "web_fetch requires a valid http:// or https:// URL without embedded credentials.",
        );
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Return-Format": "markdown",
        "X-Retain-Images": "none",
        "X-Timeout": "20",
      };
      const apiKey = process.env.JINA_API_KEY?.trim();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const response = await fetch(`${JINA_READER_BASE}${target.toString()}`, {
        headers,
        signal: requestSignal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_000).trim();
        throw new Error(
          `Jina Reader API error ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`,
        );
      }

      const payload = await response.json() as JinaPayload;
      const data = payload.data;
      const content = cleanText(data?.content);
      if (!content) {
        return {
          content: [{ type: "text" as const, text: "Jina Reader returned no readable content." }],
          details: {
            provider: "jina-reader",
            url: target.toString(),
            truncated: false,
          },
        };
      }

      const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS;
      const contentTruncated = content.length > maxChars;
      const returnedContent = contentTruncated
        ? content.slice(0, maxChars)
        : content;
      const title = cleanText(data?.title);
      const resolvedUrl = cleanText(data?.url) ?? target.toString();
      const published = cleanText(data?.publishedTime ?? data?.published_time);
      const lines: string[] = [];
      if (title) lines.push(`Title: ${title}`);
      lines.push(`URL: ${resolvedUrl}`);
      if (published) lines.push(`Published: ${published}`);
      lines.push("", returnedContent);
      if (contentTruncated) {
        lines.push("", `[Content truncated at ${maxChars} characters.]`);
      }

      const output = truncateOutput(lines.join("\n"));
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          provider: "jina-reader",
          url: resolvedUrl,
          truncated: contentTruncated || output.truncated,
        },
      };
    },
  });
}
