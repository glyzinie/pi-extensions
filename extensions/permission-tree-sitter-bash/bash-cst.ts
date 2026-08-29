import type { Node } from "web-tree-sitter";

import { withParsedTree } from "./runtime.ts";
import { inferCommandEffects } from "./command-effects.ts";
import type {
  BashCommand,
  BashControlOperator,
  BashRedirect,
  BashStaticWord,
  BashTreeSitterAnalysis,
  BashWriteTarget,
} from "./types.ts";

const BASH_GRAMMAR = "tree-sitter-bash.wasm";
const MAX_SOURCE_BYTES = 100_000;
const MAX_TREE_NODES = 20_000;
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&"]);
const CONTROL_OPERATORS = new Set<BashControlOperator>([
  "&&", "||", ";", "|", "|&", "&",
]);
const DYNAMIC_NODES = new Set([
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "expansion",
  "simple_expansion",
]);
const UNDERSTOOD_NODES = new Set([
  "program",
  "list",
  "pipeline",
  "command",
  "command_name",
  "word",
  "number",
  "string",
  "string_content",
  "raw_string",
  "concatenation",
  "redirected_statement",
  "file_redirect",
  "file_descriptor",
  "variable_assignment",
  "variable_name",
  "comment",
]);
const OPAQUE_NODES = new Set([
  "if_statement",
  "elif_clause",
  "else_clause",
  "for_statement",
  "c_style_for_statement",
  "while_statement",
  "case_statement",
  "case_item",
  "subshell",
  "compound_statement",
  "function_definition",
  "negated_command",
  "test_command",
  "declaration_command",
  "unset_command",
  "heredoc_redirect",
  "heredoc_start",
  "heredoc_body",
  "heredoc_end",
]);

function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null);
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function sourceText(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function decodeStaticWord(node: Node, source: string): BashStaticWord {
  const raw = sourceText(node, source);

  if (node.type === "command_name") {
    const child = node.firstNamedChild;
    return child
      ? decodeStaticWord(child, source)
      : { raw, quoted: false, expandTilde: false };
  }

  if (node.type === "raw_string") {
    const value = raw.startsWith("'") && raw.endsWith("'")
      ? raw.slice(1, -1)
      : undefined;
    return { raw, value, quoted: true, expandTilde: false };
  }

  if (node.type === "string") {
    const onlyText = namedChildren(node).every((child) => child.type === "string_content");
    const inner = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : undefined;
    const value = onlyText && inner !== undefined && !inner.includes("\\") ? inner : undefined;
    return { raw, value, quoted: true, expandTilde: false };
  }

  if (node.type === "concatenation") {
    const parts = namedChildren(node).map((part) => decodeStaticWord(part, source));
    const value = parts.every((part) => part.value !== undefined)
      ? parts.map((part) => part.value!).join("")
      : undefined;
    return {
      raw,
      value,
      quoted: parts.some((part) => part.quoted),
      expandTilde: parts[0]?.expandTilde ?? false,
    };
  }

  if (node.type !== "word" && node.type !== "number") {
    return { raw, quoted: false, expandTilde: false };
  }
  if (namedChildren(node).length > 0 || /[${}*?\[\]`\\]/.test(raw)) {
    return { raw, quoted: false, expandTilde: false };
  }
  return {
    raw,
    value: raw,
    quoted: false,
    expandTilde: raw === "~" || raw.startsWith("~/"),
  };
}

function parseRedirect(node: Node, source: string): BashRedirect | undefined {
  if (node.type !== "file_redirect") return undefined;
  const operator = children(node).find(
    (child) => !child.isNamed && /^(?:<|>|>>|>\||&>|&>>|<&|>&)$/.test(child.type),
  )?.type;
  if (!operator) return undefined;

  const descriptor = node.childForFieldName("descriptor");
  const destination = node.childForFieldName("destination");
  return {
    operator,
    fd: descriptor ? sourceText(descriptor, source) : undefined,
    target: destination && destination.type !== "file_descriptor"
      ? decodeStaticWord(destination, source)
      : undefined,
    write: WRITE_REDIRECTS.has(operator),
  };
}

function parseCommand(node: Node, source: string): BashCommand {
  const assignments: string[] = [];
  const words: BashStaticWord[] = [];
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (!child) continue;
    const field = node.fieldNameForNamedChild(index);
    if (child.type === "variable_assignment") {
      assignments.push(sourceText(child, source));
    } else if (child.type === "command_name" || field === "argument") {
      words.push(decodeStaticWord(child, source));
    }
  }

  return {
    words,
    resolvedArgv: words.every((word) => word.value !== undefined)
      ? words.map((word) => word.value!)
      : undefined,
    assignments,
    redirects: [],
    effectsComplete: false,
  };
}

const SHELL_STATE_COMMANDS = new Set([
  "cd", "export", "source", ".", "alias", "unalias", "set", "unset",
  "readonly", "declare", "typeset", "local", "let", "eval", "exec", "hash",
  "enable", "shopt", "umask", "read", "mapfile",
]);

function mutatesShellState(command: BashCommand): boolean {
  const argv = command.resolvedArgv;
  if (!argv?.length) return command.assignments.length > 0;
  return (
    command.assignments.length > 0 ||
    SHELL_STATE_COMMANDS.has(argv[0]!) ||
    (argv[0] === "printf" && argv.slice(1).some((arg) => arg === "-v" || arg.startsWith("-v")))
  );
}

function incomplete(source: string, warning: string): BashTreeSitterAnalysis {
  return {
    raw: source,
    complete: false,
    dynamic: true,
    opaque: true,
    background: false,
    controlOperators: [],
    commands: [],
    writeTargets: [],
    writeTargetsComplete: false,
    warnings: [warning],
  };
}

export async function analyzeBashSource(source: string): Promise<BashTreeSitterAnalysis> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return incomplete(source, `bash source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }

  return withParsedTree(BASH_GRAMMAR, source, (tree) => {
    const warnings: string[] = [];
    const commandEntries: Array<{ node: Node; command: BashCommand }> = [];
    const controlOperatorEntries: Array<{
      startIndex: number;
      operator: BashControlOperator;
    }> = [];
    const redirectedStatements: Node[] = [];
    const stack = [tree.rootNode];
    let nodeCount = 0;
    let complete = !tree.rootNode.hasError;
    let dynamic = false;
    let opaque = false;
    let background = false;

    while (stack.length > 0) {
      const node = stack.pop()!;
      nodeCount += 1;
      if (nodeCount > MAX_TREE_NODES) {
        complete = false;
        opaque = true;
        warnings.push(`bash syntax tree exceeds ${MAX_TREE_NODES} nodes`);
        break;
      }
      if (node.isError || node.isMissing) {
        complete = false;
        warnings.push(
          `${node.isMissing ? "missing" : "error"} ${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column + 1}`,
        );
      }
      if (!node.isNamed && CONTROL_OPERATORS.has(node.type as BashControlOperator)) {
        const operator = node.type as BashControlOperator;
        controlOperatorEntries.push({ startIndex: node.startIndex, operator });
        if (operator === "&") background = true;
      }
      if (DYNAMIC_NODES.has(node.type)) dynamic = true;
      else if (node.type === "variable_assignment") {
        dynamic = true;
        opaque = true;
      } else if (OPAQUE_NODES.has(node.type)) opaque = true;
      else if (node.isNamed && !UNDERSTOOD_NODES.has(node.type)) opaque = true;

      if (node.type === "redirected_statement") redirectedStatements.push(node);
      if (node.type === "command") {
        const command = parseCommand(node, source);
        dynamic ||= command.assignments.length > 0 || command.resolvedArgv === undefined;
        commandEntries.push({ node, command });
      }
      for (const child of children(node)) stack.push(child);
    }

    commandEntries.sort((a, b) => a.node.startIndex - b.node.startIndex);
    if (commandEntries.some(({ command }) => mutatesShellState(command))) {
      opaque = true;
    }
    const redirectWriteTargets: BashWriteTarget[] = [];
    for (const node of redirectedStatements) {
      const body = node.childForFieldName("body");
      const owner = body
        ? commandEntries.find(({ node: commandNode }) =>
            commandNode.startIndex >= body.startIndex && commandNode.endIndex <= body.endIndex,
          )?.command
        : undefined;
      for (let index = 0; index < node.namedChildCount; index += 1) {
        if (node.fieldNameForNamedChild(index) !== "redirect") continue;
        const redirectNode = node.namedChild(index);
        if (!redirectNode) continue;
        const redirect = parseRedirect(redirectNode, source);
        if (!redirect) {
          opaque = true;
          continue;
        }
        (owner?.redirects as BashRedirect[] | undefined)?.push(redirect);
        if (!redirect.write) continue;
        if (!redirect.target?.value) dynamic = true;
        else {
          redirectWriteTargets.push({
            path: redirect.target,
            mode: "file",
            operation: `redirect ${redirect.operator}`,
          });
        }
      }
    }

    const writeTargets = [...redirectWriteTargets];
    let writeTargetsComplete = complete && !dynamic && !opaque;
    for (const { command } of commandEntries) {
      const effects = inferCommandEffects(command);
      command.effectsComplete = effects.complete;
      writeTargets.push(...effects.writeTargets);
      writeTargetsComplete &&= effects.complete;
    }

    controlOperatorEntries.sort((a, b) => a.startIndex - b.startIndex);

    return {
      raw: source,
      complete,
      dynamic,
      opaque,
      background,
      controlOperators: controlOperatorEntries.map(({ operator }) => operator),
      commands: commandEntries.map(({ command }) => command),
      writeTargets,
      writeTargetsComplete,
      warnings: [...new Set(warnings)],
    };
  });
}

export function invalidBashAnalysis(source: string, warning: string): BashTreeSitterAnalysis {
  return incomplete(source, warning);
}
