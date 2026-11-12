/**
 * The live wake: how a stream's new event reaches the model between cycles.
 *
 * Two paths, in this order. First, in-band: the session arms a bounded Monitor on each
 * wake file (settings.wake.files). The harness delivers the first new line as a
 * notification whether or not background work is running, and the monitor exits on that
 * line or at its deadline, which never passes the loop's own next wake and never passes
 * 30 minutes, so it cannot become a loop that re-arms itself. Second, out-of-band: the
 * listener's `nudge --now`, which survives the session and covers a session that never
 * armed. Both read the same files; neither depends on the other.
 */
import { homedir } from "node:os";
import { iso, parseIso } from "./repo.js";
import type { Settings } from "./settings.js";
import { type Ev, lastMonitorCall } from "./transcript.js";

/** The harness caps a Monitor at 30 minutes. */
export const MONITOR_MAX_MS = 1_800_000;
export const MONITOR_MIN_MS = 60_000;

export function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

export function wakeFiles(s: Settings): string[] {
  return s.wake.files.map(expandHome);
}

/** A poller that prints the new lines once and exits: one notification per arrival, nothing left
 * running, and a shrunken file (rotation) resets the baseline instead of going silent. */
export function monitorCommand(file: string): string {
  const q = JSON.stringify(file);
  return (
    `f=${q}; c() { [ -f "$f" ] && wc -l < "$f" || echo 0; }; n=$(c); ` +
    `while sleep 2; do m=$(c); if [ "$m" -lt "$n" ]; then n=$m; fi; ` +
    `if [ "$m" -gt "$n" ]; then tail -n $((m-n)) "$f" | cut -c1-300; exit 0; fi; done`
  );
}

export function monitorDescription(bot: string, file: string): string {
  return `${bot} wake: new lines in ${file}`;
}

/** The exact tool call the session makes. */
export function monitorCall(bot: string, file: string, timeoutMs: number): string {
  return `Monitor({ command: ${JSON.stringify(monitorCommand(file))}, description: ${JSON.stringify(monitorDescription(bot, file))}, timeout_ms: ${timeoutMs} })`;
}

/** The deadline: the loop's own next wake when that is sooner than the cap, never under a minute. */
export function monitorTimeout(untilNextWakeMs: number | null): number {
  const t = untilNextWakeMs === null ? MONITOR_MAX_MS : Math.min(MONITOR_MAX_MS, untilNextWakeMs);
  return Math.max(MONITOR_MIN_MS, Math.round(t / 1000) * 1000);
}

export interface WakeState {
  file: string;
  armed: { at: string; until: string } | null;
}

/** What the session log says about each file: armed until when, or not armed. */
export function wakeStates(evs: Ev[], files: string[], now: number): WakeState[] {
  return files.map((file) => {
    const m = lastMonitorCall(evs, file);
    if (!m) return { file, armed: null };
    const at = parseIso(m.at);
    if (at === null || m.ended) return { file, armed: null };
    const until = at + m.timeoutMs;
    if (until <= now) return { file, armed: null };
    return { file, armed: { at: iso(at), until: iso(until) } };
  });
}

const hhmm = (s: string) => `${s.slice(11, 16)}Z`;

/**
 * The lines every surface prints about the wake: the state of each file (when a session log is
 * at hand), then the exact call to arm. `evs` null means no session log was available, so the
 * state is unknown and the call is printed as the thing to do.
 */
export function wakeLines(s: Settings, evs: Ev[] | null, now: number, untilNextWakeMs: number | null): string[] {
  const files = wakeFiles(s);
  if (files.length === 0) return [];
  const timeout = monitorTimeout(untilNextWakeMs);
  const states = evs ? wakeStates(evs, files, now) : files.map((file) => ({ file, armed: null as WakeState["armed"] }));
  const out: string[] = [];
  for (const st of states) {
    if (st.armed) out.push(`armed on ${st.file} until ${hhmm(st.armed.until)} (since ${hhmm(st.armed.at)}); nothing to do`);
    else out.push(`${evs ? "not armed" : "state unknown (no session log)"} on ${st.file} · arm now: ${monitorCall(s.name, st.file, timeout)}`);
  }
  return out;
}

/** The standing rules, for the pack. */
export const WAKE_RULES = [
  "The monitor is the live wake: its notification means a stream has something new, so run `cycle begin` then.",
  "It exits on the first arrival or at its deadline. Arm it again at the end of every cycle when it is not armed, and when it reports an expiry with nothing delivered; never two on one file, never a longer deadline, never a different command.",
  "The listener's nudge is the backstop when no monitor is armed; neither path depends on the other.",
];

// ---------------------------------------------------------- the schedule monitor
//
// With loop.schedule "monitor", one bounded Monitor is both the schedule and the live wake. Its
// command bakes in the seconds until the next cycle is due and exits on its own: with the new lines
// of any wake file (each prefixed with the file's basename), or with one line, `cycle due`. The
// harness's timeout is that deadline plus a margin, so the harness never has to kill it.

/** The harness's timeout over the command's own deadline. */
export const SCHEDULE_MARGIN_S = 60;
export const CYCLE_DUE = "cycle due";

/** The fixed description the kit finds the schedule monitor by in the session log. */
export function scheduleDescription(bot: string): string {
  return `${bot} schedule`;
}

/** A shell single-quoted word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** The command: polls every 2 seconds until a wake file grows or `seconds` pass. */
export function scheduleCommand(files: string[], seconds: number): string {
  const parts = [`end=$(( $(date +%s) + ${Math.max(1, Math.round(seconds))} ))`];
  if (files.length) parts.push(`c() { [ -f "$1" ] && wc -l < "$1" || echo 0; }`);
  files.forEach((f, i) => parts.push(`f${i}=${shq(f)}; n${i}=$(c "$f${i}")`));
  const body: string[] = [];
  if (files.length) body.push("h=0");
  files.forEach((f, i) => {
    body.push(
      `m=$(c "$f${i}"); if [ "$m" -lt "$n${i}" ]; then n${i}=$m; fi; ` +
        `if [ "$m" -gt "$n${i}" ]; then tail -n $((m-n${i})) "$f${i}" | cut -c1-300 | while IFS= read -r l; do printf '%s: %s\\n' ${shq(basename(f))} "$l"; done; n${i}=$m; h=1; fi`,
    );
  });
  if (files.length) body.push(`if [ "$h" = 1 ]; then exit 0; fi`);
  body.push(`if [ "$(date +%s)" -ge "$end" ]; then echo ${shq(CYCLE_DUE)}; exit 0; fi`);
  parts.push(`while sleep 2; do ${body.join("; ")}; done`);
  return parts.join("; ");
}

/** The seconds baked into a schedule command, or null when it is not one. */
export function scheduleSeconds(command: string): number | null {
  const m = command.match(/^end=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)/);
  return m ? Number(m[1]) : null;
}

export function scheduleTimeoutMs(seconds: number): number {
  return (Math.max(1, Math.round(seconds)) + SCHEDULE_MARGIN_S) * 1000;
}

/** The exact tool call the session makes at the end of every cycle. */
export function scheduleCall(bot: string, files: string[], seconds: number): string {
  return `Monitor({ command: ${JSON.stringify(scheduleCommand(files, seconds))}, description: ${JSON.stringify(scheduleDescription(bot))}, timeout_ms: ${scheduleTimeoutMs(seconds)} })`;
}

/** What the session log says about the schedule monitor: armed (since, until its own baked
 * deadline) or not. */
export function scheduleState(evs: Ev[], bot: string, now: number): { at: string; until: string } | null {
  const desc = scheduleDescription(bot);
  const m = lastMonitorCall(evs, (c) => c.description === desc);
  if (!m || m.ended) return null;
  const at = parseIso(m.at);
  if (at === null) return null;
  const secs = scheduleSeconds(m.command);
  const until = at + (secs !== null ? secs * 1000 : Math.max(0, m.timeoutMs - SCHEDULE_MARGIN_S * 1000));
  if (until <= now) return null;
  return { at: iso(at), until: iso(until) };
}

/**
 * The `wake` lines for `cycle begin` and `cycle end` with a monitor schedule: the state, then the
 * one call to make now. An armed monitor due no later than the next cycle (a minute's slack) needs
 * nothing; one due later (a cycle it did not start) is stopped and replaced, never doubled.
 */
export function scheduleLines(s: Settings, evs: Ev[] | null, now: number, dueSeconds: number): string[] {
  const call = scheduleCall(s.name, wakeFiles(s), dueSeconds);
  if (!evs) return [`state unknown (no session log) · arm now: ${call}`];
  const st = scheduleState(evs, s.name, now);
  if (!st) return [`not armed · arm now: ${call}`];
  const due = now + dueSeconds * 1000;
  if (Date.parse(st.until) <= due + 60_000) return [`armed until ${hhmm(st.until)} (since ${hhmm(st.at)}); nothing to do`];
  return [
    `armed until ${hhmm(st.until)} (since ${hhmm(st.at)}), later than the next cycle is due (${hhmm(iso(due))}) · stop it with TaskStop, then arm: ${call}`,
  ];
}

/** The pack's state line with a monitor schedule: arming goes through `cycle begin`. */
export function schedulePackLines(s: Settings, evs: Ev[] | null, now: number): string[] {
  const st = evs ? scheduleState(evs, s.name, now) : null;
  if (st) return [`armed until ${hhmm(st.until)} (since ${hhmm(st.at)}); nothing to do until it delivers`];
  return [`${evs ? "not armed" : "state unknown (no session log)"} · run \`cycle begin\` now; it prints the one Monitor call to make`];
}

/** The rules a monitor schedule adds when `sleep` is set, for the pack. */
export const SLEEP_RULES = [
  "When `cycle begin` or `cycle end` prints a `sleep` field in place of `wake`, arm no monitor and end your turn: the sleep timer compacts you and wakes you.",
  "A wake from sleep is the loop prompt followed by `(woken: <reason>)`: run `cycle begin` as after any wake.",
];

/** The standing rules with a monitor schedule, for the pack. */
export const SCHEDULE_RULES = [
  "The monitor is your schedule and your live wake.",
  "When it delivers `cycle due` or an event line, run `cycle begin`.",
  "At the end of every cycle, arm the one monitor `cycle end` prints, exactly as printed.",
  "Never call ScheduleWakeup and never start `/loop`.",
  "Never two monitors, never a longer deadline.",
  "If you find none armed (after a start, a compaction, an error), arm it by running `cycle begin`.",
  "The kit's nudge is the backstop if the monitor is ever not armed.",
];
