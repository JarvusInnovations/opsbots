/**
 * sleep tick — the sleep timer's one command, run by a system timer every `sleep.probe_minutes`.
 * No model is involved. A no-op unless `.git/opsbot-sleep` exists and `sleep` is set.
 *
 *   going down  the session was told to sleep. Once the runtime reports it idle (the nudge's
 *               idle test, session log included), types `/compact` when `sleep.compact` is set,
 *               and marks the sleep begun.
 *   asleep      wakes the session (types `loop.prompt (woken: <reason>)`) when the operator
 *               wrote to it, a wake file has a line past the one counted at the decision, the
 *               due time has passed, `max_minutes` is up, or `check --peek` exits 10 or 20;
 *               otherwise records its look and does nothing. The cheap tests run first; the
 *               peek only while asleep.
 *   woken       waits for `cycle begin`; retries a prompt that did not land; past
 *               `watchdog_minutes` tells the operator once through escalate.d/ and records a
 *               `stopped` outage from the wake.
 *
 * Something to wake for while going down is a wake, not a compaction. --dry-run types and
 * writes nothing. Exit 1 when the runtime could not be reached or the operator could not be told.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { humanTime, iso, nowMs, parseIso, requireRoot } from "../repo.js";
import { runtimeFor } from "../runtime.js";
import { loadSettings, type Settings } from "../settings.js";
import { lastOperatorAt, lineCount, readSleep, sleepStatusLine, wakeBy, writeSleep, type SleepState } from "../sleep.js";
import { openOutage, recordOutage } from "../state.js";
import { readEvents } from "../transcript.js";
import { runPeek } from "./check.js";
import { sessionPointer } from "./coldstart.js";
import { escalate, sessionIdle } from "./liveness.js";

export const SLEEP_USAGE = "sleep tick [--dry-run]";
export const COMPACT = "/compact";

/** What the wake types: the loop prompt, then the reason on the same line. */
export function wakePrompt(s: Settings, reason: string): string {
  return `${s.loop.prompt} (woken: ${reason})`;
}

export function sleepCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "tick") {
    throw new AxiError(sub ? `unknown sleep subcommand ${sub}` : "sleep needs a subcommand", "VALIDATION_ERROR", [`${cliInvocation()} ${SLEEP_USAGE}`]);
  }
  const { flags } = parseArgs(rest, { bool: ["dry-run"] }, SLEEP_USAGE);
  return sleepTick(flags["dry-run"] === true);
}

interface Reason {
  reason: string;
  event_at: string;
}

const mtime = (f: string): string | null => {
  try {
    return iso(statSync(f).mtimeMs);
  } catch {
    return null;
  }
};

/** The reasons that cost nothing to test: the operator, a wake file, the due time, max_minutes. */
function cheapReason(root: string, s: Settings, st: SleepState, now: number): Reason | null {
  const ptr = sessionPointer(root);
  const op = ptr ? lastOperatorAt(readEvents(ptr.transcript_path), s.loop.prompt, st.decided_at) : null;
  if (op) return { reason: "the operator wrote to the session", event_at: op };
  for (const [file, base] of Object.entries(st.wake_lines)) {
    const n = lineCount(file);
    // more lines, or a file rotated and written again
    if (n > base || (n < base && n > 0)) return { reason: `a new line in ${basename(file)}`, event_at: mtime(file) ?? iso(now) };
  }
  const by = wakeBy(s, st);
  if ((parseIso(by.at) ?? Infinity) <= now) return { reason: by.why, event_at: by.at };
  return null;
}

function peekReason(root: string, now: number): Reason | null {
  try {
    const p = runPeek(root);
    if (p.code === 10) {
      const where = p.inputs.filter((i) => i.new > 0).map((i) => i.input).join(", ");
      return { reason: `a peek found ${p.new} new (${where})`, event_at: p.earliest ?? iso(now) };
    }
    if (p.code === 20) {
      const bad = p.inputs.filter((i) => !i.ok).map((i) => i.input).join(", ");
      return { reason: `a peek found a stream failing (${bad})`, event_at: iso(now) };
    }
    return null;
  } catch (e) {
    return { reason: `the peek could not run: ${(e as Error).message}`, event_at: iso(now) };
  }
}

function sleepTick(dry: boolean): Record<string, unknown> {
  const root = requireRoot();
  const { settings: s, text } = loadSettings(root);
  if (!s.sleep) return { sleep: "sleep is not set in opsbot.json (no-op)" };
  const st = readSleep(root);
  if (!st) return { sleep: "awake (no-op)" };
  const now = nowMs();
  const save = (next: SleepState) => {
    if (!dry) writeSleep(root, next);
  };

  if (st.woken) return answerWatch(root, s, text, st, now, dry, save);

  const cheap = cheapReason(root, s, st, now);
  const reason = cheap ?? (st.began ? peekReason(root, now) : null);
  if (reason) return wake(root, s, st, reason, now, dry, save);

  if (!st.began) return goDown(root, s, st, now, dry, save);

  save({ ...st, looked_at: iso(now) });
  return { sleep: sleepStatusLine(s, { ...st, looked_at: iso(now) }) };
}

/** Going down: compact once the session is idle, then the sleep has begun. */
function goDown(root: string, s: Settings, st: SleepState, now: number, dry: boolean, save: (x: SleepState) => void): Record<string, unknown> {
  const agent = s.runtime.agent;
  const rt = runtimeFor(s);
  const found = rt.get(agent);
  if (!found.ok) {
    setExit(1);
    return { sleep: `going down · cannot reach the session: ${found.code === "agent_not_found" ? `the runtime has no agent named ${agent}` : `${rt.name}: ${found.code}: ${found.message}`}` };
  }
  const idle = sessionIdle(root, agent, found);
  if (!idle.idle) return { sleep: `going down · waiting: ${idle.why}` };
  const compact = s.sleep!.compact;
  if (dry) return { sleep: compact ? `going down · would type ${COMPACT} into ${agent} (${found.pane})${idle.via}` : "going down · would mark the sleep begun (sleep.compact is false)" };
  if (!compact) {
    save({ ...st, began: iso(now), looked_at: iso(now) });
    return { sleep: `asleep · began without compacting (sleep.compact is false)` };
  }
  const r = rt.prompt(agent, COMPACT);
  if (!r.ok) {
    // refused before anything was sent: try again at the next tick; anything else may have landed
    if (r.code !== "agent_blocked" && r.code !== "agent_not_found") save({ ...st, began: iso(now), compacted: true, looked_at: iso(now) });
    setExit(1);
    return { sleep: `going down · cannot · ${rt.name} prompt ${agent}: ${r.code}: ${r.message}` };
  }
  save({ ...st, began: iso(now), compacted: true, looked_at: iso(now) });
  return { sleep: `asleep · typed ${COMPACT} into ${agent}${idle.via}`, at: iso(now) };
}

/** Type the loop prompt with the reason. A refused or failed prompt is still recorded as the
 * wake (not sent), so a session that cannot be reached becomes an outage. */
function wake(root: string, s: Settings, st: SleepState, why: Reason, now: number, dry: boolean, save: (x: SleepState) => void): Record<string, unknown> {
  const agent = s.runtime.agent;
  const text = wakePrompt(s, why.reason);
  const record = (sent: boolean) => save({ ...st, woken: { at: st.woken?.at ?? iso(now), reason: why.reason, event_at: why.event_at, sent } });
  const rt = runtimeFor(s);
  const found = rt.get(agent);
  if (!found.ok) {
    if (!dry) record(false);
    setExit(1);
    return { sleep: `wake for: ${why.reason} · cannot reach the session: ${found.code === "agent_not_found" ? `the runtime has no agent named ${agent}` : `${rt.name}: ${found.code}: ${found.message}`}` };
  }
  const idle = sessionIdle(root, agent, found);
  if (!idle.idle) {
    // busy (the operator, most likely): wake it when its turn ends. At a dialog: the wake is
    // recorded unsent, so the outage clock runs.
    if (idle.blocked && !dry) record(false);
    return { sleep: `wake for: ${why.reason} · waiting: ${idle.why}` };
  }
  if (dry) return { sleep: `would wake ${agent} (${found.pane}) for: ${why.reason}`, prompt: text };
  const r = rt.prompt(agent, text);
  if (!r.ok) {
    record(r.code !== "agent_blocked" && r.code !== "agent_not_found");
    setExit(1);
    return { sleep: `wake for: ${why.reason} · cannot · ${rt.name} prompt ${agent}: ${r.code}: ${r.message}` };
  }
  record(true);
  return { sleep: `woke ${agent} for: ${why.reason}${idle.via}`, at: iso(now) };
}

/** Woken: wait for `cycle begin`, retry a prompt that did not land, and past watchdog_minutes
 * tell the operator once. */
function answerWatch(root: string, s: Settings, text: string, st: SleepState, now: number, dry: boolean, save: (x: SleepState) => void): Record<string, unknown> {
  const w = st.woken!;
  const wokenMs = parseIso(w.at) ?? now;
  const mins = Math.floor((now - wokenMs) / 60_000);
  const watch = s.liveness.watchdog_minutes;
  if (mins < watch || st.escalated) {
    if (!w.sent) return wake(root, s, st, { reason: w.reason, event_at: w.event_at }, now, dry, save);
    return { sleep: `${sleepStatusLine(s, st)} (${mins} min)${st.escalated ? " · the operator already told" : ""}` };
  }

  const seen: string[] = [];
  const rt = runtimeFor(s);
  const found = rt.get(s.runtime.agent);
  if (found.ok) {
    if (found.status === "blocked") seen.push("The bot's session is waiting at a permission or question dialog.");
    else seen.push(`The runtime says the session is ${found.status}.`);
  } else if (found.code === "agent_not_found") seen.push(`The runtime has no agent named ${s.runtime.agent}, so the session itself is not running.`);
  if (!w.sent) seen.push("The wake could not be typed into the session.");
  const message = [
    `${s.mark} ${s.name} was asleep and was woken at ${humanTime(wokenMs, s.timezone)} for: ${w.reason}. No cycle has begun since, over ${watch} minutes ago, so nothing is being read or answered.`,
    ...seen,
    "The sleep timer will not repeat this for the same wake.",
  ].join("\n");
  if (dry) return { sleep: `woken ${mins} min ago and unanswered · would tell the operator`, message: message.split("\n") };
  const results = escalate(root, s, text, message);
  if (results === null) {
    setExit(1);
    return { sleep: `woken ${mins} min ago and unanswered · cannot tell the operator: no script in opsbot.d/escalate.d/` };
  }
  if (!results.some((r) => r.ok)) {
    setExit(1);
    return { sleep: `woken ${mins} min ago and unanswered · cannot tell the operator: every escalation script failed`, escalations: results };
  }
  save({ ...st, escalated: true });
  if (!openOutage(root)) {
    recordOutage(root, { kind: "stopped", started: w.at, note: `woken for: ${w.reason}; no cycle began within ${watch} minutes. ${seen.join(" ")}`.trim() });
  }
  return { sleep: `woken ${mins} min ago and unanswered · the operator told · outage recorded`, escalations: results };
}
