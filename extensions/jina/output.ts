import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export function truncateJinaMarkdown(text: string): {
  text: string;
  truncated: boolean;
} {
  const notice = `[Markdown output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`;
  const suffix = `\n\n${notice}`;
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
    maxLines: DEFAULT_MAX_LINES - 2,
  });

  return truncation.truncated
    ? { text: truncation.content + suffix, truncated: true }
    : { text, truncated: false };
}
