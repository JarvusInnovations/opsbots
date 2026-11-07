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
