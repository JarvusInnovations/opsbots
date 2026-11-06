/**
 * hook install | uninstall | status — the Claude Code hooks that make a cold
 * start safe:
 *
 *   SessionStart (every source: startup, resume, compact, clear)
 *       <core> cold-start --write    writes the pack, sets the pending flag
 *   PreToolUse (every tool)
 *       <core> gate check            refuses every tool until the pack is read whole
 *
 * Project scope (the default) writes <repo>/.claude/settings.json with a
 * ${CLAUDE_PROJECT_DIR}-relative command when the skill is vendored in the
 * repo, so the committed file works on every machine. Global scope writes
 * ~/.claude/settings.json with the absolute path. Entries are matched by the
 * marker "opsbot-core", so other tools' hooks are never touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { computeSessionStartHookRemoval, computeSessionStartHookUpdate, type HookSettings } from "axi-sdk-js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, usageError } from "../args.js";
import { shimPath } from "../invocation.js";
import { findRoot } from "../repo.js";

export const MARKER = "opsbot-core";
export const HOOK_USAGE = "hook install|uninstall|status [--scope project|global] [--dir PATH]";

type Scope = "project" | "global";

interface PreToolGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

function settingsPath(scope: Scope, dir: string | null): string {
  if (scope === "global") return join(homedir(), ".claude", "settings.json");
  return join(dir!, ".claude", "settings.json");
}

/** The shim as the hook should call it from this scope. */
export function hookBase(scope: Scope, dir: string | null): string {
  const shim = shimPath();
  if (scope === "project" && dir) {
    const rel = relative(dir, shim);
    if (!rel.startsWith("..") && !rel.startsWith("/")) return `"\${CLAUDE_PROJECT_DIR}/${rel}"`;
  }
  return JSON.stringify(shim);
}

function readSettings(p: string): HookSettings {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as HookSettings;
  } catch {
    throw new AxiError(`${p} is not valid JSON; not touching it`, "CANNOT_RUN", ["Fix the file by hand, then run hook install again"]);
  }
}

function writeSettings(p: string, s: HookSettings): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
}

function upsertPreTool(settings: HookSettings, command: string): [HookSettings, boolean] {
  const updated = structuredClone(settings) as HookSettings & { hooks: Record<string, unknown> };
  updated.hooks ??= {};
  const groups = (Array.isArray(updated.hooks.PreToolUse) ? updated.hooks.PreToolUse : []) as PreToolGroup[];
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (typeof h.command === "string" && h.command.includes(MARKER)) {
        if (h.command === command && h.type === "command" && g.matcher === "*") return [settings, false];
        h.command = command;
        h.type = "command";
        h.timeout = 10;
        g.matcher = "*";
        updated.hooks.PreToolUse = groups;
        return [updated, true];
      }
    }
  }
  groups.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] });
  updated.hooks.PreToolUse = groups;
  return [updated, true];
}

function removePreTool(settings: HookSettings): [HookSettings, boolean] {
  const updated = structuredClone(settings) as HookSettings & { hooks?: Record<string, unknown> };
  const groups = updated.hooks?.PreToolUse as PreToolGroup[] | undefined;
  if (!Array.isArray(groups)) return [settings, false];
  let changed = false;
  const kept: PreToolGroup[] = [];
  for (const g of groups) {
    const hooks = (g.hooks ?? []).filter((h) => !(typeof h.command === "string" && h.command.includes(MARKER)));
    if (hooks.length !== (g.hooks ?? []).length) changed = true;
    if (hooks.length) kept.push({ ...g, hooks });
  }
  if (!changed) return [settings, false];
  if (kept.length) updated.hooks!.PreToolUse = kept;
  else delete updated.hooks!.PreToolUse;
  return [updated, true];
}

function found(settings: HookSettings, event: string): string | null {
  const groups = (settings.hooks?.[event] ?? []) as PreToolGroup[];
  if (!Array.isArray(groups)) return null;
  for (const g of groups) for (const h of g.hooks ?? []) if (typeof h.command === "string" && h.command.includes(MARKER)) return h.command;
  return null;
}

export function hookCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    throw usageError(sub ? `unknown hook subcommand ${sub}` : "hook needs a subcommand", HOOK_USAGE);
  }
  const { flags } = parseArgs(rest, { value: ["scope", "dir"] }, HOOK_USAGE);
  const scope = (flags.scope ?? "project") as Scope;
  if (scope !== "project" && scope !== "global") throw usageError("--scope must be project or global", HOOK_USAGE);
  const dir = scope === "project" ? (typeof flags.dir === "string" ? flags.dir : findRoot()) : null;
  if (scope === "project" && !dir) {
    throw new AxiError("not inside a git checkout, so there is no project to install into", "CANNOT_RUN", [
      "Pass --dir <repo> or --scope global",
    ]);
  }
  const p = settingsPath(scope, dir);
  const base = hookBase(scope, dir);
  const startCmd = `${base} cold-start --write`;
  const gateCmd = `${base} gate check`;
  const current = readSettings(p);

  if (sub === "status") {
    const s = found(current, "SessionStart");
    const g = found(current, "PreToolUse");
    const ok = (have: string | null, want: string) => (have === null ? "missing" : have === want ? "installed" : "differs");
    return {
      hook: { scope, file: p },
      hooks: [
        { event: "SessionStart", state: ok(s, startCmd), command: s ?? startCmd },
        { event: "PreToolUse", state: ok(g, gateCmd), command: g ?? gateCmd },
      ],
    };
  }

  if (sub === "install") {
    const [a, c1] = computeSessionStartHookUpdate(current, { marker: MARKER, command: startCmd, timeoutSeconds: 30 });
    const [b, c2] = upsertPreTool(a, gateCmd);
    if (!c1 && !c2) return { hook: `already installed in ${p} (no-op)` };
    writeSettings(p, b);
    return { hook: `installed in ${p}`, session_start: startCmd, pre_tool_use: gateCmd };
  }

  const [a, c1] = computeSessionStartHookRemoval(current, MARKER);
  const [b, c2] = removePreTool(a);
  if (!c1 && !c2) return { hook: `not installed in ${p} (no-op)` };
  writeSettings(p, b);
  return { hook: `removed from ${p}` };
}
