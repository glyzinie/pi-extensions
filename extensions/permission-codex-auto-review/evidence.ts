import type {
  PermissionAnalysis,
  PermissionRequest,
  PermissionReviewPolicy,
} from "../permission/protocol.ts";
import {
  BASH_ANALYSIS_KIND,
  type BashTreeSitterAnalysis,
} from "../permission-tree-sitter-bash/types.ts";

const MAX_STRING = 8_000;
const MAX_ARRAY = 40;
const MAX_KEYS = 80;
const MAX_DEPTH = 6;
const MAX_EVIDENCE_BYTES = 32_000;
const SECRET_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]+|(?:^|[\s;&])(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY))\s*=\s*[^\s;&]+|["']?(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)["']?\s*:\s*["'][^"']+["']|\bsk-[A-Za-z0-9_-]{16,}|https?:\/\/[^\s/:]+:[^\s/@]+@/im;

interface ProjectionState {
  unsafe: boolean;
  seen: WeakSet<object>;
}

function projectValue(
  value: unknown,
  state: ProjectionState,
  depth = 0,
  key = "",
): unknown {
  if (SECRET_KEY.test(key)) {
    state.unsafe = true;
    return "[redacted]";
  }
  if (typeof value === "string") {
    if (SECRET_TEXT.test(value)) {
      state.unsafe = true;
      return "[redacted secret-bearing string]";
    }
    if (value.length > MAX_STRING) {
      state.unsafe = true;
      return `${value.slice(0, MAX_STRING)}…`;
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH || state.seen.has(value)) {
    state.unsafe = true;
    return "[omitted]";
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) state.unsafe = true;
    return value.slice(0, MAX_ARRAY).map((item) => projectValue(item, state, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) state.unsafe = true;
  return Object.fromEntries(
    entries.slice(0, MAX_KEYS).map(([entryKey, item]) => [
      entryKey,
      projectValue(item, state, depth + 1, entryKey),
    ]),
  );
}

function projectBashAnalysis(data: unknown): unknown {
  if (!data || typeof data !== "object") return undefined;
  const analysis = data as Partial<BashTreeSitterAnalysis>;
  return {
    complete: analysis.complete,
    dynamic: analysis.dynamic,
    opaque: analysis.opaque,
    background: analysis.background,
    commands: analysis.commands?.map((command) => ({ argv: command.resolvedArgv })),
    redirects: analysis.commands?.flatMap((command) => command.redirects),
    writeTargets: analysis.writeTargets,
    writeTargetsComplete: analysis.writeTargetsComplete,
    warnings: analysis.warnings,
  };
}

export interface ReviewEvidence {
  safeForAutoReview: boolean;
  value: unknown;
}

export function buildReviewEvidence(
  request: PermissionRequest,
  policy: PermissionReviewPolicy,
  analyses: readonly PermissionAnalysis[],
): ReviewEvidence {
  const state: ProjectionState = { unsafe: false, seen: new WeakSet() };
  const projectedInput = projectValue(request.input, state, 0, "input");
  const projectedDetails = projectValue(policy.details, state, 0, "details");
  const value = {
    request: {
      toolName: request.toolName,
      ...(request.originalToolName !== request.toolName
        ? { originalToolName: request.originalToolName }
        : {}),
      source: request.source,
      cwd: request.cwd,
      input: projectedInput,
    },
    policy: {
      ruleId: policy.ruleId,
      reason: policy.reason,
      details: projectedDetails,
    },
    analyses: analyses.map((analysis) => ({
      analyzer: analysis.analyzer,
      kind: analysis.kind,
      data: analysis.kind === BASH_ANALYSIS_KIND
        ? projectValue(projectBashAnalysis(analysis.data), state, 0, "analysis")
        : undefined,
      warnings: projectValue(analysis.warnings, state, 0, "warnings"),
    })),
  };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) state.unsafe = true;
  return { safeForAutoReview: !state.unsafe, value };
}
