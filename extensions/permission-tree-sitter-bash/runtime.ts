import { createRequire } from "node:module";

import {
  Language,
  Parser,
  type Tree,
} from "web-tree-sitter";

const require = createRequire(import.meta.url);
let runtimePromise: Promise<void> | undefined;
const languagePromises = new Map<string, Promise<Language>>();

function initializeRuntime(): Promise<void> {
  runtimePromise ??= Parser.init();
  return runtimePromise;
}

async function loadLanguage(grammar: string): Promise<Language> {
  let promise = languagePromises.get(grammar);
  if (!promise) {
    promise = (async () => {
      await initializeRuntime();
      return Language.load(require.resolve(`tree-sitter-wasms/out/${grammar}`));
    })();
    languagePromises.set(grammar, promise);
  }
  return promise;
}

/** Parse with deterministic cleanup. Tree-sitter nodes must not escape the callback. */
export async function withParsedTree<T>(
  grammar: string,
  source: string,
  fn: (tree: Tree) => T | Promise<T>,
): Promise<T> {
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source);
    if (!tree) throw new Error(`tree-sitter failed to parse with ${grammar}`);
    return await fn(tree);
  } finally {
    tree?.delete();
    parser.delete();
  }
}
