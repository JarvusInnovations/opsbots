/**
 * home — the zero-arg view: the bot's name, the last cycle's outcome and age,
 * the lock, the next wake, failed inputs and open outages, and three next
 * steps. Never errors: anything it cannot read is said in its place.
 */
import { nextDelay, delayLine } from "../cadence.js";
import { cliInvocation } from "../invocation.js";
import { findRoot, nowMs, parseIso } from "../repo.js";
import { trySettings } from "../settings.js";
import { judgeLock, lastCheck, outages, readCycleLog } from "../state.js";

function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function homeCommand(): Record<string, unknown> {
  const cli = cliInvocation();
  const root = findRoot();
  if (!root) {
    return {
      bot: "not inside a git checkout",
      help: [`Run \`${cli}\` from the bot's repo (or set OPSBOT_ROOT)`],
    };
  }
  const s = trySettings(root);
  if (!s) {
    return {
      bot: "no valid opsbot.json in this repo",
      help: [
        "Copy the skill's templates/opsbot.json to the repo root as opsbot.json, fill it in, and commit it",
        `Run \`${cli} settings validate\` to see what is wrong`,
      ],
    };
  }
  const now = nowMs();
  const lines = readCycleLog(root);
  const last = [...lines].reverse().find((l) => ["nothing-new", "new", "degraded", "finished"].includes(l.outcome));
  const check = lastCheck(lines);
  const lock = judgeLock(root, s.lock_max_minutes);
  const open = outages(root).filter((o) => o.ended === null).length;
  const failed = check && Array.isArray(check.failed) ? check.failed.length : 0;
  const lastAt = last ? parseIso(last.at) : null;
  return {
    bot: `${s.mark} ${s.name}`,
    last_cycle: last ? `${last.outcome} · ${last.at}${lastAt !== null ? ` (${age(now - lastAt)})` : ""}` : "none logged yet",
    lock:
      lock.state === "free"
        ? "free"
        : lock.state === "held"
          ? `held by session ${lock.hold.session || "unknown"} since ${lock.hold.started}`
          : `abandoned: ${lock.note}`,
    next_wake: delayLine(nextDelay(s, lines, now)),
    failed_inputs: failed,
    open_outages: open,
    help: [
      `Run \`${cli} cycle begin\` to start a cycle`,
      `Run \`${cli} log tail\` for recent cycles, \`${cli} hooks list\` for what runs at each point`,
      `Run \`${cli} --help\` for every command`,
    ],
  };
}
