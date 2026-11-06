/**
 * The committed state the loop keeps, and the lock it never commits.
 *
 *   logs/cycle.jsonl        one line per cycle outcome
 *   logs/intake/seen        typed seen keys, one per line, appended
 *   logs/intake/watermark   one UTC ISO line
 *   logs/outages.jsonl      outage events
 *   <git dir>/opsbot-cycle.lock   {pid, session, started}
 *
 * Line shapes are byte-compatible with the bot the loop was extracted from:
 *   check     {at, outcome, inputs: {<input>: {ok, new}}, new, failed: [{input, error}], watermark}
 *   finished  {at, outcome: "finished", records, watermark, degraded[, summary]}
 *   outage    {at, outcome: "outage", kind, started, ended, note}
 *   end       {at, outcome: "outage-end", started, ended}
 * Outage lines are read from both files, since an earlier bot wrote them into
 * the cycle log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ISO_RE, gitPath, nowIso, nowMs, parseIso } from "./repo.js";

export const CYCLE_LOG = "logs/cycle.jsonl";
export const SEEN_FILE = "logs/intake/seen";
export const WATERMARK_FILE = "logs/intake/watermark";
export const OUTAGES_FILE = "logs/outages.jsonl";
export const LOCK_NAME = "opsbot-cycle.lock";

export const OUTAGE_KINDS = ["failed-turn", "refused", "plan-limit", "session-ended", "stopped"] as const;
export type OutageKind = (typeof OUTAGE_KINDS)[number];

export const CHECK_OUTCOMES = ["nothing-new", "new", "degraded"];
export const CYCLE_OUTCOMES = [...CHECK_OUTCOMES, "finished"];

export interface LogLine {
  at: string;
  outcome: string;
  [k: string]: unknown;
}

export function paths(root: string) {
  return {
    log: join(root, CYCLE_LOG),
    seen: join(root, SEEN_FILE),
    watermark: join(root, WATERMARK_FILE),
    outages: join(root, OUTAGES_FILE),
    lock: gitPath(root, LOCK_NAME),
  };
}

export function readJsonl(file: string): LogLine[] {
  if (!existsSync(file)) return [];
  const out: LogLine[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && typeof v.at === "string" && typeof v.outcome === "string") out.push(v);
    } catch {
      // a torn or foreign line is skipped, never fatal
    }
  }
  return out;
}

export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function truncateTo(file: string, size: number): void {
  if (!existsSync(file)) return;
  if (size === 0 && fileSize(file) > 0) truncateSync(file, 0);
  else truncateSync(file, size);
}

export function readCycleLog(root: string): LogLine[] {
  return readJsonl(paths(root).log);
}

/** The time of the last line a cycle wrote (a check's line or a finish), or null. */
export function lastCycleAt(lines: LogLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (CYCLE_OUTCOMES.includes(l.outcome)) return l.at;
  }
  return null;
}

export function lastCheck(lines: LogLine[]): LogLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CHECK_OUTCOMES.includes(lines[i]!.outcome)) return lines[i]!;
  }
  return null;
}

// ---------------------------------------------------------------- outages

export interface Outage {
  kind: string;
  started: string;
  ended: string | null;
  note: string;
  at: string;
}

export function outageLines(root: string): LogLine[] {
  const p = paths(root);
  const lines = [...readJsonl(p.log), ...readJsonl(p.outages)].filter(
    (l) => l.outcome === "outage" || l.outcome === "outage-end",
  );
  return lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Every recorded outage with its end, if any. */
export function outages(root: string): Outage[] {
  const lines = outageLines(root);
  const endedAt = new Map<string, string>();
  for (const l of lines) {
    if (l.outcome === "outage-end" && typeof l.started === "string") endedAt.set(l.started, String(l.ended ?? l.at));
  }
  return lines
    .filter((l) => l.outcome === "outage")
    .map((l) => ({
      kind: String(l.kind ?? "unknown"),
      started: String(l.started ?? l.at),
      ended: (l.ended as string | null) ?? endedAt.get(String(l.started)) ?? null,
      note: String(l.note ?? ""),
      at: l.at,
    }));
}

/** The start of the last outage recorded with no end, or null. */
export function openOutage(root: string): string | null {
  const open = outages(root).filter((o) => o.ended === null);
  return open.length ? open[open.length - 1]!.started : null;
}

export function recordOutage(
  root: string,
  o: { kind: OutageKind; started: string; ended?: string | null; note: string },
): LogLine {
  const line = {
    at: nowIso(),
    outcome: "outage",
    kind: o.kind,
    started: o.started,
    ended: o.ended ?? null,
    note: o.note,
  };
  appendJsonl(paths(root).outages, line);
  return line;
}

export function recordOutageEnd(root: string, started: string, ended: string): LogLine {
  const line = { at: nowIso(), outcome: "outage-end", started, ended };
  appendJsonl(paths(root).outages, line);
  return line;
}

// -------------------------------------------------------------- watermark

export function readWatermark(root: string): string | null {
  const f = paths(root).watermark;
  if (!existsSync(f)) return null;
  const line = readFileSync(f, "utf8").split("\n")[0]?.trim() ?? "";
  return line || null;
}

export function validWatermark(wm: string | null): boolean {
  return !!wm && ISO_RE.test(wm) && parseIso(wm) !== null;
}

export function writeWatermark(root: string, wm: string): void {
  const f = paths(root).watermark;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${wm}\n`);
}

// ------------------------------------------------------------------- seen

export function readSeen(root: string): Set<string> {
  const f = paths(root).seen;
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l !== ""),
  );
}

export function appendSeen(root: string, keys: string[]): void {
  const f = paths(root).seen;
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, keys.map((k) => `${k}\n`).join(""));
}

// ------------------------------------------------------------------- lock

export interface LockHold {
  pid: string;
  session: string;
  started: string;
}

export function readLock(root: string): { hold: LockHold | null; raw: boolean } {
  const f = paths(root).lock;
  if (!existsSync(f)) return { hold: null, raw: false };
  try {
    const v = JSON.parse(readFileSync(f, "utf8"));
    return {
      hold: { pid: String(v.pid ?? ""), session: String(v.session ?? ""), started: String(v.started ?? "") },
      raw: true,
    };
  } catch {
    return { hold: { pid: "", session: "", started: "" }, raw: true };
  }
}

export function pidAlive(pid: string): "yes" | "no" | "unknown" {
  if (!/^\d+$/.test(pid)) return "unknown";
  try {
    process.kill(Number(pid), 0);
    return "yes";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? "yes" : "no";
  }
}

export type LockVerdict =
  | { state: "free" }
  | { state: "held"; hold: LockHold; alive: string; why: string }
  | { state: "abandoned"; hold: LockHold; kind: OutageKind; note: string };

/**
 * Whether the lock holds the checkout. A hold is abandoned when its process
 * is gone, when it has lasted lock_max_minutes, when it cannot be read, or
 * when it belongs to this same session (a cycle of this session began and
 * never finished). A hold whose process cannot be checked and is younger
 * than the limit is held.
 */
export function judgeLock(root: string, maxMinutes: number): LockVerdict {
  const { hold } = readLock(root);
  if (!hold) return { state: "free" };
  const me = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  const startedMs = parseIso(hold.started);
  const age = startedMs === null ? 0 : nowMs() - startedMs;
  const alive = hold.pid ? pidAlive(hold.pid) : "unknown";
  const at = hold.started || "an unknown time";
  if (me && hold.session === me) {
    return { state: "abandoned", hold, kind: "failed-turn", note: `a cycle of this session began at ${at} and did not finish` };
  }
  if (alive === "no") {
    return {
      state: "abandoned",
      hold,
      kind: "session-ended",
      note: `the session holding the checkout (process ${hold.pid}) is gone; its cycle began at ${at}`,
    };
  }
  if (startedMs !== null && age >= maxMinutes * 60_000) {
    return {
      state: "abandoned",
      hold,
      kind: "failed-turn",
      note: `a cycle held the checkout from ${hold.started} for over ${maxMinutes} minutes`,
    };
  }
  if (startedMs === null) {
    return { state: "abandoned", hold, kind: "failed-turn", note: "the hold on the checkout could not be read" };
  }
  const who = `a cycle in session ${hold.session || "unknown"}${hold.pid ? ` (process ${hold.pid})` : ""} holds the checkout since ${hold.started}`;
  return { state: "held", hold, alive, why: who };
}

/** Take the lock with noclobber semantics; false when another cycle got there first. */
export function takeLock(root: string): boolean {
  const f = paths(root).lock;
  const hold: LockHold = {
    pid: process.env.CLAUDE_PID ?? "",
    session: process.env.CLAUDE_CODE_SESSION_ID ?? "",
    started: nowIso(),
  };
  try {
    writeFileSync(f, `${JSON.stringify(hold)}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(root: string): void {
  rmSync(paths(root).lock, { force: true });
}
