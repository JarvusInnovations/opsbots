/**
 * Sleep: a bot that has been quiet long enough stops ticking (specs/skills/opsbot-core.md, Sleep).
 *
 * The decision is made by `cycle end` and by a `cycle begin` that found nothing. It writes
 * `.git/opsbot-sleep`, which the sleep timer (`sleep tick`), the nudge and the watchdog read:
 *
 *   {decided_at, by, quiet_since, due, due_what, wake_lines, began, compacted, looked_at,
 *    woken: {at, reason, event_at, sent} | null, escalated}
 *
 *   decided  the session was told to sleep; the timer compacts it once it is idle (going down)
 *   began    the sleep began (compacted, or marked begun without compaction)
 *   woken    the timer, or a listener's `nudge --now`, typed the loop prompt; `cycle begin` answers
 *            it by removing the file and logging a `wake` line
 *
 * The cycle log gets {at, outcome: "sleep", by, quiet_since, due} and {at, outcome: "wake",
 * reason, latency_s, slept_from, woken_at}. Readers treat the span between them as intended
 * silence: it is not a gap, and not a stop.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { baseEnv, configSnapshot, discover, runScript } from "./lifecycle.js";
import { gitPath, iso, parseIso } from "./repo.js";
import type { Settings } from "./settings.js";
import { CYCLE_OUTCOMES, lastCheck, type LogLine } from "./state.js";
import { lastArrival } from "./cadence.js";
import { type Ev, humanMessages } from "./transcript.js";
import { wakeFiles } from "./wake.js";

export const SLEEP_STATE = "opsbot-sleep";

export interface Woken {
  at: string;
  reason: string;
  /** When the event that caused the wake happened, for the wake's latency. */
  event_at: string;
  /** False while the prompt could not be typed (the timer tries again at its next tick). */
  sent: boolean;
}

export interface SleepState {
  decided_at: string;
  by: "cycle begin" | "cycle end";
  quiet_since: string;
  due: string | null;
  due_what: string | null;
  /** Line counts of each wake file when the sleep was decided: a line past them is an event. */
  wake_lines: Record<string, number>;
  began: string | null;
  compacted: boolean;
  looked_at: string | null;
  woken: Woken | null;
  escalated: boolean;
}

export function sleepFile(root: string): string {
  return gitPath(root, SLEEP_STATE);
}

export function readSleep(root: string): SleepState | null {
  try {
    const v = JSON.parse(readFileSync(sleepFile(root), "utf8"));
    return v && typeof v === "object" && typeof v.decided_at === "string" ? (v as SleepState) : null;
  } catch {
    return null;
  }
}

/** The state only when sleep is set: a file left behind after `sleep` was removed from
 * opsbot.json is ignored, so nothing stands down for a timer that no longer runs. */
export function activeSleep(root: string, s: Settings): SleepState | null {
  return s.sleep ? readSleep(root) : null;
}

export function writeSleep(root: string, st: SleepState): void {
  writeFileSync(sleepFile(root), `${JSON.stringify(st)}\n`);
}

export function clearSleep(root: string): void {
  rmSync(sleepFile(root), { force: true });
}

export const hhmm = (t: string) => `${t.slice(11, 16)}Z`;

/** Lines in a file, 0 when it does not exist. */
export function lineCount(file: string): number {
  try {
    const t = readFileSync(file, "utf8");
    if (!t) return 0;
    return t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

export function wakeLineCounts(s: Settings): Record<string, number> {
  return Object.fromEntries(wakeFiles(s).map((f) => [f, lineCount(f)]));
}

/** The operator's last message in the session log: the loop prompt (which the nudge and the sleep
 * timer type) and harness notifications are not the operator. */
export function lastOperatorAt(evs: Ev[], loopPrompt: string, after?: string): string | null {
  const prompt = loopPrompt.trim();
  let last: string | null = null;
  for (const m of humanMessages(evs)) {
    if (m.text.startsWith(prompt) || m.text.startsWith("<task-notification") || m.text.startsWith("<system-reminder")) continue;
    if (after && m.at <= after) continue;
    if (!last || m.at > last) last = m.at;
  }
  return last;
}

export interface Due {
  at: string;
  what: string;
}

/**
 * What is due, from every `due.d/` script: one line per thing, `<ISO time> <what>`. A script
 * that fails, or a line that does not open with a time, is a reason not to sleep: what is due
 * cannot be known.
 */
export function dueTimes(root: string, s: Settings, settingsText: string): { due: Due[]; problem: string | null } {
  const scripts = discover(root, "due").scripts;
  if (scripts.length === 0) return { due: [], problem: null };
  const configPath = configSnapshot(root, settingsText);
  const due: Due[] = [];
  for (const sc of scripts) {
    const r = runScript(sc, root, baseEnv(root, s, configPath, "due"));
    if (r.code !== 0) return { due, problem: `due.d/${sc.name} failed, exit ${r.code}` };
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [t, ...rest] = line.trim().split(/\s+/);
      const ms = parseIso(t ?? "");
      if (ms === null) return { due, problem: `due.d/${sc.name} printed a line that does not open with a time: ${line.slice(0, 80)}` };
      due.push({ at: iso(ms), what: rest.join(" ") || sc.name });
    }
  }
  due.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { due, problem: null };
}

/** The first line a cycle wrote, for a bot with no arrival logged yet. */
function firstCycleAt(lines: LogLine[]): string | null {
  for (const l of lines) if (CYCLE_OUTCOMES.includes(l.outcome)) return l.at;
  return null;
}

export type Decision = { sleep: true; state: SleepState } | { sleep: false; why: string };

/**
 * Whether the loop sleeps now: the last cycle that found anything, or the operator's last message,
 * is `after_minutes` or more ago; the last check was not degraded; and nothing is due within the
 * next `after_minutes`. Pure apart from the `due.d/` scripts it runs.
 */
export function decideSleep(
  root: string,
  s: Settings,
  settingsText: string,
  lines: LogLine[],
  now: number,
  evs: Ev[],
  by: SleepState["by"],
): Decision {
  const sl = s.sleep;
  if (!sl) return { sleep: false, why: "sleep is not set" };
  const check = lastCheck(lines);
  if (check?.outcome === "degraded") return { sleep: false, why: "the last check was degraded" };
  const candidates = [lastArrival(lines), lastOperatorAt(evs, s.loop.prompt)].filter((t): t is string => !!t);
  if (candidates.length === 0) {
    const first = firstCycleAt(lines);
    if (first) candidates.push(first);
  }
  const quietSince = candidates.sort().pop() ?? iso(now);
  const quietMs = now - (parseIso(quietSince) ?? now);
  const after = sl.after_minutes * 60_000;
  if (quietMs < after) return { sleep: false, why: `quiet for ${Math.floor(quietMs / 60_000)} of ${sl.after_minutes} minutes` };
  const { due, problem } = dueTimes(root, s, settingsText);
  if (problem) return { sleep: false, why: problem };
  const next = due[0] ?? null;
  if (next && (parseIso(next.at) ?? 0) < now + after) {
    return { sleep: false, why: `due at ${hhmm(next.at)}: ${next.what}` };
  }
  return {
    sleep: true,
    state: {
      decided_at: iso(now),
      by,
      quiet_since: quietSince,
      due: next?.at ?? null,
      due_what: next?.what ?? null,
      wake_lines: wakeLineCounts(s),
      began: null,
      compacted: false,
      looked_at: null,
      woken: null,
      escalated: false,
    },
  };
}

/** The latest the sleep lasts: the due time, or `max_minutes` after it was decided. */
export function wakeBy(s: Settings, st: SleepState): { at: string; why: string } {
  const max = (parseIso(st.decided_at) ?? 0) + (s.sleep?.max_minutes ?? 0) * 60_000;
  const due = st.due ? parseIso(st.due) : null;
  if (due !== null && due < max) return { at: iso(due), why: `due: ${st.due_what ?? "something"}` };
  return { at: iso(max), why: `${s.sleep?.max_minutes ?? 0} minutes asleep` };
}

/** The `sleep` field `cycle begin` and `cycle end` print in place of `wake`. */
export function sleepFieldLines(s: Settings, st: SleepState): string[] {
  const by = wakeBy(s, st);
  const quietMin = Math.floor(((parseIso(st.decided_at) ?? 0) - (parseIso(st.quiet_since) ?? 0)) / 60_000);
  return [
    `sleep now: quiet since ${hhmm(st.quiet_since)} (${quietMin} min), and nothing is due before ${hhmm(by.at)}`,
    "arm no monitor, call no ScheduleWakeup, start nothing in the background, and end your turn now",
    `the sleep timer ${s.sleep?.compact ? "compacts this session once it is idle, then " : ""}wakes it with the loop prompt when a stream has something, and by ${hhmm(by.at)} at the latest (${by.why})`,
    "when the loop prompt arrives, run `cycle begin` as after any wake",
  ];
}

/** The `sleep` cycle-log line. */
export function sleepLogLine(st: SleepState): Record<string, unknown> {
  return { at: st.decided_at, outcome: "sleep", by: st.by, quiet_since: st.quiet_since, due: st.due };
}

/** The `wake` cycle-log line `cycle begin` writes when it finds the sleep file. */
export function wakeLogLine(st: SleepState, now: number): Record<string, unknown> {
  const w = st.woken;
  const ev = w ? parseIso(w.event_at) : null;
  return {
    at: iso(now),
    outcome: "wake",
    reason: w ? w.reason : st.began ? "a cycle began with no wake recorded (the operator, or the session itself)" : "a cycle began before the sleep did",
    latency_s: ev !== null ? Math.max(0, Math.round((now - ev) / 1000)) : null,
    slept_from: st.began ?? st.decided_at,
    woken_at: w?.at ?? null,
  };
}

/**
 * The time from which silence counts as a stop. While asleep and not woken, none does (now).
 * Woken and not yet answered: from the wake. Otherwise the last cycle line or the end of the last
 * sleep, whichever is later, so a sleep...wake span in the log is never a gap.
 */
export function silenceFrom(lines: LogLine[], st: SleepState | null, now: number, lastCycle: string | null): string | null {
  if (st) return st.woken ? st.woken.at : iso(now);
  let last = lastCycle;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.outcome !== "wake") continue;
    const w = typeof l.woken_at === "string" ? l.woken_at : l.at;
    if (!last || w > last) last = w;
    break;
  }
  return last;
}

/** Sleep spans in the log: [from, to] where `to` is the wake (or null, still asleep). */
export function sleepSpans(lines: LogLine[]): Array<{ from: string; to: string | null }> {
  const spans: Array<{ from: string; to: string | null }> = [];
  for (const l of lines) {
    if (l.outcome === "sleep") spans.push({ from: l.at, to: null });
    else if (l.outcome === "wake" && spans.length && spans[spans.length - 1]!.to === null) {
      spans[spans.length - 1]!.to = typeof l.woken_at === "string" ? l.woken_at : l.at;
    }
  }
  return spans;
}

/** One line for the home view and `infra status`, or null when not asleep. */
export function sleepStatusLine(s: Settings, st: SleepState): string {
  if (st.woken) return `woken at ${hhmm(st.woken.at)} for: ${st.woken.reason}${st.woken.sent ? "" : " (the prompt has not landed yet)"}; waiting for cycle begin`;
  if (!st.began) return `going down since ${hhmm(st.decided_at)}: the sleep timer ${s.sleep?.compact ? "compacts the session" : "marks the sleep begun"} once it is idle`;
  const lastLook = st.looked_at ?? st.began;
  const next = iso((parseIso(lastLook) ?? 0) + (s.sleep?.probe_minutes ?? 10) * 60_000);
  return `asleep since ${hhmm(st.began)}, next look ${hhmm(next)}, wake by ${hhmm(wakeBy(s, st).at)}`;
}

export function sleepExists(root: string): boolean {
  return existsSync(sleepFile(root));
}
