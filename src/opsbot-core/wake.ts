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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { selfCommand } from "./invocation.js";
import { gitPath, iso, nowIso, parseIso } from "./repo.js";
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

/** Each wake file (home expanded) with the heartbeat.d inputs that read it, null when it names none. */
export function wakeInputs(s: Settings): Map<string, string[] | null> {
  return new Map(s.wake.entries.map((e) => [expandHome(e.file), e.inputs]));
}

// ---------------------------------------------------------- where the last check read to
//
// The monitor is armed from where the last check read to, never from "now". `cycle begin` records
// each wake file's line count (the unit the poller counts in) just before its check runs, in
// <git dir>/opsbot-wake-base, and every arm call printed after it starts the poller at that count.
// A line appended after the check started (while the cycle worked, or between its end and the
// arming) is then delivered the moment the monitor is armed. The file is never committed.

export const WAKE_BASE_NAME = "opsbot-wake-base";

/** The newline count of a file, as `wc -l` gives it; 0 when it cannot be read. */
export function lineCount(file: string): number {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return 0;
  }
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return n;
}

/** Each wake file's line count now. */
export function wakeCounts(files: string[]): Record<string, number> {
  const lines: Record<string, number> = {};
  for (const f of files) lines[f] = lineCount(f);
  return lines;
}

/** Record each wake file's line count as a check starts (`counts`, when the caller measured them
 * already; else measured now). Never fatal: without the record the arm calls fall back to the end
 * of the file. */
export function recordWakeBase(root: string, files: string[], counts?: Record<string, number>): void {
  const p = gitPath(root, WAKE_BASE_NAME);
  try {
    if (files.length === 0) {
      rmSync(p, { force: true });
      return;
    }
    const lines: Record<string, number> = {};
    for (const f of files) lines[f] = counts?.[f] ?? lineCount(f);
    writeFileSync(p, `${JSON.stringify({ at: nowIso(), lines })}\n`);
  } catch {
    // a stale record only makes the next monitor deliver more, never less
  }
}

/** The last record: when it was taken and each wake file's line count then; null when none. */
export function readWakeRecord(root: string): { at: string | null; lines: Record<string, number> } | null {
  try {
    const v = JSON.parse(readFileSync(gitPath(root, WAKE_BASE_NAME), "utf8"));
    const lines = v && typeof v === "object" ? v.lines : null;
    if (!lines || typeof lines !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(lines)) if (Number.isInteger(n) && (n as number) >= 0) out[k] = n as number;
    return { at: typeof v.at === "string" ? v.at : null, lines: out };
  } catch {
    return null;
  }
}

/** Each wake file's line count as the last check started, or null when none is recorded. */
export function readWakeBase(root: string): Record<string, number> | null {
  return readWakeRecord(root)?.lines ?? null;
}

/** The wake files that have lines past their recorded count (a file shorter than its count was
 * truncated or rotated, so every line in it is new), with how many. A file with no count is not
 * counted: the poller starts it at its end. */
export function grownFiles(files: string[], base: Record<string, number> | null, counts: Record<string, number>): Array<{ file: string; n: number }> {
  const out: Array<{ file: string; n: number }> = [];
  if (!base) return out;
  for (const f of files) {
    const b = baseFor(base, f);
    const m = counts[f] ?? 0;
    if (b === null) continue;
    const n = m < b ? m : m - b;
    if (n > 0) out.push({ file: f, n });
  }
  return out;
}

/** The recorded line count for one file, or null. */
export function baseFor(base: Record<string, number> | null | undefined, file: string): number | null {
  const n = base?.[file];
  return typeof n === "number" ? n : null;
}

/** At most this many lines in one delivery: the notification is a wake, the check reads the items. */
export const DELIVER_MAX_LINES = 20;

/**
 * A poller that prints the lines past its baseline once and exits: one notification per arrival,
 * nothing left running. `base` is the line count the last check started at; when the file already
 * has more, the poller prints them and exits at once. With no recorded count (`null`: the first
 * arm after a start before any check recorded one) the baseline is the file's length when the
 * poller starts, the behaviour before counts were recorded. A file shorter than its baseline was
 * truncated or rotated: the baseline drops to 0, so every line in it is delivered, never to "now".
 */
export function monitorCommand(file: string, base: number | null = null): string {
  const q = JSON.stringify(file);
  return (
    `f=${q}; c() { [ -f "$f" ] && wc -l < "$f" || echo 0; }; n=${base === null ? "$(c)" : Math.max(0, Math.floor(base))}; ` +
    `while :; do m=$(c); if [ "$m" -lt "$n" ]; then n=0; fi; ` +
    `if [ "$m" -gt "$n" ]; then k=$((m-n)); [ "$k" -gt ${DELIVER_MAX_LINES} ] && k=${DELIVER_MAX_LINES}; tail -n "$k" "$f" | cut -c1-300; exit 0; fi; sleep 2; done`
  );
}

export function monitorDescription(bot: string, file: string): string {
  return `${bot} wake: new lines in ${file}`;
}

/** The exact tool call the session makes. */
export function monitorCall(bot: string, file: string, timeoutMs: number, base: number | null = null): string {
  return `Monitor({ command: ${JSON.stringify(monitorCommand(file, base))}, description: ${JSON.stringify(monitorDescription(bot, file))}, timeout_ms: ${timeoutMs} })`;
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
export function wakeLines(
  s: Settings,
  evs: Ev[] | null,
  now: number,
  untilNextWakeMs: number | null,
  base: Record<string, number> | null = null,
): string[] {
  const files = wakeFiles(s);
  if (files.length === 0) return [];
  const timeout = monitorTimeout(untilNextWakeMs);
  const states = evs ? wakeStates(evs, files, now) : files.map((file) => ({ file, armed: null as WakeState["armed"] }));
  const out: string[] = [];
  for (const st of states) {
    if (st.armed) out.push(`armed on ${st.file} until ${hhmm(st.armed.until)} (since ${hhmm(st.armed.at)}); nothing to do`);
    else out.push(`${evs ? "not armed" : "state unknown (no session log)"} on ${st.file} · arm now: ${monitorCall(s.name, st.file, timeout, baseFor(base, st.file))}`);
  }
  return out;
}

/** What `cycle end` means by `arrived`, for the pack in either schedule. */
export const ARRIVED_RULE =
  "When `cycle end` prints `arrived` (and `next 0 arrived`), something came in while you worked: run `cycle begin` again in the same turn and arm nothing.";
/** One call where two would do, for the pack. */
export const CHAIN_RULE =
  "When the work of a cycle is one command, chain `cycle end` after it in the same call: `<the command> && <core> cycle end …`.";
/** The turn's last output, for the pack. */
export const CLOSE_RULE = "End the turn with one status line or nothing: the terminal is a log, not a channel.";

/** The standing rules, for the pack. */
export const WAKE_RULES = [
  "The monitor is the live wake: its notification means a stream has something new, so run `cycle begin` then.",
  "It starts from where the last check read to, so a line that arrived since that check began is delivered the moment it is armed; otherwise it exits on the first arrival or at its deadline. Arm it again at the end of every cycle when it is not armed, and when it reports an expiry with nothing delivered; never two on one file, never a longer deadline, never a different command.",
  "The listener's nudge is the backstop when no monitor is armed; neither path depends on the other.",
  ARRIVED_RULE,
];

// ---------------------------------------------------------- the schedule monitor
//
// With loop.schedule "monitor", one bounded Monitor is both the schedule and the live wake. Its
// command is short and fixed in shape, `<core> wake wait --until <epoch seconds>`: the poller lives
// in the core (wakeWait below), so the session copies one short line, not a shell program. It exits
// on its own: with the new lines of any wake file (each prefixed with the file's basename), or with
// one line, `cycle due`. The harness's timeout is that time plus a margin, so the harness never has
// to kill it. The earlier forms baked the seconds into a shell poller (scheduleCommand); a running
// session may still hold one, so the session-log reader recognises them all.

/** The harness's timeout over the command's own deadline. */
export const SCHEDULE_MARGIN_S = 60;
export const CYCLE_DUE = "cycle due";
/** `wake wait` refuses a time further ahead than the harness's 30-minute Monitor limit. */
export const WAKE_WAIT_MAX_S = 1800;
export const WAKE_POLL_MS = 2000;
/** A delivered line is cut to this many characters. */
export const DELIVER_MAX_CHARS = 300;

/** The fixed description the kit finds the schedule monitor by in the session log. */
export function scheduleDescription(bot: string): string {
  return `${bot} schedule`;
}

/** A shell single-quoted word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** The earlier form of the command, a shell poller with the seconds baked in. No longer printed;
 * kept so the session-log reader and the tests can hold the new poller to its output. `bases` are
 * the line counts the last check started at, one per file: lines past them are delivered at once;
 * a missing (null) count starts at the file's length; a file shorter than its baseline resets it to 0. */
export function scheduleCommand(files: string[], seconds: number, bases: (number | null)[] = []): string {
  const parts = [`end=$(( $(date +%s) + ${Math.max(1, Math.round(seconds))} ))`];
  if (files.length) parts.push(`c() { [ -f "$1" ] && wc -l < "$1" || echo 0; }`);
  files.forEach((f, i) => {
    const b = bases[i] ?? null;
    parts.push(`f${i}=${shq(f)}; n${i}=${b === null ? `$(c "$f${i}")` : Math.max(0, Math.floor(b))}`);
  });
  const body: string[] = [];
  if (files.length) body.push("h=0");
  files.forEach((f, i) => {
    body.push(
      `m=$(c "$f${i}"); if [ "$m" -lt "$n${i}" ]; then n${i}=0; fi; ` +
        `if [ "$m" -gt "$n${i}" ]; then k=$((m-n${i})); [ "$k" -gt ${DELIVER_MAX_LINES} ] && k=${DELIVER_MAX_LINES}; tail -n "$k" "$f${i}" | cut -c1-300 | while IFS= read -r l; do printf '%s: %s\\n' ${shq(basename(f))} "$l"; done; n${i}=$m; h=1; fi`,
    );
  });
  if (files.length) body.push(`if [ "$h" = 1 ]; then exit 0; fi`);
  body.push(`if [ "$(date +%s)" -ge "$end" ]; then echo ${shq(CYCLE_DUE)}; exit 0; fi`);
  parts.push(`while :; do ${body.join("; ")}; sleep 2; done`);
  return parts.join("; ");
}

/** The seconds baked into an earlier-form schedule command, or null when it is not one. Matches
 * both shell forms (measuring each file at start, and starting at the recorded counts). */
export function scheduleSeconds(command: string): number | null {
  const m = command.match(/^end=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)/);
  return m ? Number(m[1]) : null;
}

/** The time a `wake wait` command names, in epoch seconds, or null when it is not one. */
export function wakeWaitUntil(command: string): number | null {
  const m = command.match(/\bwake wait --until[ =](\d+)\b/);
  return m ? Number(m[1]) : null;
}

/** When a schedule command (any of the three forms) armed at `atMs` is due, or null. */
export function scheduleDue(command: string, atMs: number): number | null {
  const until = wakeWaitUntil(command);
  if (until !== null) return until * 1000;
  const secs = scheduleSeconds(command);
  return secs !== null ? atMs + secs * 1000 : null;
}

export function scheduleTimeoutMs(seconds: number): number {
  return (Math.max(1, Math.round(seconds)) + SCHEDULE_MARGIN_S) * 1000;
}

/** The command the session's one Monitor runs: the core's own poller, until `untilS`. */
export function wakeWaitCommand(untilS: number): string {
  return `${selfCommand()} wake wait --until ${Math.floor(untilS)}`;
}

/** The exact tool call the session makes at the end of every cycle: due `seconds` after `nowMs`. */
export function scheduleCall(bot: string, seconds: number, nowMs: number): string {
  const secs = Math.max(1, Math.round(seconds));
  return `Monitor({ command: ${JSON.stringify(wakeWaitCommand(Math.floor(nowMs / 1000) + secs))}, description: ${JSON.stringify(scheduleDescription(bot))}, timeout_ms: ${scheduleTimeoutMs(secs)} })`;
}

/** The lines of `text` (complete lines only) from index `from` to `to`, the last `max` of them. */
function newLines(text: string, from: number, to: number, max: number): string[] {
  const all = text.split("\n").slice(0, to);
  return all.slice(Math.max(from, to - max), to);
}

const cut = (l: string, n: number) => {
  const cs = Array.from(l);
  return cs.length > n ? cs.slice(0, n).join("") : l;
};

/**
 * The poller `wake wait` runs: from the counts the last check recorded (`base`; a file without one
 * starts at its length now), every `pollMs` it looks at each file; when any has lines past its
 * count it returns them, each prefixed with the file's basename and cut to 300 characters, at most
 * 20 per file. A file shorter than its count was truncated or rotated: its count drops to 0. When
 * `deadlineMs` (real time) passes with nothing new it returns `cycle due`. The output is what the
 * earlier shell poller printed.
 */
export async function wakeWait(files: string[], base: Record<string, number> | null, deadlineMs: number, pollMs = WAKE_POLL_MS): Promise<string> {
  const counts = files.map((f) => baseFor(base, f) ?? lineCount(f));
  for (;;) {
    const out: string[] = [];
    files.forEach((f, i) => {
      let text = "";
      try {
        text = readFileSync(f, "utf8");
      } catch {
        text = "";
      }
      const m = text.length ? text.split("\n").length - 1 : 0;
      if (m < counts[i]!) counts[i] = 0;
      if (m > counts[i]!) {
        const name = basename(f);
        for (const l of newLines(text, counts[i]!, m, DELIVER_MAX_LINES)) out.push(`${name}: ${cut(l, DELIVER_MAX_CHARS)}`);
        counts[i] = m;
      }
    });
    if (out.length) return out.join("\n");
    if (Date.now() >= deadlineMs) return CYCLE_DUE;
    await new Promise((r) => setTimeout(r, Math.max(10, Math.min(pollMs, deadlineMs - Date.now()))));
  }
}

/** What the session log says about the schedule monitor: armed (since, until the time in its
 * command, or the seconds an earlier form baked in) or not. */
export function scheduleState(evs: Ev[], bot: string, now: number): { at: string; until: string } | null {
  const desc = scheduleDescription(bot);
  const m = lastMonitorCall(evs, (c) => c.description === desc);
  if (!m || m.ended) return null;
  const at = parseIso(m.at);
  if (at === null) return null;
  const until = scheduleDue(m.command, at) ?? at + Math.max(0, m.timeoutMs - SCHEDULE_MARGIN_S * 1000);
  if (until <= now) return null;
  return { at: iso(at), until: iso(until) };
}

/**
 * The `wake` lines for `cycle begin` and `cycle end` with a monitor schedule: the state, then the
 * one call to make now. An armed monitor due no later than the next cycle (a minute's slack) needs
 * nothing; one due later (a cycle it did not start) is stopped and replaced, never doubled.
 */
export function scheduleLines(
  s: Settings,
  evs: Ev[] | null,
  now: number,
  dueSeconds: number,
): string[] {
  const call = scheduleCall(s.name, dueSeconds, now);
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
  "It starts from where the last check read to, so a line that arrived since that check began is delivered the moment it is armed.",
  "At the end of every cycle, arm the one monitor `cycle end` prints, exactly as printed.",
  ARRIVED_RULE,
  CHAIN_RULE,
  CLOSE_RULE,
  "Never call ScheduleWakeup and never start `/loop`.",
  "Never two monitors, never a longer deadline.",
  "If you find none armed (after a start, a compaction, an error), arm it by running `cycle begin`.",
  "The kit's nudge is the backstop if the monitor is ever not armed.",
];
