/**
 * A fast cycle (specs/skills/opsbot-core.md, A fast cycle): whether this `cycle begin` checks only
 * the inputs its wake named, decided in one place with the reason, which the check's log line
 * carries (`fast`, or `full: <why>`).
 *
 * Fast when all of these hold: at least one wake file has lines past the count recorded at the last
 * check, and every such file names its inputs (all installed); the last full check began less than
 * `check.full_minutes` ago; the last check, full or fast, failed no input. Otherwise full: `--full`,
 * `check.full_minutes: 0`, a quiet deadline (`cycle due`: no new wake-file lines), and each failed
 * condition above.
 */
import { MARGIN_MINUTES, FIRST_RUN_HOURS } from "./commands/check.js";
import { iso, parseIso } from "./repo.js";
import type { Settings } from "./settings.js";
import { CHECK_OUTCOMES, type LogLine, validWatermark } from "./state.js";
import { basename, grownFiles, wakeFiles, wakeInputs } from "./wake.js";

export type FastDecision =
  | { fast: true; mode: "fast"; inputs: string[]; since: string; fullDue: string; files: string[] }
  | { fast: false; mode: string };

const full = (why: string): FastDecision => ({ fast: false, mode: `full: ${why}` });

/** The last check line that was not fast, or null. */
export function lastFullCheck(lines: LogLine[]): LogLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (CHECK_OUTCOMES.includes(l.outcome) && l.fast !== true) return l;
  }
  return null;
}

function lastAnyCheck(lines: LogLine[]): LogLine | null {
  for (let i = lines.length - 1; i >= 0; i--) if (CHECK_OUTCOMES.includes(lines[i]!.outcome)) return lines[i]!;
  return null;
}

export function decideFast(input: {
  s: Settings;
  forceFull: boolean;
  lines: LogLine[];
  /** The counts recorded at the last check, or null. */
  base: Record<string, number> | null;
  /** Each wake file's count now. */
  counts: Record<string, number>;
  /** The heartbeat.d scripts installed, in order. */
  installed: string[];
  watermark: string | null;
  now: number;
}): FastDecision {
  const { s } = input;
  if (input.forceFull) return full("--full");
  if (s.check.full_minutes === 0) return full("check.full_minutes is 0");
  const files = wakeFiles(s);
  if (files.length === 0) return full("no wake files");
  if (!input.base) return full("no wake-file counts recorded");
  const grown = grownFiles(files, input.base, input.counts);
  if (grown.length === 0) return full("no new wake-file lines (cycle due)");
  const named = wakeInputs(s);
  const want = new Set<string>();
  for (const g of grown) {
    const ins = named.get(g.file);
    if (!ins || ins.length === 0) return full(`${basename(g.file)} names no inputs`);
    for (const i of ins) want.add(i);
  }
  for (const i of want) if (!input.installed.includes(i)) return full(`input ${i} is not installed in heartbeat.d`);
  const lastFull = lastFullCheck(input.lines);
  const fullAt = lastFull ? parseIso(lastFull.at) : null;
  if (!lastFull || fullAt === null) return full("no full check yet");
  const age = input.now - fullAt;
  if (age >= s.check.full_minutes * 60_000) return full(`the last full check was ${Math.floor(age / 60_000)} min ago`);
  const last = lastAnyCheck(input.lines);
  if (last && (last.outcome === "degraded" || (Array.isArray(last.failed) && last.failed.length > 0))) return full("the last check failed an input");
  // the window the last full check read; a line from before `since` was logged has none, so the
  // window a full check would read now (the watermark, which a fast check never moves)
  let since = typeof lastFull.since === "string" && parseIso(lastFull.since) !== null ? lastFull.since : null;
  if (!since) {
    since = input.watermark && validWatermark(input.watermark)
      ? iso(parseIso(input.watermark)! - MARGIN_MINUTES * 60_000)
      : iso(fullAt - FIRST_RUN_HOURS * 3_600_000);
  }
  return {
    fast: true,
    mode: "fast",
    inputs: input.installed.filter((i) => want.has(i)),
    since,
    fullDue: iso(fullAt + s.check.full_minutes * 60_000),
    files: grown.map((g) => g.file),
  };
}
