/**
 * start — launch the bot's Claude Code session with the flags opsbot.json implies, so no
 * operator (or herdr agent definition) has to remember them. Builds:
 *
 *   claude --permission-mode <loop.permission_mode>  (default auto)
 *          [--model <loop.model>]
 *          --settings '{"autoCompactEnabled":true,"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"<tokens>"}}'
 *                                                       (compaction can never be off for a bot; the window
 *                                                       is the env var, the one control Claude Code honors:
 *                                                       the --autocompact flag and autoCompactWindow were
 *                                                       ignored on two bots, the env var works on a third)
 *          [--resume <id | name>]                      (with --continue: resume the session that last
 *                                                       ran a cycle here, by id; when none is
 *                                                       recorded, by loop.session_name)
 *          --name <loop.session_name>                  (the bot's name by default)
 *          [extra args after --]
 *          "<loop.prompt>"                             (the first message, so the loop starts)
 *
 * --dry-run prints the argv instead of running it. Otherwise execs claude with inherited
 * stdio and exits with its code. A bot's repo carries a two-line bin/start shim that calls this.
 */
import { MODE_MODEL, type LoopMode } from "../settings.js";
import { spawnSync } from "node:child_process";
import { encode } from "@toon-format/toon";
import { parseArgs, setExit } from "../args.js";
import { findRoot } from "../repo.js";
import { trySettings } from "../settings.js";
import { readLoopSession } from "../state.js";

const USAGE = "start [--continue] [--dry-run] [-- <extra claude args>]";

/** "750k" → 750000, "1m" → 1000000, a bare number as is; null when unset or unreadable. */
export function autocompactTokens(v: string | null): number | null {
  if (!v) return null;
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function startArgv(s: { loop: { prompt: string; autocompact: string | null; model: string | null; permission_mode: string; mode?: LoopMode; session_name?: string } }, opts: { cont: boolean; extra: string[]; loopSession?: string | null }): string[] {
  const argv = ["claude", "--permission-mode", s.loop.permission_mode];
  // loop.model wins; else the mode's class (strategist → fable, dispatcher → opus)
  const model = s.loop.model ?? (s.loop.mode ? MODE_MODEL[s.loop.mode] : null);
  if (model) argv.push("--model", model);
  const window = autocompactTokens(s.loop.autocompact);
  argv.push("--settings", JSON.stringify(window ? { autoCompactEnabled: true, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } } : { autoCompactEnabled: true }));
  // The main session carries a name (loop.session_name, the bot's name by default): set when it
  // is created, shown in the picker and the terminal title, and how it is found again.
  // Resuming: by id when a cycle has recorded one (exact); else by that name. Never "the most
  // recent session in the directory": a person's session opened in the bot's checkout would be
  // that. A name that matches nothing, or more than one session, opens Claude Code's picker,
  // which the operator sees; that is the loud failure, not a wrong session.
  const name = s.loop.session_name;
  if (opts.cont) argv.push(...(opts.loopSession ? ["--resume", opts.loopSession] : name ? ["--resume", name] : ["--continue"]));
  if (name) argv.push("--name", name);
  argv.push(...opts.extra);
  argv.push(s.loop.prompt);
  return argv;
}

export function startCommand(args: string[]): string | Record<string, unknown> {
  const sep = args.indexOf("--");
  const own = sep >= 0 ? args.slice(0, sep) : args;
  const extra = sep >= 0 ? args.slice(sep + 1) : [];
  const { flags } = parseArgs(own, { bool: ["continue", "dry-run"] }, USAGE);
  setExit(0);
  const root = findRoot();
  if (!root) { setExit(1); return { error: "not inside a git checkout", help: ["Run from the bot's repo"] }; }
  const s = trySettings(root);
  if (!s) { setExit(1); return { error: "opsbot.json is missing or invalid", help: ["Run `settings validate`"] }; }
  const argv = startArgv(s, { cont: flags["continue"] === true, extra, loopSession: readLoopSession(root) });
  if (flags["dry-run"]) return { start: "would run", cwd: root, argv };
  // the env var also goes into the process environment: certain to be read at startup
  const window = autocompactTokens(s.loop.autocompact);
  const env = window ? { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } : process.env;
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "inherit", env });
  setExit(r.status ?? 1);
  return r.error ? encode({ error: `could not start claude: ${r.error.message}`, help: ["Is `claude` on PATH for this user?"] }) : "";
}
