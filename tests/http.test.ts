import { afterEach, describe, expect, test } from "bun:test";

import {
  fetchTextWithLimits,
  RequestTimeoutError,
  ResponseBodyTooLargeError,
} from "../extensions/_shared/http.ts";

const originalFetch = globalThis.fetch;
type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

function mockFetch(implementation: FetchImplementation): void {
  globalThis.fetch = implementation as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchTextWithLimits", () => {
  test("returns a response body within the byte limit", async () => {
    mockFetch(async () => new Response("hello"));

    const result = await fetchTextWithLimits("https://example.test", {}, {
      timeoutMs: 1_000,
      maxBytes: 5,
      timeoutMessage: "timed out",
    });

    expect(result.bodyText).toBe("hello");
  });

  test("rejects a declared oversized response before reading it", async () => {
    mockFetch(async () =>
      new Response("ignored", {
        headers: { "content-length": "100" },
      }),
    );

    await expect(
      fetchTextWithLimits("https://example.test", {}, {
        timeoutMs: 1_000,
        maxBytes: 10,
        timeoutMessage: "timed out",
      }),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  test("rejects a chunked response that exceeds the byte limit", async () => {
    mockFetch(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("123456"));
            controller.close();
          },
        }),
      ),
    );

    await expect(
      fetchTextWithLimits("https://example.test", {}, {
        timeoutMs: 1_000,
        maxBytes: 5,
        timeoutMessage: "timed out",
      }),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  test("reports request timeouts with a typed error", async () => {
    mockFetch((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectFromAbort = () => reject(signal?.reason);
        if (signal?.aborted) rejectFromAbort();
        else signal?.addEventListener("abort", rejectFromAbort, { once: true });
      }),
    );

    await expect(
      fetchTextWithLimits("https://example.test", {}, {
        timeoutMs: 10,
        maxBytes: 100,
        timeoutMessage: "request timed out",
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  test("preserves an outer abort reason", async () => {
    mockFetch((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectFromAbort = () => reject(signal?.reason);
        if (signal?.aborted) rejectFromAbort();
        else signal?.addEventListener("abort", rejectFromAbort, { once: true });
      }),
    );

    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);

    await expect(
      fetchTextWithLimits("https://example.test", {}, {
        timeoutMs: 1_000,
        maxBytes: 100,
        timeoutMessage: "request timed out",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
