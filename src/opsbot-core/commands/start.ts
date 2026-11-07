/**
 * start — launch the bot's Claude Code session with the flags opsbot.json implies, so no
 * operator (or herdr agent definition) has to remember them. Builds:
 *
 *   claude --permission-mode <loop.permission_mode>  (default auto)
 *          [--model <loop.model>]
 *          [--autocompact <loop.autocompact>]
 *          --settings '{"autoCompactEnabled":true}'   (compaction can never be off for a bot)
 *          [--continue]                                (with --continue: resume the last session here)
 *          [extra args after --]
 *          "<loop.prompt>"                             (the first message, so the loop starts)
 *
 * --dry-run prints the argv instead of running it. Otherwise execs claude with inherited
 * stdio and exits with its code. A bot's repo carries a two-line bin/start shim that calls this.
 */
import { spawnSync } from "node:child_process";
import { encode } from "@toon-format/toon";
import { parseArgs, setExit } from "../args.js";
import { findRoot } from "../repo.js";
import { trySettings } from "../settings.js";

const USAGE = "start [--continue] [--dry-run] [-- <extra claude args>]";

export function startArgv(s: { loop: { prompt: string; autocompact: string | null; model: string | null; permission_mode: string } }, opts: { cont: boolean; extra: string[] }): string[] {
  const argv = ["claude", "--permission-mode", s.loop.permission_mode];
  if (s.loop.model) argv.push("--model", s.loop.model);
  if (s.loop.autocompact) argv.push("--autocompact", s.loop.autocompact);
  argv.push("--settings", JSON.stringify({ autoCompactEnabled: true }));
  if (opts.cont) argv.push("--continue");
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
  const argv = startArgv(s, { cont: flags["continue"] === true, extra });
  if (flags["dry-run"]) return { start: "would run", cwd: root, argv };
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "inherit" });
  setExit(r.status ?? 1);
  return r.error ? encode({ error: `could not start claude: ${r.error.message}`, help: ["Is `claude` on PATH for this user?"] }) : "";
}
