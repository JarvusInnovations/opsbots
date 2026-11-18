/**
 * wake wait --until <epoch seconds> — the schedule monitor's poller.
 *
 * Run by the session's one `Monitor` call and by nothing else. From the line counts the last check
 * recorded in <git dir>/opsbot-wake-base it polls every 2 seconds and prints the new lines of any
 * wake file (each prefixed with the file's basename, cut to 300 characters, at most 20 per file),
 * or `cycle due` when the time passes; either way it exits 0. A time more than 1 800 seconds ahead
 * is refused (exit 2): the harness kills a Monitor at 30 minutes.
 */
import { AxiError } from "axi-sdk-js";
import { parseArgs } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { nowMs, requireRoot } from "../repo.js";
import { loadSettings } from "../settings.js";
import { WAKE_WAIT_MAX_S, readWakeBase, wakeFiles, wakeWait } from "../wake.js";

export const WAKE_USAGE = "wake wait --until <epoch seconds>";

export async function wakeCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "wait") {
    throw new AxiError(sub ? `unknown wake subcommand ${sub}` : "wake needs a subcommand", "VALIDATION_ERROR", [`${cliInvocation()} ${WAKE_USAGE}`]);
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
