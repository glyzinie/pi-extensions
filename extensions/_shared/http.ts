export interface FetchTextOptions {
  timeoutMs: number;
  maxBytes: number;
  timeoutMessage: string;
  signal?: AbortSignal;
}

export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message: string) {
    super(message);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
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
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function fetchTextWithLimits(
  input: string | URL,
  init: RequestInit,
  options: FetchTextOptions,
): Promise<{ response: Response; bodyText: string }> {
  const controller = new AbortController();
  const timeoutError = new RequestTimeoutError(
    options.timeoutMs,
    options.timeoutMessage,
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, options.timeoutMs);

  const abortFromOuter = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) abortFromOuter();
    else options.signal.addEventListener("abort", abortFromOuter, { once: true });
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const bodyText = await readResponseText(response, options.maxBytes);
    return { response, bodyText };
  } catch (error) {
    if (timedOut && !options.signal?.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromOuter);
  }
}
