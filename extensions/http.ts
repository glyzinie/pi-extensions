import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  timeoutMessage: string;
  signal?: AbortSignal;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function truncateToolOutput(text: string): {
  text: string;
  truncated: boolean;
} {
  const notice = `[Output truncated at ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`;
  const suffix = `\n\n${notice}`;
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
    maxLines: DEFAULT_MAX_LINES - 2,
  });

  return truncation.truncated
    ? { text: truncation.content + suffix, truncated: true }
    : { text, truncated: false };
}

export async function fetchTextWithLimits(
  input: string,
  init: RequestInit,
  options: FetchTextOptions,
): Promise<{ response: Response; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(options.timeoutMessage)),
    options.timeoutMs,
  );

  const abortFromOuter = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) abortFromOuter();
    else options.signal.addEventListener("abort", abortFromOuter, { once: true });
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const bodyText = await readResponseText(response, options.maxBytes);
    return { response, bodyText };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromOuter);
  }
}
