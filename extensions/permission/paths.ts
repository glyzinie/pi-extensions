import { existsSync, realpathSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type { BashStaticWord } from "../permission-tree-sitter-bash/types.ts";

export interface PathIdentity {
  logical: string;
  canonical: string;
}

function canonicalOrResolve(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolved;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...missing);
  } catch {
    return resolved;
  }
}

function pathForms(path: string): string[] {
  const logical = resolve(path);
  return [...new Set([logical, canonicalOrResolve(logical)])];
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function tempRootPaths(): string[] {
  return [...new Set(
    [tmpdir(), "/tmp", "/private/tmp", "/private/var/tmp"].map((path) => resolve(path)),
  )];
}

function resolveConfiguredPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return resolve(homedir());
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function protectedWriteRootPaths(): Record<"pi-agent" | "codex", string> {
  const piAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const codexHome = process.env.CODEX_HOME?.trim();
  return {
    "pi-agent": piAgentDir
      ? resolveConfiguredPath(piAgentDir)
      : resolve(homedir(), ".pi", "agent"),
    codex: codexHome
      ? resolveConfiguredPath(codexHome)
      : resolve(homedir(), ".codex"),
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function expandToolPath(path: string, cwd: string): string {
  let value = path.startsWith("@") ? path.slice(1) : path;
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

async function canonicalizeAbsolute(
  absolutePath: string,
  seen: Set<string>,
): Promise<string> {
  const absolute = resolve(absolutePath);
  if (seen.has(absolute)) throw new Error(`symlink cycle while resolving ${absolute}`);
  seen.add(absolute);

  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    const candidate = resolve(current, components[index]!);
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      return resolve(current, ...components.slice(index));
    }
    if (!stat.isSymbolicLink()) {
      current = candidate;
      continue;
    }
    const link = await readlink(candidate);
    const linkedPath = isAbsolute(link) ? link : resolve(dirname(candidate), link);
    return canonicalizeAbsolute(
      resolve(linkedPath, ...components.slice(index + 1)),
      seen,
    );
  }

  try {
    return await realpath(current);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return current;
  }
}

async function identity(logical: string): Promise<PathIdentity> {
  return {
    logical,
    canonical: await canonicalizeAbsolute(logical, new Set()),
  };
}

/** Resolve a Pi tool path using Pi's @ and tilde conventions. */
export async function resolveToolPathIdentity(
  path: string,
  cwd: string,
): Promise<PathIdentity> {
  return identity(expandToolPath(path, cwd));
}

/** Resolve a statically decoded Bash word without inventing shell expansion. */
export async function resolveBashPathIdentity(
  word: BashStaticWord,
  cwd: string,
): Promise<PathIdentity> {
  if (word.value === undefined) throw new Error("Bash path is dynamic");
  const value = word.expandTilde
    ? word.value === "~"
      ? homedir()
      : resolve(homedir(), word.value.slice(2))
    : word.value;
  return identity(isAbsolute(value) ? resolve(value) : resolve(cwd, value));
}

function identityInside(value: PathIdentity, root: string): boolean {
  return pathForms(root).some(
    (form) => isInside(form, value.logical) || isInside(form, value.canonical),
  );
}

function identityMatches(value: PathIdentity, path: string): boolean {
  return pathForms(path).some(
    (form) => form === value.logical || form === value.canonical,
  );
}

function identityCovers(value: PathIdentity, path: string): boolean {
  return pathForms(path).some(
    (form) => isInside(value.logical, form) || isInside(value.canonical, form),
  );
}

export function isTempPath(value: PathIdentity): boolean {
  return tempRootPaths().some((root) =>
    pathForms(root).some((form) => isInside(form, value.canonical)),
  );
}

export function protectedRootForPath(
  value: PathIdentity,
): { id: "pi-agent" | "codex"; path: string } | undefined {
  const roots = protectedWriteRootPaths();
  for (const id of ["pi-agent", "codex"] as const) {
    if (identityInside(value, roots[id])) return { id, path: roots[id] };
  }
  return undefined;
}

export function isCredentialPath(value: PathIdentity): boolean {
  const home = resolve(homedir());
  const roots = [resolve(home, ".ssh"), resolve(home, ".gnupg"), resolve(home, ".aws")];
  if (roots.some((root) => identityInside(value, root) || identityCovers(value, root))) return true;

  const protectedRoots = protectedWriteRootPaths();
  const files = [
    resolve(home, ".netrc"),
    resolve(home, ".npmrc"),
    resolve(home, ".pypirc"),
    resolve(home, ".git-credentials"),
    resolve(home, ".docker", "config.json"),
    resolve(home, ".config", "gh", "hosts.yml"),
    resolve(home, ".config", "gcloud", "application_default_credentials.json"),
    resolve(protectedRoots["pi-agent"], "auth.json"),
    resolve(protectedRoots.codex, "auth.json"),
  ];
  return files.some((file) => identityMatches(value, file) || identityCovers(value, file));
}

/** Mirrors the base Bash sandbox: temp plus cwd subtree, except when cwd is HOME. */
export async function isDefaultSandboxWritable(
  value: PathIdentity,
  cwd: string,
): Promise<boolean> {
  if (isTempPath(value)) return true;
  if (protectedRootForPath(value)) return false;
  const cwdIdentity = await resolveToolPathIdentity(cwd, cwd);
  const homeIdentity = await resolveToolPathIdentity(homedir(), cwd);
  if (cwdIdentity.canonical === homeIdentity.canonical) return false;
  return isInside(cwdIdentity.canonical, value.canonical);
}
