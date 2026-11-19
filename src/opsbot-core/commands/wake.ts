/**
 * wake backstop — the listeners' one wake routine (see ../backstop.ts).
 *
 * wake wait --until <epoch seconds> — the schedule monitor's poller.
 *
 * Run by the session's one `Monitor` call and by nothing else. From the line counts the last check
 * recorded in <git dir>/opsbot-wake-base it polls every 2 seconds and prints the new lines of any
 * wake file (each prefixed with the file's basename, cut to 300 characters, at most 20 per file),
 * or `cycle due` when the time passes; either way it exits 0. A time more than 1 800 seconds ahead
 * is refused (exit 2): the harness kills a Monitor at 30 minutes.
 */
import { existsSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit, usageError } from "../args.js";
import { BACKSTOP_GRACE_S, BACKSTOP_LIMIT_MS, backstop, cycleBegunSince, keySeen } from "../backstop.js";
import { cliInvocation } from "../invocation.js";
import { gitPath, nowMs, requireRoot } from "../repo.js";
import { loadSettings } from "../settings.js";
import { WAKE_WAIT_MAX_S, readWakeBase, wakeFiles, wakeWait } from "../wake.js";
import { nudgeCommand } from "./liveness.js";

export const WAKE_USAGE = "wake wait --until <epoch seconds>";
export const BACKSTOP_USAGE = "wake backstop --key <key> --at <ISO time> [--grace <seconds>] --reason <text>";

export async function wakeCommand(args: string[]): Promise<string | Record<string, unknown>> {
  const [sub, ...rest] = args;
  if (sub === "backstop") return backstopCommand(rest);
  if (sub !== "wait") {
    throw new AxiError(sub ? `unknown wake subcommand ${sub}` : "wake needs a subcommand", "VALIDATION_ERROR", [`${cliInvocation()} ${WAKE_USAGE}`, `${cliInvocation()} ${BACKSTOP_USAGE}`]);
  }
  const { flags } = parseArgs(rest, { value: ["until"] }, WAKE_USAGE);
  const raw = flags.until;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new AxiError("--until must be a time in whole epoch seconds", "VALIDATION_ERROR", [`${cliInvocation()} ${WAKE_USAGE}`]);
  }
  const untilMs = Number(raw) * 1000;
  const now = nowMs();
  if (untilMs - now > WAKE_WAIT_MAX_S * 1000) {
    throw new AxiError(
      `--until ${raw} is ${Math.round((untilMs - now) / 1000)} seconds ahead; a monitor waits ${WAKE_WAIT_MAX_S} at most`,
      "VALIDATION_ERROR",
      ["Arm the call `cycle end` printed, exactly as printed"],
    );
  }
  const root = requireRoot();
  const { settings } = loadSettings(root);
  // the deadline in real time, so a test clock (OPSBOT_TEST_NOW) still lets the poller run
  return wakeWait(wakeFiles(settings), readWakeBase(root), Date.now() + (untilMs - now));
}

const envMs = (name: string): number | undefined => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * wake backstop: one listener event's wake, from the grace to the last nudge. Prints one line,
 * `backstop: <what happened>`, and exits 0 whatever happened; its progress notes (a cycle it
 * waits out, a nudge that is pending) go to stderr, one line each, for the listener's journal.
 */
async function backstopCommand(args: string[]): Promise<Record<string, unknown>> {
  const { flags } = parseArgs(args, { value: ["key", "at", "grace", "reason"] }, BACKSTOP_USAGE);
  const key = typeof flags.key === "string" ? flags.key : "";
  if (!key) throw usageError("--key is required: the event's key, as the check records it in logs/intake/seen", BACKSTOP_USAGE);
  const at = typeof flags.at === "string" ? Date.parse(flags.at) : NaN;
  if (!Number.isFinite(at)) throw usageError("--at is required: the event's time, ISO 8601", BACKSTOP_USAGE);
  const reason = typeof flags.reason === "string" ? flags.reason : "";
  if (!reason) throw usageError("--reason is required: what the nudge says it woke the session for", BACKSTOP_USAGE);
  let graceS = BACKSTOP_GRACE_S;
  if (flags.grace !== undefined) {
    if (typeof flags.grace !== "string" || !/^\d+$/.test(flags.grace)) throw usageError("--grace must be a whole number of seconds, 0 or more", BACKSTOP_USAGE);
    graceS = Number(flags.grace);
  }
  const root = requireRoot();
  const lockFile = gitPath(root, "opsbot-cycle.lock");
  const sleepFile = gitPath(root, "opsbot-sleep");
  // a listener that has exited leaves no reader for the notes: never die of it
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const line = await backstop({
    graceS,
    tick: envMs("OPSBOT_WAKE_TICK_MS") ?? 1000,
    limitMs: envMs("OPSBOT_WAKE_LIMIT_MS") ?? BACKSTOP_LIMIT_MS,
    at,
    nudge: async () => {
      try {
        const r = nudgeCommand(["--now", "--reason", reason]);
        return { outcome: String(r.outcome ?? ""), text: String(r.nudge ?? "") };
      } catch (e) {
        return { outcome: "cannot", text: `cannot · ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
      } finally {
        // the nudge sets exit 1 when the runtime fails; the backstop exits 0 whatever happened
        setExit(0);
      }
    },
    seen: () => keySeen(root, key),
    begunSince: (t) => cycleBegunSince(root, t),
    cycleRunning: () => existsSync(lockFile),
    asleep: () => existsSync(sleepFile),
    note: (l) => { try { process.stderr.write(`${l}\n`); } catch { /* the reader went away */ } },
  });
  setExit(0);
  return { backstop: line };
}
