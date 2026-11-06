/**
 * Test harness: a throwaway bot repo per test, and the CLI run against it as a
 * subprocess (so exit codes and stdout are exactly what an agent sees).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  "CLAUDE_PID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
];

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
