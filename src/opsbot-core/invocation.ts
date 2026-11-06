/**
 * How to invoke this CLI, as a runnable command prefix. The bundle ships inside
 * a skill and is not on PATH, so every emitted example, help line and hook
 * command uses the resolved path, never a bare `opsbot-core`.
 *
 * Prefers the sibling shim (…/scripts/opsbot-core) when it is executable,
 * since that is how SKILL.md documents invocation; falls back to
 * `node <bundle>`. Unbundled (tests, `bun src/...`) it points at the shim in
 * this repo's skill directory. The home directory is collapsed to `~`.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = "opsbot-core";
let cached: string | undefined;

function selfPath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] ?? TOOL;
  }
}

/** The absolute path of the shim, when it can be found; else the bundle or entry. */
export function shimPath(): string {
  const self = selfPath();
  if (self.endsWith(".mjs")) {
    const shim = self.replace(/\.mjs$/, "");
    if (isExecutable(shim)) return shim;
    return self;
  }
  // unbundled: src/opsbot-core/<file>.ts → skills/opsbot-core/scripts/opsbot-core
  const repoShim = resolve(dirname(self), "..", "..", "skills", TOOL, "scripts", TOOL);
  if (existsSync(repoShim)) return repoShim;
  return self;
}

/** The skill directory the running CLI belongs to (for templates/). */
export function skillDir(): string {
  const self = selfPath();
  if (self.endsWith(".mjs")) return resolve(dirname(self), "..");
  return resolve(dirname(self), "..", "..", "skills", TOOL);
}

export function cliInvocation(): string {
  if (cached) return cached;
  const self = selfPath();
  const shim = shimPath();
  if (shim !== self || !self.endsWith(".mjs")) {
    if (isExecutable(shim) && !shim.endsWith(".ts")) {
      cached = quote(collapseHome(shim));
      return cached;
    }
  }
  cached = `node ${quote(collapseHome(self))}`;
  return cached;
}

/** The command a systemd unit or a hook runs: absolute, never `~`. */
export function absoluteInvocation(): string {
  const shim = shimPath();
  if (isExecutable(shim) && !shim.endsWith(".ts") && !shim.endsWith(".mjs")) return shim;
  return `${process.execPath} ${shim}`;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function collapseHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export const SKILL_TOOL = TOOL;
