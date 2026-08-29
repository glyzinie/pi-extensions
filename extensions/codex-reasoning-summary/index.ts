import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type SummaryMode = "auto" | "concise" | "detailed";
export type ReasoningDisplayLanguage = "en" | "ja";

const TARGET_API = "openai-codex-responses";
const SUMMARY_MODE: SummaryMode = "auto";
const STATUS_KEY = "codex-reasoning-summary";
const LANGUAGE_COMMAND = "codex-reasoning-summary-language";
const SETTINGS_KEY = "codexReasoningSummary";
const MAX_LABEL_LENGTH = 100;
const MAX_SOURCE_LINE_LENGTH = 512;
const JAPANESE_SUMMARY_INSTRUCTION =
  "ユーザーに表示される reasoning summary を生成する場合、Markdown 見出しを含む要約本文は日本語で記述してください。コード識別子、ファイルパス、コマンド、引用文は原文のままにし、最終回答の言語はユーザーの指定に従ってください。";
const JAPANESE_TEXT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const DEFAULT_JAPANESE_LABEL = "内容を検討中…";
const ENGLISH_STATUS_LABELS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern: /\b(?:summar|finaliz|document|report|conclud|wrap|recap)\w*/i,
    label: "結果を整理中…",
  },
  {
    pattern:
      /\b(?:test|verif|validat|lint|type[\s-]?check|build|built|compil|benchmark)\w*/i,
    label: "動作を検証中…",
  },
  {
    pattern:
      /\b(?:implement|edit|updat|modif|refactor|fix|add|writ|creat|remov|patch|chang|apply|resolv)\w*/i,
    label: "変更を実装中…",
  },
  {
    pattern:
      /\b(?:plan|design|consider|evaluat|decid|prepar|strateg|approach|weigh|choos|think|reason)\w*/i,
    label: "方針を検討中…",
  },
  {
    pattern:
      /\b(?:analy|investigat|inspect|review|read|check|search|explor|look|trac|understand|examin|assess|debug|diagnos)\w*/i,
    label: "情報を確認中…",
  },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sanitizeLabel(value: string): string {
  return value
    // OSC, DCS/SOS/PM/APC, and CSI terminal control sequences.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    // Drop remaining control and Unicode formatting characters, including
    // incomplete escape sequences and bidi controls.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDisplayLanguage(value: unknown): value is ReasoningDisplayLanguage {
  return value === "en" || value === "ja";
}

export function reasoningLanguageFromSettings(
  settings: unknown,
): ReasoningDisplayLanguage {
  const root = asRecord(settings);
  if (!root) {
    throw new Error("Global settings must be a JSON object.");
  }

  const section = root[SETTINGS_KEY];
  if (section === undefined) return "en";
  const sectionRecord = asRecord(section);
  if (!sectionRecord) {
    throw new Error(`${SETTINGS_KEY} must be a JSON object.`);
  }

  const language = sectionRecord.language;
  if (language === undefined) return "en";
  if (!isDisplayLanguage(language)) {
    throw new Error(`${SETTINGS_KEY}.language must be \"en\" or \"ja\".`);
  }
  return language;
}

export function updateReasoningLanguageSettings(
  current: string | undefined,
  language: ReasoningDisplayLanguage,
): string {
  const parsed: unknown = current
    ? JSON.parse(current.replace(/^\uFEFF/, ""))
    : {};
  const root = asRecord(parsed);
  if (!root) {
    throw new Error("Global settings must be a JSON object.");
  }

  const existing = root[SETTINGS_KEY];
  const existingRecord = existing === undefined ? {} : asRecord(existing);
  if (!existingRecord) {
    throw new Error(`${SETTINGS_KEY} must be a JSON object.`);
  }
  root[SETTINGS_KEY] = { ...existingRecord, language };
  return JSON.stringify(root, null, 2);
}

type GlobalSettingsStorage = {
  withLock(
    scope: "global",
    update: (current: string | undefined) => string | undefined,
  ): void;
};

function settingsManager(
  cwd: string,
  projectTrusted: boolean,
): SettingsManager {
  return SettingsManager.create(cwd, undefined, { projectTrusted });
}

function throwGlobalSettingsLoadError(manager: SettingsManager): void {
  const error = manager.drainErrors().find((item) => item.scope === "global");
  if (error) throw error.error;
}

function loadConfiguredLanguage(
  cwd: string,
  projectTrusted: boolean,
): ReasoningDisplayLanguage {
  const manager = settingsManager(cwd, projectTrusted);
  throwGlobalSettingsLoadError(manager);
  return reasoningLanguageFromSettings(manager.getGlobalSettings());
}

function saveConfiguredLanguage(
  cwd: string,
  projectTrusted: boolean,
  language: ReasoningDisplayLanguage,
): void {
  const manager = settingsManager(cwd, projectTrusted);
  throwGlobalSettingsLoadError(manager);

  // SettingsManager has no generic setter for extension-owned keys. Reuse its
  // backing storage so this write follows Pi's settings-file lock protocol.
  const storage = (
    manager as unknown as { storage?: GlobalSettingsStorage }
  ).storage;
  if (!storage) throw new Error("Pi settings storage is unavailable.");
  storage.withLock("global", (current) =>
    updateReasoningLanguageSettings(current, language)
  );
}

function parseLanguageArgument(value: string): ReasoningDisplayLanguage | undefined {
  switch (value.trim().toLowerCase()) {
    case "en":
    case "english":
      return "en";
    case "ja":
    case "jp":
    case "japanese":
    case "日本語":
      return "ja";
    default:
      return undefined;
  }
}

export function localizeReasoningLabel(label: string): string {
  const sanitized = sanitizeLabel(label);
  if (!sanitized) return DEFAULT_JAPANESE_LABEL;
  if (JAPANESE_TEXT_PATTERN.test(sanitized)) return sanitized;

  return ENGLISH_STATUS_LABELS.find(({ pattern }) => pattern.test(sanitized))
    ?.label ?? DEFAULT_JAPANESE_LABEL;
}

export function formatReasoningStatus(
  label: string,
  language: ReasoningDisplayLanguage,
): string {
  const sanitized = sanitizeLabel(label);
  return language === "ja"
    ? `推論：${localizeReasoningLabel(sanitized)}`
    : `Reasoning: ${sanitized}`;
}

interface CodeFence {
  character: "`" | "~";
  length: number;
}

function isIndentedCode(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

function updateCodeFence(line: string, current: CodeFence | undefined): {
  fence: CodeFence | undefined;
  marker: boolean;
} {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return { fence: current, marker: false };

  const sequence = match[1];
  const character = sequence[0] as "`" | "~";
  if (!current) {
    return { fence: { character, length: sequence.length }, marker: true };
  }

  const closes =
    character === current.character &&
    sequence.length >= current.length &&
    match[2].trim() === "";
  return { fence: closes ? undefined : current, marker: true };
}

function extractHeading(line: string): string | undefined {
  if (isIndentedCode(line)) return undefined;

  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("<!--")) return undefined;

  // Only accept explicit, whole-line headings. Do not promote arbitrary bold
  // phrases or reasoning details into the status indicator.
  const bold = trimmed.match(/^\*\*([^*]+)\*\*$/)?.[1];
  const markdown = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/)?.[1];
  const label = sanitizeLabel(bold ?? markdown ?? "");
  if (!label) return undefined;

  return label.length > MAX_LABEL_LENGTH
    ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : label;
}

function extractLatestHeading(text: string): string | undefined {
  let latest: string | undefined;
  let codeFence: CodeFence | undefined;
  let start = 0;

  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const lineLength = end - start;
    const line = lineLength <= MAX_SOURCE_LINE_LENGTH
      ? text.slice(start, end).replace(/\r$/, "")
      : "";
    const fenceUpdate = updateCodeFence(line, codeFence);
    codeFence = fenceUpdate.fence;
    if (!fenceUpdate.marker && !codeFence) {
      latest = extractHeading(line) ?? latest;
    }

    if (newline === -1) break;
    start = newline + 1;
  }

  return latest;
}

export default function codexReasoningSummary(pi: ExtensionAPI) {
  let pendingLine = "";
  let discardLongLine = false;
  let codeFence: CodeFence | undefined;
  let contentIndex: number | undefined;
  let displayLanguage: ReasoningDisplayLanguage = "en";
  let activeStatus: string | undefined;

  const resetStreamState = () => {
    pendingLine = "";
    discardLongLine = false;
    codeFence = undefined;
    contentIndex = undefined;
  };

  const clearStatus = (ctx: ExtensionContext) => {
    activeStatus = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const showLabel = (label: string, ctx: ExtensionContext) => {
    const status = formatReasoningStatus(label, displayLanguage);
    if (status === activeStatus) return;
    activeStatus = status;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const consumeThinkingDelta = (delta: string, ctx: ExtensionContext) => {
    let start = 0;

    while (start < delta.length) {
      const newline = delta.indexOf("\n", start);
      const end = newline === -1 ? delta.length : newline;
      const completesLine = newline !== -1;
      const hasTrailingCarriageReturn =
        completesLine && end > start && delta[end - 1] === "\r";
      const segmentEnd = hasTrailingCarriageReturn ? end - 1 : end;

      if (!discardLongLine) {
        const segmentLength = segmentEnd - start;
        if (segmentLength > MAX_SOURCE_LINE_LENGTH - pendingLine.length) {
          pendingLine = "";
          discardLongLine = true;
        } else {
          pendingLine += delta.slice(start, segmentEnd);
          if (completesLine) {
            const fenceUpdate = updateCodeFence(pendingLine, codeFence);
            codeFence = fenceUpdate.fence;
            if (!fenceUpdate.marker && !codeFence) {
              const label = extractHeading(pendingLine);
              if (label) showLabel(label, ctx);
            }
          }
        }
      }

      if (!completesLine) break;
      pendingLine = "";
      discardLongLine = false;
      start = newline + 1;
    }
  };

  pi.registerCommand(LANGUAGE_COMMAND, {
    description: "Set the Codex reasoning summary language (en or ja)",
    handler: async (args, ctx) => {
      let language = parseLanguageArgument(args);

      if (!args.trim()) {
        const selected = await ctx.ui.select(
          "Reasoning summary language",
          ["English (default)", "日本語"],
        );
        if (selected === undefined) return;
        language = selected === "日本語" ? "ja" : "en";
      }

      if (!language) {
        ctx.ui.notify(`Usage: /${LANGUAGE_COMMAND} en|ja`, "warning");
        return;
      }

      try {
        saveConfiguredLanguage(ctx.cwd, ctx.isProjectTrusted(), language);
      } catch (error) {
        ctx.ui.notify(
          `Could not save ~/.pi/agent/settings.json: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }

      displayLanguage = language;
      clearStatus(ctx);
      ctx.ui.notify(
        language === "ja"
          ? "推論要約の表示言語を日本語に変更しました。"
          : "Reasoning summary language set to English.",
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      displayLanguage = loadConfiguredLanguage(
        ctx.cwd,
        ctx.isProjectTrusted(),
      );
    } catch (error) {
      displayLanguage = "en";
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Could not load codexReasoningSummary.language; using English: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    if (ctx.mode === "tui") clearStatus(ctx);
    resetStreamState();
  });

  // The API has no summary locale parameter, so this is a best-effort request.
  // The status formatter still guarantees a Japanese fallback for English headings.
  pi.on("before_agent_start", (event, ctx) => {
    if (displayLanguage !== "ja" || ctx.model?.api !== TARGET_API) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${JAPANESE_SUMMARY_INSTRUCTION}`,
    };
  });

  // `auto` selects the most detailed summary mode supported by each model.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.api !== TARGET_API) return;

    const payload = asRecord(event.payload);
    const reasoning = asRecord(payload?.reasoning);
    if (!payload || !reasoning || "summary" in reasoning) return;

    reasoning.summary = SUMMARY_MODE;
    return payload;
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode === "tui") clearStatus(ctx);
    resetStreamState();
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    if (
      event.message.role !== "assistant" ||
      event.message.api !== TARGET_API
    ) {
      clearStatus(ctx);
      resetStreamState();
      return;
    }

    const update = event.assistantMessageEvent;

    if (update.type === "thinking_start") {
      clearStatus(ctx);
      resetStreamState();
      contentIndex = update.contentIndex;
      return;
    }

    if (update.type === "thinking_delta") {
      if (contentIndex !== update.contentIndex) {
        clearStatus(ctx);
        resetStreamState();
        contentIndex = update.contentIndex;
      }
      consumeThinkingDelta(update.delta, ctx);
      return;
    }

    if (update.type === "thinking_end") {
      if (contentIndex !== update.contentIndex) return;

      const label = extractLatestHeading(update.content);
      if (label) showLabel(label, ctx);
      else clearStatus(ctx);
      pendingLine = "";
      discardLongLine = false;
      codeFence = undefined;
      contentIndex = undefined;
      return;
    }

    if (update.type === "text_start") {
      clearStatus(ctx);
      resetStreamState();
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") clearStatus(ctx);
    resetStreamState();
  });
}
