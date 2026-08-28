import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, isAbsolute, resolve } from "node:path";

import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const MAX_ERRORS = 5;

const GRAMMAR_BY_EXT: Record<string, string> = {
  ".bash": "tree-sitter-bash.wasm",
  ".c": "tree-sitter-c.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cxx": "tree-sitter-cpp.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".css": "tree-sitter-css.wasm",
  ".go": "tree-sitter-go.wasm",
  ".h": "tree-sitter-c.wasm",
  ".hh": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".html": "tree-sitter-html.wasm",
  ".java": "tree-sitter-java.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".json": "tree-sitter-json.wasm",
  ".kt": "tree-sitter-kotlin.wasm",
  ".kts": "tree-sitter-kotlin.wasm",
  ".lua": "tree-sitter-lua.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".php": "tree-sitter-php.wasm",
  ".py": "tree-sitter-python.wasm",
  ".pyi": "tree-sitter-python.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".scala": "tree-sitter-scala.wasm",
  ".sh": "tree-sitter-bash.wasm",
  ".swift": "tree-sitter-swift.wasm",
  ".toml": "tree-sitter-toml.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".vue": "tree-sitter-vue.wasm",
  ".yaml": "tree-sitter-yaml.wasm",
  ".yml": "tree-sitter-yaml.wasm",
  ".zig": "tree-sitter-zig.wasm",
};

type LoadedTreeSitter = {
  Parser: any;
  Language: any;
};

const require = createRequire(import.meta.url);
let runtimePromise: Promise<LoadedTreeSitter | null> | undefined;
const languageCache = new Map<string, any | null>();
let dependencyWarningShown = false;

async function loadRuntime(): Promise<LoadedTreeSitter | null> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        // Keep these optional: the extension still loads if the packages are not
        // installed. Install: web-tree-sitter + tree-sitter-wasms.
        const moduleName = "web-tree-sitter";
        const mod: any = await import(moduleName);
        const Parser = mod.Parser;
        const Language = mod.Language;
        await Parser.init();
        return { Parser, Language };
      } catch {
        return null;
      }
    })();
  }
  return runtimePromise;
}

async function loadLanguage(path: string): Promise<any | null> {
  const grammar = GRAMMAR_BY_EXT[extname(path).toLowerCase()];
  if (!grammar) return null;

  if (languageCache.has(grammar)) {
    return languageCache.get(grammar) ?? null;
  }

  const runtime = await loadRuntime();
  if (!runtime) return null;

  try {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${grammar}`);
    const language = await runtime.Language.load(wasmPath);
    languageCache.set(grammar, language);
    return language;
  } catch {
    languageCache.set(grammar, null);
    return null;
  }
}

type SyntaxErrorInfo = {
  line: number;
  column: number;
  type: string;
  missing: boolean;
};

async function syntaxErrors(
  path: string,
  source: string,
): Promise<SyntaxErrorInfo[] | null> {
  const runtime = await loadRuntime();
  if (!runtime) return null;

  const language = await loadLanguage(path);
  if (!language) return null;

  const parser = new runtime.Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);

  if (!tree?.rootNode?.hasError) return [];

  const errors: SyntaxErrorInfo[] = [];
  const stack = [tree.rootNode];

  while (stack.length > 0 && errors.length < MAX_ERRORS) {
    const node = stack.pop();
    if (!node) continue;

    if (node.isError || node.isMissing) {
      errors.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        type: node.type,
        missing: Boolean(node.isMissing),
      });
      continue;
    }

    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  return errors;
}

function formatErrors(path: string, errors: SyntaxErrorInfo[]): string {
  const rows = errors.map((error) => {
    const kind = error.missing ? "missing" : "error";
    return `${error.line}:${error.column} ${kind} ${error.type}`;
  });

  return `Tree-sitter rejected ${path}:\n${rows.join("\n")}`;
}

type Replacement = {
  oldText: string;
  newText: string;
};

function normalizeEdits(input: Record<string, unknown>): Replacement[] | null {
  let value = input.edits;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as any).oldText === "string" &&
    typeof (value as any).newText === "string"
  ) {
    value = [value];
  }

  if (Array.isArray(value)) {
    const edits: Replacement[] = [];
    for (const item of value) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as any).oldText !== "string" ||
        typeof (item as any).newText !== "string"
      ) {
        return null;
      }
      edits.push({
        oldText: (item as any).oldText,
        newText: (item as any).newText,
      });
    }
    return edits.length > 0 ? edits : null;
  }

  // Legacy single edit shape.
  if (
    typeof input.oldText === "string" &&
    typeof input.newText === "string"
  ) {
    return [{ oldText: input.oldText, newText: input.newText }];
  }

  return null;
}

function simulateExactEdits(
  source: string,
  edits: Replacement[],
): string | null {
  const matches: Array<{ start: number; end: number; newText: string }> = [];

  for (const edit of edits) {
    if (edit.oldText.length === 0) return null;

    const start = source.indexOf(edit.oldText);
    if (start < 0) return null;
    if (source.indexOf(edit.oldText, start + 1) >= 0) return null;

    matches.push({
      start,
      end: start + edit.oldText.length,
      newText: edit.newText,
    });
  }

  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].start < matches[i - 1].end) return null;
  }

  let output = source;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    output =
      output.slice(0, match.start) +
      match.newText +
      output.slice(match.end);
  }
  return output;
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export default function treeSitterGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event)) {
      const result = await syntaxErrors(event.input.path, event.input.content);
      if (result === null) {
        if (!dependencyWarningShown && ctx.hasUI) {
          dependencyWarningShown = true;
          ctx.ui.notify(
            "tree-sitter guard inactive for this file; install web-tree-sitter and tree-sitter-wasms",
            "warning",
          );
        }
        return;
      }
      if (result.length > 0) {
        return { block: true, reason: formatErrors(event.input.path, result) };
      }
      return;
    }

    if (!isToolCallEventType("edit", event)) return;

    const edits = normalizeEdits(event.input as unknown as Record<string, unknown>);
    if (!edits) return;

    const file = absolutePath(event.input.path, ctx.cwd);

    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      // Let Pi's edit tool report file-access errors.
      return;
    }

    const proposed = simulateExactEdits(source, edits);
    if (proposed === null) {
      // Let Pi's edit tool report non-unique/not-found/overlapping edits.
      return;
    }

    // Do not make an already-broken file harder to edit. This lightweight guard
    // blocks only when a syntactically clean file would become invalid.
    const before = await syntaxErrors(file, source);
    const after = await syntaxErrors(file, proposed);

    if (after === null) {
      if (!dependencyWarningShown && ctx.hasUI) {
        dependencyWarningShown = true;
        ctx.ui.notify(
          "tree-sitter guard inactive for this file; install web-tree-sitter and tree-sitter-wasms",
          "warning",
        );
      }
      return;
    }

    if ((before?.length ?? 0) === 0 && after.length > 0) {
      return { block: true, reason: formatErrors(event.input.path, after) };
    }
  });
}
