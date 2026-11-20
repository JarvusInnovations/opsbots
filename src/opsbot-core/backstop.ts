/**
 * The wake backstop: the kit's one implementation of "the monitor first, the nudge second", run
 * by every listener (`wake backstop`) in place of a copy of its own.
 *
 * An event was recorded at `at` under `key`. The session's own monitor gets the first chance:
 * the backstop waits `grace` ticks (none while asleep), looking each tick, and stops with no
 * nudge once the key is in logs/intake/seen or a check has begun since the event. While a cycle
 * holds the lock it waits for that cycle to end, a wait that counts against neither the grace
 * nor the limit (a busy session cannot be nudged, and that cycle may have checked before the
 * event); then it looks again and, if neither, nudges at once. Else, after the grace, it runs
 * `nudge --now` every 10 ticks until the nudge's `outcome` is `woke` or `cooldown`, the key is
 * seen, a newer check begins, or the limit passes. A refusal is reported once per reason, not at
 * every try. The result is one line; the progress notes go to `note`.
 *
 * A tick is one second; OPSBOT_WAKE_TICK_MS and OPSBOT_WAKE_LIMIT_MS (both test-only) shorten
 * the tick and the 30-minute limit.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { branchCycleLines, branchSeen, logBranch } from "./log.js";
import { join } from "node:path";

export const BACKSTOP_GRACE_S = 20;
export const BACKSTOP_LIMIT_MS = 30 * 60_000;

/**
 * Whether a check has begun since `t` (ms): a check line (outcome nothing-new, new or degraded)
 * in logs/cycle.jsonl whose `at` is later than `t`. `at` is whole seconds, the moment the check
 * started, so a check begun in the same second as the event does not count: it may have read
 * the stream just before the event landed. A finish line, a sleep line or the cycle lock never
 * counts: a cycle already running when the event arrived may have checked before it. Reads the
 * log's tail only.
 */
export function cycleBegunSince(root: string, t: number): boolean {
  const branch = logBranch(root);
  if (branch) {
    const lines = branchCycleLines(root, branch);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!["nothing-new", "new", "degraded"].includes(String(lines[i]!.outcome))) continue;
      const at = Date.parse(String(lines[i]!.at));
      return Number.isFinite(at) && at > t;
    }
    return false;
  }
  let fd: number | undefined;
  try {
    const file = join(root, "logs/cycle.jsonl");
    const size = statSync(file).size;
    const n = Math.min(size, 65536);
    const buf = Buffer.alloc(n);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let l: { outcome?: unknown; at?: unknown } | null;
      try { l = JSON.parse(lines[i]!); } catch { continue; }
      if (!l || !["nothing-new", "new", "degraded"].includes(String(l.outcome))) continue;
      const at = Date.parse(String(l.at));
      return Number.isFinite(at) && at > t;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether `key` is a line of logs/intake/seen. */
export function keySeen(root: string, key: string): boolean {
  const branch = logBranch(root);
  if (branch) return branchSeen(root, branch).has(key);
  try { return readFileSync(join(root, "logs/intake/seen"), "utf8").split("\n").includes(key); } catch { return false; }
}

export interface BackstopDeps {
  graceS: number;
  tick: number;
  limitMs: number;
  /** The event's time, ms. */
  at: number;
  /** One `nudge --now`: its `outcome` word and its prose. */
  nudge: () => Promise<{ outcome: string; text: string }>;
  seen: () => boolean;
  begunSince: (t: number) => boolean;
  cycleRunning: () => boolean;
  asleep: () => boolean;
  note: (line: string) => void;
  now?: () => number;
}

/** Run the backstop; resolves to its one line. */
export async function backstop(d: BackstopDeps): Promise<string> {
  const now = d.now ?? (() => Date.now());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const answered = () => d.seen() || d.begunSince(d.at);
  let afterCycle = false;
  let asleep = false;
  if (d.graceS > 0 && d.asleep()) {
    asleep = true;
    d.note("asleep: nudging at once");
  } else if (d.graceS > 0) {
    for (let i = 0; ; i++) {
      if (answered()) return "woken by monitor";
      if (d.cycleRunning()) {
        d.note("a cycle is running: waiting for it to end");
        while (d.cycleRunning()) await sleep(d.tick);
        if (answered()) return "woken by monitor";
        afterCycle = true;
        break;
      }
      if (i >= d.graceS) break;
      await sleep(d.tick);
    }
  } else {
    asleep = d.asleep();
  }
  const until = now() + d.limitMs;
  let pending: string | null = null;
  while (now() < until) {
    const r = await d.nudge();
    if (r.outcome === "woke") {
      if (afterCycle) return "nudged after cycle";
      if (asleep) return "asleep: nudged";
      return `nudged after ${Math.round((now() - d.at) / 1000)}s`;
    }
    // another wake typed the prompt moments ago: this one is satisfied by it
    if (r.outcome === "cooldown") return "already woken";
    if (answered()) return "woken by monitor";
    // a session mid-turn reaches `cycle end`, which reports the arrival: one note per reason
    const why = /mid-turn/.test(r.text) ? "mid-turn" : r.text;
    if (why !== pending) { pending = why; d.note(`nudge pending: ${r.text.slice(0, 120)}`); }
    await sleep(10 * d.tick);
  }
  return "gave up";
}
