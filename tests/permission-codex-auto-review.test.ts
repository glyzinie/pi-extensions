import { describe, expect, test } from "bun:test";

import {
  buildReviewEvidence,
  parseReviewResponse,
  resolveCodexReviewModel,
} from "../extensions/permission-codex-auto-review/index.ts";
import type {
  PermissionRequest,
  PermissionReviewPolicy,
} from "../extensions/permission/protocol.ts";

const request: PermissionRequest = {
  toolCallId: "call-1",
  toolName: "write",
  originalToolName: "write",
  input: { path: "/tmp/settings.json", content: "{\"theme\":\"dark\"}" },
  cwd: "/tmp",
  source: "pi",
};
const policy = {
  decision: "review",
  route: "model-then-human",
  ruleId: "protected-config-write",
  reason: "configuration write requires review",
} satisfies PermissionReviewPolicy;

describe("Codex auto-review contract", () => {
  test("accepts only strict low-risk allow shapes", () => {
    expect(parseReviewResponse('{"outcome":"allow"}')).toMatchObject({
      outcome: "allow",
      riskLevel: "low",
    });
    expect(parseReviewResponse('{"outcome":"allow","risk_level":"low","rationale":"bounded"}')).toEqual({
      outcome: "allow",
      riskLevel: "low",
      rationale: "bounded",
    });
  });

  test("rejects prose, missing fields, extra fields, and non-low allows", () => {
    expect(() => parseReviewResponse('```json\n{"outcome":"allow"}\n```')).toThrow();
    expect(() => parseReviewResponse('{"outcome":"allow","risk_level":"typo","rationale":"x"}')).toThrow();
    expect(() => parseReviewResponse('{"outcome":"allow","risk_level":"medium","rationale":"x"}')).toThrow();
    expect(() => parseReviewResponse('{"outcome":"deny","risk_level":"high"}')).toThrow();
    expect(() => parseReviewResponse('{"outcome":"allow","extra":true}')).toThrow();
  });
});

describe("Codex auto-review model resolution", () => {
  test("uses only the Codex Responses API and synthesizes the review alias", () => {
    const template = {
      id: "gpt-codex",
      name: "Codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_000,
    };
    const ctx = {
      modelRegistry: {
        find: () => undefined,
        getAll: () => [template],
      },
    } as any;
    expect(resolveCodexReviewModel(ctx)).toMatchObject({
      id: "codex-auto-review",
      provider: "openai-codex",
      api: "openai-codex-responses",
    });
  });
});

describe("Codex auto-review evidence", () => {
  test("projects bounded benign evidence", () => {
    const evidence = buildReviewEvidence(request, policy, []);
    expect(evidence.safeForAutoReview).toBe(true);
  });

  test("does not send secret-bearing content or analyzer warnings", () => {
    for (const [content, analyses] of [
      ["-----BEGIN PRIVATE KEY-----\nsecret", []],
      ['{"api_key":"sk-abcdefghijklmnop"}', []],
      ["safe", [{ analyzer: "x", kind: "error", data: null, warnings: ["Bearer abc.def.ghi"] }]],
    ] as const) {
      const evidence = buildReviewEvidence(
        {
          ...request,
          input: { path: "/tmp/auth.json", content },
        },
        policy,
        analyses,
      );
      expect(evidence.safeForAutoReview).toBe(false);
      const serialized = JSON.stringify(evidence.value);
      expect(serialized).not.toContain("PRIVATE KEY");
      expect(serialized).not.toContain("sk-abcdefghijklmnop");
      expect(serialized).not.toContain("abc.def.ghi");
    }
  });
});
