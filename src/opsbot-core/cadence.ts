/**
 * How long until the next cycle, from the cycle log, the clock and the
 * cadence table. In order:
 *
 *   hot            something arrived in the last 15 minutes (this cycle included)
 *   night          night hours (an arrival keeps it tight only while hot)
 *   warm           something arrived in the last hour
 *   quiet_working  quiet, working hours
 *   quiet          quiet, otherwise
 *
 * and never more than the cap. With `loop.schedule: "monitor"` also never more than
 * MONITOR_DELAY_CAP_S, so the schedule monitor's deadline plus its margin stays inside the
 * harness's 30-minute Monitor limit; the reason says when that cap applied. "Arrived" is a check line with new above 0.
 * Working and night hours are read in the bot's timezone; night may cross
 * midnight.
 */
import { localParts, parseIso } from "./repo.js";
import type { Settings } from "./settings.js";
import type { LogLine } from "./state.js";

export const HOT_WINDOW_S = 15 * 60;
export const WARM_WINDOW_S = 60 * 60;
/** The longest delay a schedule monitor can carry: 29 minutes, plus its 60-second margin, is the
 * harness's 30-minute Monitor limit. */
export const MONITOR_DELAY_CAP_S = 1740;

export interface Delay {
  seconds: number;
  reason: string;
}

export function lastArrival(lines: LogLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if ((l.outcome === "new" || l.outcome === "degraded") && Number(l.new ?? 0) > 0) return l.at;
  }
  return null;
}

function inWorkingHours(s: Settings, nowMs: number): boolean {
  const { dow, hm } = localParts(nowMs, s.timezone);
  const wh = s.cadence.working_hours;
  if (!wh.days.includes(dow)) return false;
  return hm >= wh.start && hm < wh.end;
}

function inNight(s: Settings, nowMs: number): boolean {
  const { hm } = localParts(nowMs, s.timezone);
  const { start, end } = s.cadence.night_hours;
  if (start <= end) return hm >= start && hm < end;
  return hm >= start || hm < end;
}

export function nextDelay(s: Settings, lines: LogLine[], nowMs: number): Delay {
  const c = s.cadence;
  const last = parseIso(lastArrival(lines));
  const ago = last === null ? null : Math.floor((nowMs - last) / 1000);
  let d: Delay;
  if (ago !== null && ago <= HOT_WINDOW_S) d = { seconds: c.hot, reason: "arrived in the last 15 minutes" };
  else if (inNight(s, nowMs)) d = { seconds: c.night, reason: "night" };
  else if (ago !== null && ago <= WARM_WINDOW_S) d = { seconds: c.warm, reason: "arrived in the last hour" };
  else if (inWorkingHours(s, nowMs)) d = { seconds: c.quiet_working, reason: "quiet, working hours" };
  else d = { seconds: c.quiet, reason: "quiet, otherwise" };
  if (d.seconds > c.cap) d = { seconds: c.cap, reason: d.reason };
  if (s.loop.schedule === "monitor" && d.seconds > MONITOR_DELAY_CAP_S) {
    d = { seconds: MONITOR_DELAY_CAP_S, reason: `${d.reason} (capped at 29 min: a monitor's limit)` };
  }
  return d;
}

export function delayLine(d: Delay): string {
  return `${d.seconds} ${d.reason}`;
}
