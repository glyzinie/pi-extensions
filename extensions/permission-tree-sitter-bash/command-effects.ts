import { basename, dirname } from "node:path";

import type {
  BashCommand,
  BashStaticWord,
  BashWriteTarget,
} from "./types.ts";

export interface CommandEffects {
  writeTargets: readonly BashWriteTarget[];
  complete: boolean;
}

const TRUSTED_EXECUTABLE_DIRS = new Set(["/bin", "/usr/bin", "/sbin", "/usr/sbin"]);
const SIMPLE_NO_WRITE_COMMANDS = new Set([
  "pwd",
  "ls",
  "grep",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "cd",
]);

function commandName(word: BashStaticWord | undefined): string | undefined {
  const value = word?.value;
  if (!value) return undefined;
  if (!value.includes("/")) return value;
  return TRUSTED_EXECUTABLE_DIRS.has(dirname(value)) ? basename(value) : undefined;
}

function target(
  path: BashStaticWord,
  mode: "file" | "subtree",
  operation: string,
): BashWriteTarget {
  return { path, mode, operation };
}

function simpleOperands(
  words: readonly BashStaticWord[],
  allowedShort: RegExp,
  allowedLong: ReadonlySet<string> = new Set(),
): BashStaticWord[] | undefined {
  const operands: BashStaticWord[] = [];
  let options = true;
  for (const word of words.slice(1)) {
    const value = word.value;
    if (value === undefined) return undefined;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && value.startsWith("--")) {
      const name = value.split("=", 1)[0]!;
      if (!allowedLong.has(name)) return undefined;
      continue;
    }
    if (options && value.startsWith("-") && value !== "-") {
      if (!allowedShort.test(value)) return undefined;
      continue;
    }
    operands.push(word);
  }
  return operands;
}

function noWriteCommandIsComplete(name: string, argv: readonly string[]): boolean {
  if (SIMPLE_NO_WRITE_COMMANDS.has(name)) return true;
  if (name === "tree") {
    return !argv.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="));
  }
  if (name === "rg") {
    return !argv.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
  }
  if (name === "fd") {
    return !argv.some((arg) =>
      ["-x", "--exec", "-X", "--exec-batch"].includes(arg) ||
      arg.startsWith("--exec=") ||
      arg.startsWith("--exec-batch="),
    );
  }
  return false;
}

export function inferCommandEffects(command: BashCommand): CommandEffects {
  const argv = command.resolvedArgv;
  if (!argv || argv.length === 0 || command.assignments.length > 0) {
    return { writeTargets: [], complete: false };
  }

  const name = commandName(command.words[0]);
  if (!name) return { writeTargets: [], complete: false };
  if (noWriteCommandIsComplete(name, argv)) return { writeTargets: [], complete: true };

  if (name === "touch") {
    const operands = simpleOperands(
      command.words,
      /^-[acm]+$/,
      new Set(["--no-create"]),
    );
    return operands
      ? { writeTargets: operands.map((word) => target(word, "file", "touch")), complete: true }
      : { writeTargets: [], complete: false };
  }

  if (name === "mkdir") {
    const operands = simpleOperands(
      command.words,
      /^-[pv]+$/,
      new Set(["--parents", "--verbose"]),
    );
    if (!operands) return { writeTargets: [], complete: false };
    return {
      writeTargets: operands.map((word) => target(word, "file", "mkdir")),
      complete: true,
    };
  }

  if (name === "rm" || name === "rmdir") {
    const operands = simpleOperands(
      command.words,
      name === "rm" ? /^-[dfiIRrv]+$/ : /^-[pv]+$/,
      new Set(
        name === "rm"
          ? ["--force", "--interactive", "--recursive", "--verbose"]
          : ["--parents", "--verbose"],
      ),
    );
    if (!operands) return { writeTargets: [], complete: false };
    const recursive = name === "rm" && argv.some((arg) =>
      arg === "--recursive" || /^-[^-]*[rR]/.test(arg),
    );
    return {
      writeTargets: operands.map((word) => target(word, recursive ? "subtree" : "file", "delete")),
      complete: true,
    };
  }

  if (name === "tee") {
    const operands = simpleOperands(
      command.words,
      /^-[ai]+$/,
      new Set(["--append", "--ignore-interrupts"]),
    );
    return operands
      ? { writeTargets: operands.map((word) => target(word, "file", "tee")), complete: true }
      : { writeTargets: [], complete: false };
  }

  if (name === "dd") {
    const output = command.words.slice(1).find((word) => word.value?.startsWith("of="));
    if (!output?.value) return { writeTargets: [], complete: false };
    const value = output.value.slice(3);
    const rawPrefix = output.raw.indexOf("of=");
    const outputWord: BashStaticWord = {
      raw: rawPrefix >= 0 ? output.raw.slice(rawPrefix + 3) : value,
      value,
      quoted: output.quoted,
      expandTilde: output.expandTilde,
    };
    return { writeTargets: [target(outputWord, "file", "dd")], complete: true };
  }

  // cp, mv, ln, chmod/chown, find, interpreters, package managers, and git can
  // derive additional destinations or execute project-controlled programs.
  return { writeTargets: [], complete: false };
}
