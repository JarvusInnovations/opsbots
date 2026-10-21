/**
 * opsbot.d/: the lifecycle directories. Like /etc/*.d — the core keeps no list
 * of what contributes to a point; it runs every executable it finds there, in
 * lexical order. Dotfiles, directories and non-executables are skipped.
 *
 * Every script gets OPSBOT_ROOT, OPSBOT_CONFIG, OPSBOT_NAME, OPSBOT_MARK and
 * OPSBOT_HOOK, plus whatever the point adds (OPSBOT_SINCE, OPSBOT_SEEN,
 * OPSBOT_WATERMARK for heartbeat scripts).
 */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gitPath, run, type RunResult } from "./repo.js";
import type { Settings } from "./settings.js";

export const OPSBOT_D = "opsbot.d";

export const POINTS = ["heartbeat", "monitor", "cycle.begin", "cycle.end", "wake", "escalate"] as const;
export type Point = (typeof POINTS)[number];

export const POINT_DIRS: Record<Point, string> = {
  heartbeat: "heartbeat.d",
  monitor: "monitor.d",
  "cycle.begin": "cycle.d/begin",
  "cycle.end": "cycle.d/end",
  wake: "wake.d",
  escalate: "escalate.d",
};

/** Accept either the point name or its directory spelling. */
export function parsePoint(s: string): Point | null {
  const t = s.replace(/\/+$/, "");
  for (const p of POINTS) {
    if (p === t || POINT_DIRS[p] === t || POINT_DIRS[p] === `${t}.d` || `cycle.d/${t}` === POINT_DIRS[p]) return p;
  }
  return null;
}

export interface Script {
  point: Point;
  name: string;
  path: string;
  /** Where the file really lives (a symlink's target), relative to the root when inside it. */
  source: string;
}

export interface Skipped {
  point: Point;
  name: string;
  reason: string;
}

export function discover(root: string, point: Point): { scripts: Script[]; skipped: Skipped[] } {
  const dir = join(root, OPSBOT_D, POINT_DIRS[point]);
  const scripts: Script[] = [];
  const skipped: Skipped[] = [];
  if (!existsSync(dir)) return { scripts, skipped };
  const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      skipped.push({ point, name, reason: "a broken link" });
      continue;
    }
    if (st.isDirectory()) continue;
    if (!st.isFile()) {
      skipped.push({ point, name, reason: "not a regular file" });
      continue;
    }
    try {
      accessSync(path, constants.X_OK);
    } catch {
      skipped.push({ point, name, reason: "not executable" });
      continue;
    }
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // keep the path
    }
    const rel = relative(root, real);
    scripts.push({ point, name, path, source: rel.startsWith("..") ? real : rel });
  }
  return { scripts, skipped };
}

/**
 * The settings snapshot scripts read through OPSBOT_CONFIG: opsbot.json as
 * committed at HEAD, written into the git directory so a script reads what
 * was reviewed.
 */
export function configSnapshot(root: string, text: string): string {
  const p = gitPath(root, "opsbot-config.json");
  try {
    writeFileSync(p, text);
  } catch {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(p, text);
  }
  return p;
}

export function baseEnv(
  root: string,
  settings: Settings,
  configPath: string,
  point: Point,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPSBOT_ROOT: root,
    OPSBOT_CONFIG: configPath,
    OPSBOT_NAME: settings.name,
    OPSBOT_MARK: settings.mark,
    OPSBOT_HOOK: point,
    ...extra,
  };
}

export const SCRIPT_TIMEOUT_MS = 300_000;

export function runScript(script: Script, root: string, env: NodeJS.ProcessEnv, input?: string): RunResult {
  return run(script.path, [], { cwd: root, env, input, timeoutMs: SCRIPT_TIMEOUT_MS });
}
