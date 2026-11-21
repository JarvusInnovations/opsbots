/**
 * Test harness: a throwaway bot repo per test, and the CLI run against it as a
 * subprocess (so exit codes and stdout are exactly what an agent sees).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { forgetLogBranch, readPending, seenRecords, stage, type Rec } from "../src/opsbot-core/log";
import { outages, readCycleLog, readSeen, readWatermark, type LogLine, type Outage } from "../src/opsbot-core/state";

export const REPO = resolve(import.meta.dir, "..");
export const ENTRY = join(REPO, "src", "opsbot-core", "bin.ts");
export const BUNDLE = join(REPO, "skills", "opsbot-core", "scripts", "opsbot-core.mjs");
export const SHIM = join(REPO, "skills", "opsbot-core", "scripts", "opsbot-core");
export const FIXTURES = join(REPO, "tests", "fixtures", "opsbot.d");

export const BASE_SETTINGS = {
  name: "testbot",
  mark: "🧪",
  timezone: "UTC",
  rule_card: "rules.md",
  gate_word: "GOAHEAD",
  loop: { prompt: "/loop testbot cycle", autocompact: "300k" },
  runtime: { adapter: "herdr", agent: "testbot" },
};

export interface Bot {
  root: string;
  home: string;
  env: Record<string, string>;
  cleanup(): void;
}

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function git(root: string, ...args: string[]): string {
  return sh(root, "git", args);
}

/** Copy one lifecycle point's fixtures (or all of them) into the bot's opsbot.d/. */
export function installFixtures(root: string, points: string[]): void {
  for (const p of points) {
    const src = join(FIXTURES, p);
    const dst = join(root, "opsbot.d", p);
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
}

export function makeBot(opts: { settings?: Record<string, unknown>; points?: string[]; commit?: boolean } = {}): Bot {
  const home = mkdtempSync(join(tmpdir(), "opsbot-test-"));
  const root = join(home, "bot");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "opsbot.json"), JSON.stringify(opts.settings ?? BASE_SETTINGS, null, 2));
  writeFileSync(join(root, "rules.md"), "# Rule card\n\n1. Look before saying.\n2. A failed check is said out loud.\n");
  installFixtures(root, opts.points ?? ["heartbeat.d"]);
  if (opts.commit !== false) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  const env: Record<string, string> = {
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
  };
  return { root, home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function setSettings(bot: Bot, patch: Record<string, unknown>, commit = true): void {
  const cur = JSON.parse(readFileSync(join(bot.root, "opsbot.json"), "utf8"));
  writeFileSync(join(bot.root, "opsbot.json"), JSON.stringify({ ...cur, ...patch }, null, 2));
  if (commit) {
    git(bot.root, "add", "opsbot.json");
    git(bot.root, "commit", "-q", "-m", "settings");
  }
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

const STRIP = [
  "OPSBOT_ROOT",
  "OPSBOT_COMMIT_TRAILERS",
  "OPSBOT_COAUTHOR",
  "OPSBOT_TEST_NOW",
  "OPSBOT_RUNTIME_FAKE",
  "OPSBOT_SYSTEMCTL",
  "OPSBOT_TEMPLATES",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_PID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
];

/** `cli` without waiting: for runs that must overlap. */
export async function cliAsync(bot: Bot, args: string[], opts: { now?: string } = {}): Promise<Ran> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.includes(k)) env[k] = v;
  Object.assign(env, bot.env);
  if (opts.now) env.OPSBOT_TEST_NOW = opts.now;
  const p = Bun.spawn([process.execPath, ENTRY, ...args], { cwd: bot.root, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

export function cli(bot: Bot | null, args: string[], opts: { env?: Record<string, string>; now?: string; input?: string; cwd?: string } = {}): Ran {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.includes(k)) env[k] = v;
  Object.assign(env, bot?.env ?? {}, opts.env ?? {});
  if (opts.now) env.OPSBOT_TEST_NOW = opts.now;
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: opts.cwd ?? bot?.root ?? tmpdir(),
    env,
    input: opts.input ?? "",
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function readLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function writeStream(bot: Bot, items: Array<Record<string, unknown>>): string {
  const f = join(bot.home, "stream.ndjson");
  writeFileSync(f, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
  bot.env.FIXTURE_STREAM = f;
  return f;
}

export function makeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** The real path of a tool on PATH (an asdf shim resolved to what it runs), or null. */
export function realBin(name: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const p = r.status === 0 ? r.stdout.trim() : "";
  if (!p) return null;
  if (!p.includes("/shims/")) return p;
  const a = spawnSync("asdf", ["which", name], { encoding: "utf8" });
  return a.status === 0 ? a.stdout.trim() || null : null;
}

/**
 * What a skill script needs to reach the real core and gitsheets-axi from a test whose HOME and
 * PATH point into a temp dir: OPSBOT_CORE (a two-line wrapper running the source under bun),
 * OPSBOT_GITSHEETS_AXI, and the directories of git and gitsheets-axi for PATH.
 */
export function coreForScripts(dir: string): { env: Record<string, string>; path: string } {
  const gs = realBin("gitsheets-axi");
  if (!gs) throw new Error("gitsheets-axi is not installed; the log-branch tests need it");
  const wrapper = join(dir, "opsbot-core");
  writeFileSync(wrapper, `#!/bin/sh\nunset NODE_OPTIONS\nexec "${process.execPath}" "${ENTRY}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const gitBin = realBin("git") ?? "/usr/bin/git";
  return { env: { OPSBOT_CORE: wrapper, OPSBOT_GITSHEETS_AXI: gs }, path: [resolve(gs, ".."), resolve(gitBin, "..")].join(":") };
}

/** Turn a skill test's throwaway repo into one on the log branch: settings merged, committed. */
export function commitOnBranch(root: string, logSettings: Record<string, unknown>): void {
  const p = join(root, "opsbot.json");
  const cur = JSON.parse(readFileSync(p, "utf8"));
  // the core reads the settings whole: a skill test's partial file gets the keys it requires
  const required = { loop: { prompt: "Run one cycle." }, runtime: { adapter: "herdr", agent: String(cur.name ?? "examplebot") } };
  writeFileSync(p, JSON.stringify({ ...required, ...cur, log: logSettings }, null, 2));
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) git(root, "config", k!, v!);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "on the log branch");
}

// ------------------------------------------------------------------ the log, read as the core reads it

/** The cycle log as lines (the log branch's records, quiet runs and what is staged). */
export function logOf(b: Bot): LogLine[] {
  forgetLogBranch();
  return readCycleLog(b.root);
}

export function outagesOf(b: Bot): Outage[] {
  forgetLogBranch();
  return outages(b.root);
}

export function watermarkOf(b: Bot): string | null {
  forgetLogBranch();
  return readWatermark(b.root);
}

export function seenOf(b: Bot): string[] {
  forgetLogBranch();
  return [...readSeen(b.root)];
}

/** Stage cycle lines and seen keys for the next log commit, as the core does between commits. */
export function stageLog(b: Bot, add: { cycles?: Rec[]; seen?: string[] }): void {
  stage(b.root, { cycles: add.cycles ?? [], seen: seenRecords(add.seen ?? [], new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) });
}

/** What is staged for the next log commit. */
export function stagedOf(b: Bot): Record<string, Rec[]> {
  return readPending(b.root) as unknown as Record<string, Rec[]>;
}

/** The log branch's commit subjects, newest first. */
export function logSubjects(b: Bot, branch = "opsbot/log"): string[] {
  const r = spawnSync("git", ["-C", b.root, "log", "--format=%s", branch], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
}
