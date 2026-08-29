import { readFile } from "node:fs/promises";

import type { PermissionRequest } from "./protocol.ts";
import type { PermissionLanguage } from "./ui.ts";

const MAX_RULE_FILE_BYTES = 64 * 1024;
const MAX_RULES = 256;
const DECISIONS = new Set(["allow", "review", "human", "deny"] as const);

export type PermissionRuleDecision = "allow" | "review" | "human" | "deny";

export interface PermissionRule {
  tool: string;
  actions?: readonly string[];
  decision: PermissionRuleDecision;
}

export interface PermissionRuleMatch {
  rule: PermissionRule;
  action?: string;
}

export interface PermissionConfig {
  language: PermissionLanguage;
  rules: readonly PermissionRule[];
}

export interface LoadedPermissionRules extends PermissionConfig {
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parsePermissionConfig(text: string): PermissionConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_RULE_FILE_BYTES) {
    throw new Error(`permission.json exceeds ${MAX_RULE_FILE_BYTES} bytes`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !exactKeys(parsed, ["version", "language", "rules"])) {
    throw new Error("permission.json contains unknown top-level fields");
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.rules)) {
    throw new Error("permission.json requires version 1 and a rules array");
  }
  const language = parsed.language ?? "en";
  if (language !== "en" && language !== "ja") {
    throw new Error("permission.json language must be en or ja");
  }
  if (parsed.rules.length > MAX_RULES) {
    throw new Error(`permission.json supports at most ${MAX_RULES} rules`);
  }

  const rules: PermissionRule[] = [];
  const exact = new Set<string>();
  const exactTools = new Set<string>();
  const allActions = new Set<string>();
  for (const [index, value] of parsed.rules.entries()) {
    if (!isRecord(value) || !exactKeys(value, ["tool", "actions", "decision"])) {
      throw new Error(`rules[${index}] has unknown fields`);
    }
    if (
      typeof value.tool !== "string" ||
      value.tool.length === 0 ||
      value.tool.length > 200 ||
      typeof value.decision !== "string" ||
      !DECISIONS.has(value.decision as PermissionRuleDecision)
    ) {
      throw new Error(`rules[${index}] has an invalid tool or decision`);
    }

    let actions: string[] | undefined;
    if (value.actions !== undefined) {
      if (
        !Array.isArray(value.actions) ||
        value.actions.length === 0 ||
        value.actions.length > 64 ||
        !value.actions.every((action) =>
          typeof action === "string" && action.length > 0 && action.length <= 100,
        )
      ) {
        throw new Error(`rules[${index}].actions must be a non-empty string array`);
      }
      actions = [...new Set(value.actions as string[])];
      if (actions.length !== value.actions.length) {
        throw new Error(`rules[${index}].actions contains duplicates`);
      }
    }

    if (!actions) {
      if (allActions.has(value.tool) || exactTools.has(value.tool)) {
        throw new Error(`rules[${index}] overlaps another rule for ${value.tool}`);
      }
      allActions.add(value.tool);
    } else {
      if (allActions.has(value.tool)) {
        throw new Error(`rules[${index}] overlaps an all-action rule for ${value.tool}`);
      }
      for (const action of actions) {
        const key = `${value.tool}\0${action}`;
        if (exact.has(key)) throw new Error(`rules[${index}] duplicates ${value.tool}:${action}`);
        exact.add(key);
        exactTools.add(value.tool);
      }
    }

    rules.push(Object.freeze({
      tool: value.tool,
      ...(actions ? { actions: Object.freeze(actions) } : {}),
      decision: value.decision as PermissionRuleDecision,
    }));
  }
  return { language, rules: Object.freeze(rules) };
}

export function parsePermissionRules(text: string): readonly PermissionRule[] {
  return parsePermissionConfig(text).rules;
}

export async function loadPermissionRules(path: string): Promise<LoadedPermissionRules> {
  try {
    return parsePermissionConfig(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { language: "en", rules: [] };
    }
    return {
      language: "en",
      rules: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function matchPermissionRule(
  request: PermissionRequest,
  rules: readonly PermissionRule[],
): PermissionRuleMatch | undefined {
  const action = typeof request.input.action === "string"
    ? request.input.action
    : undefined;
  for (const rule of rules) {
    if (rule.tool !== request.toolName) continue;
    if (!rule.actions || (action !== undefined && rule.actions.includes(action))) {
      return { rule, action };
    }
  }
  return undefined;
}
