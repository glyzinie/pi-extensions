import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

const MAX_QUERY_CHARS = 500;
const MAX_TITLE_CHARS = 500;
const MAX_URL_CHARS = 4_000;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_PUBLISHED_CHARS = 100;

export type KagiResult = {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
};

export type KagiOutput = {
  text: string;
  shown: number;
  truncated: boolean;
};

function inline(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${characters.slice(0, maxChars - 1).join("")}…`,
    truncated: true,
  };
}

function lineCount(value: string): number {
  return value.split("\n").length;
}

function resultBlock(result: KagiResult, index: number): {
  text: string;
  truncated: boolean;
} {
  const title = inline(result.title, MAX_TITLE_CHARS);
  const url = inline(result.url, MAX_URL_CHARS);
  const lines = [
    `${index}. ${title.text}`,
    `   URL: ${url.text}`,
  ];
  let truncated = title.truncated || url.truncated;

  if (result.published) {
    const published = inline(result.published, MAX_PUBLISHED_CHARS);
    lines.push(`   Published: ${published.text}`);
    truncated ||= published.truncated;
  }
  if (result.snippet) {
    const snippet = inline(result.snippet, MAX_SNIPPET_CHARS);
    lines.push(`   ${snippet.text}`);
    truncated ||= snippet.truncated;
  }
  return { text: lines.join("\n"), truncated };
}

export function formatKagiOutput(
  query: string,
  results: readonly KagiResult[],
): KagiOutput {
  const notice = `[Search output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`;
  const suffix = `\n\n${notice}`;
  const maxBytes = DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  const maxLines = DEFAULT_MAX_LINES - 2;

  const displayQuery = inline(query, MAX_QUERY_CHARS);
  let text = `Kagi search results for: ${displayQuery.text}`;
  let shown = 0;
  let fieldsTruncated = displayQuery.truncated;

  for (const [index, result] of results.entries()) {
    const block = resultBlock(result, index + 1);
    const candidate = `${text}\n\n${block.text}`;
    if (
      Buffer.byteLength(candidate, "utf8") > maxBytes ||
      lineCount(candidate) > maxLines
    ) {
      break;
    }
    text = candidate;
    shown += 1;
    fieldsTruncated ||= block.truncated;
  }

  const truncated = fieldsTruncated || shown < results.length;
  return {
    text: truncated ? text + suffix : text,
    shown,
    truncated,
  };
}
