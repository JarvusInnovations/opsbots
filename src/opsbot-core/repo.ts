/**
 * The bot's checkout: where it is, what git says about it, and the clock.
 *
 * The root is $OPSBOT_ROOT when set (units and hooks may set it), else the git
 * top level of the working directory. The clock is the system clock;
 * OPSBOT_TEST_NOW, an ISO-8601 UTC time, replaces it in tests only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: `${cmd}: not found` };
  }
  const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  return {
    code: timedOut ? 124 : (r.status ?? (r.signal ? 128 : 1)),
    stdout: r.stdout ?? "",
    stderr: timedOut ? `timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s` : (r.stderr ?? ""),
  };
}

export function git(root: string, args: string[], input?: string): RunResult {
  return run("git", ["-C", root, ...args], { input });
}

/** The repo root, or null when not inside a git checkout. */
export function findRoot(cwd: string = process.cwd()): string | null {
  const env = process.env.OPSBOT_ROOT;
  if (env) return resolve(env);
  const r = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

export function requireRoot(): string {
  const root = findRoot();
  if (!root) {
    throw new AxiError("not inside a git checkout", "CANNOT_RUN", [
      "Run it from the bot's repo, or set OPSBOT_ROOT to its path",
    ]);
  }
  return root;
}

/** A path inside this checkout's own git directory: never committed, one per worktree. */
export function gitPath(root: string, name: string): string {
  const r = git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  if (r.code !== 0) return join(root, ".git", name);
  return r.stdout.trim();
}

export function hasHead(root: string): boolean {
  return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).code === 0;
}

/** A file as committed at HEAD, or null. */
export function showHead(root: string, path: string): string | null {
  const r = git(root, ["show", `HEAD:${path}`]);
  return r.code === 0 ? r.stdout : null;
}

const BLOCKERS: Array<[string, string]> = [
  ["rebase-merge", "a rebase is in progress"],
  ["rebase-apply", "a rebase is in progress"],
  ["MERGE_HEAD", "a merge is in progress"],
  ["CHERRY_PICK_HEAD", "a cherry-pick is in progress"],
  ["REVERT_HEAD", "a revert is in progress"],
  ["BISECT_LOG", "a bisect is in progress"],
  ["index.lock", "the git index is locked (index.lock)"],
];

/** What else is at work in the checkout, or null when nothing is. */
export function blockedBy(root: string): string | null {
  for (const [p, why] of BLOCKERS) {
    if (existsSync(gitPath(root, p))) return why;
  }
  return null;
}

/**
 * The trailers the core's commits end with. OPSBOT_COMMIT_TRAILERS wins when
 * set; otherwise OPSBOT_COAUTHOR, and a Claude-Session line while the session
 * has a Remote Control connection (CLAUDE_CODE_BRIDGE_SESSION_ID).
 */
export function trailers(): string {
  const env = process.env;
  if (env.OPSBOT_COMMIT_TRAILERS) return env.OPSBOT_COMMIT_TRAILERS;
  const out: string[] = [];
  if (env.OPSBOT_COAUTHOR) out.push(env.OPSBOT_COAUTHOR);
  if (env.CLAUDE_CODE_BRIDGE_SESSION_ID) {
    out.push(`Claude-Session: https://claude.ai/code/${env.CLAUDE_CODE_BRIDGE_SESSION_ID}`);
  }
  return out.join("\n");
}

/** Stage and commit exactly these files (`--only`). Returns null on success, else why. */
export function commitOnly(root: string, files: string[], subject: string): string | null {
  const t = trailers();
  const msg = t ? `${subject}\n\n${t}` : subject;
  const add = git(root, ["add", "--", ...files]);
  if (add.code !== 0) return firstLine(add.stderr) || "git add failed";
  const c = git(root, ["commit", "-q", "--only", "-m", msg, "--", ...files]);
  if (c.code !== 0) return firstLine(c.stderr || c.stdout) || "git commit failed";
  return null;
}

/**
 * Push the branch to origin, so what the cycle commits is where its links
 * point. Null when pushed; otherwise why not. Never forces, never pulls.
 */
export function pushCommits(root: string): string | null {
  const b = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (b.code !== 0) return "not on a branch";
  if (git(root, ["remote", "get-url", "origin"]).code !== 0) return "no remote named origin";
  const r = run("git", ["-C", root, "push", "-q", "origin", `HEAD:refs/heads/${b.stdout.trim()}`], {
    timeoutMs: 60_000,
  });
  if (r.code === 0) return null;
  const err = r.stderr
    .split("\n")
    .filter((l) => l.trim())
    .pop();
  return `push failed: ${(err ?? "timed out after 60 s").slice(0, 120)}`;
}

export function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? "").trim();
}

// ------------------------------------------------------------------ clock

export function nowMs(): number {
  const t = process.env.OPSBOT_TEST_NOW;
  if (t) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowIso(): string {
  return iso(nowMs());
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Epoch ms of an ISO time, or null when it cannot be read. */
export function parseIso(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Local wall-clock parts in a zone: ISO weekday 1–7 and "HH:MM". */
export function localParts(ms: number, timeZone: string): { dow: number; hm: string } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { dow: dows.indexOf(parts.weekday ?? "Mon") + 1, hm: `${parts.hour}:${parts.minute}` };
}

/** A time for a person to read, in the bot's zone, 12-hour: "Tue Oct 21, 1:43 PM EDT". */
export function humanTime(ms: number, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
