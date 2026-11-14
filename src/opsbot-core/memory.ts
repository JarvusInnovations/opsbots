/**
 * Auto memory in the bot's repo (specs/skills/opsbot-core.md, Auto memory).
 *
 * Claude Code's auto memory is a folder: `MEMORY.md`, the index loaded at every session start,
 * and one small file per memory. `start` points it at `memory.dir` inside the checkout; the
 * check's commit and the `cycle end` commit take every changed file under it; a review on a
 * routine folds, updates, keeps or prunes each file.
 *
 *   <memory.dir>/MEMORY.md                 the index
 *   <memory.dir>/<name>.md                 one memory each
 *   <git dir>/opsbot-memory-review.json    the snapshot `memory review --begin` takes
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { git, gitPath } from "./repo.js";
import type { Settings } from "./settings.js";
import { readCycleLog, type LogLine } from "./state.js";
import { byTime, computeState, readDefinitions, readRuns, type Definition, type Run } from "./routine-store.js";

export const MEMORY_INDEX = "MEMORY.md";
export const REVIEW_SNAPSHOT = "opsbot-memory-review.json";
export const REVIEW_OUTCOME = "memory-review";
/** The built-in routine the review is (specs/skills/opsbot-core.md, Routines). */
export const MEMORY_ROUTINE = "memory-review";
const DAY = 86_400_000;

/** The memory directory's absolute path, or null when memory is off. */
export function memoryDir(root: string, s: Settings): string | null {
  return s.memory ? resolve(root, s.memory.dir) : null;
}

/**
 * Every changed path under the memory directory (new, modified, deleted), as absolute paths, for
 * a commit's `--only` list, leaving out any already in `already`. One `git status` names each
 * file, so a deletion is committed as a deletion and an ignored file is never taken. A path
 * added to the index and then deleted from the disk ("AD") is left out: `--only` cannot name a
 * path that is neither in HEAD nor on disk.
 */
export function changedMemoryFiles(root: string, s: Settings, already: string[] = []): string[] {
  const dir = memoryDir(root, s);
  if (!dir) return [];
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", dir]);
  if (r.code !== 0) return [];
  const have = new Set(already.map((f) => resolve(root, f)));
  const out: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy === "AD") continue;
    const abs = resolve(root, rec.slice(3));
    if (have.has(abs)) continue;
    have.add(abs);
    out.push(abs);
  }
  return out;
}

export interface MemoryFile {
  /** Path relative to the memory directory, `/`-separated. */
  name: string;
  bytes: number;
  /** From the file's frontmatter (`type: …`), when present. */
  type: string | null;
  /** The earlier of its last commit and its file time; null when neither can be read. */
  changed: number | null;
  sha: string;
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

/** `type:` from a leading `---` frontmatter block, when there is one. */
export function frontmatterType(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const t = m[1]!.match(/^type:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return t ? t[1]!.trim() : null;
}

/** When each committed file under `dir` last changed in git, by repo-relative path. */
function commitTimes(root: string, dir: string): Map<string, number> {
  const r = git(root, ["log", "--format=@%ct", "--name-only", "--no-renames", "--", dir]);
  const out = new Map<string, number>();
  if (r.code !== 0) return out;
  let t = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("@")) t = Number(line.slice(1)) * 1000;
    else if (line.trim() && !out.has(line.trim())) out.set(line.trim(), t);
  }
  return out;
}

/** Every memory file (the index aside), with its size, type, last change and content hash. */
export function listMemory(root: string, dir: string): MemoryFile[] {
  const commits = commitTimes(root, dir);
  const dirty = new Set(
    changedPaths(root, dir).map((p) => relative(dir, p).split(sep).join("/")),
  );
  return walk(dir)
    .filter((n) => n !== MEMORY_INDEX)
    .map((name) => {
      const abs = join(dir, name);
      const buf = readFileSync(abs);
      const mtime = statSync(abs).mtimeMs;
      const committed = commits.get(relative(root, abs).split(sep).join("/"));
      // a fresh checkout's file times are all new, and a review's edits are committed after it:
      // the earlier of the two is when the content last changed. A file changed since its last
      // commit has only its file time.
      const changed = dirty.has(name) || committed === undefined ? mtime : Math.min(committed, mtime);
      return {
        name,
        bytes: buf.length,
        type: frontmatterType(buf.toString("utf8")),
        changed: Number.isFinite(changed) ? changed : null,
        sha: createHash("sha1").update(buf).digest("hex"),
      };
    });
}

function changedPaths(root: string, dir: string): string[] {
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", dir]);
  if (r.code !== 0) return [];
  return r.stdout.split("\0").filter((rec) => rec.length >= 4).map((rec) => resolve(root, rec.slice(3)));
}

/**
 * Every run of the memory-review routine: its run records, and the `memory-review` lines bots
 * wrote to the cycle log before the review was a routine, each read as a run.
 */
export function memoryRuns(root: string, s: Settings, runs?: Run[]): Run[] {
  const recorded = (runs ?? readRuns(root, s).runs).filter((r) => r.routine === MEMORY_ROUTINE);
  const have = new Set(recorded.map((r) => r.at));
  const legacy: Run[] = [];
  for (const l of readCycleLog(root)) {
    if (l.outcome !== REVIEW_OUTCOME) continue;
    const atMs = Date.parse(l.at);
    if (Number.isNaN(atMs) || have.has(l.at)) continue;
    legacy.push({
      id: `cycle-log-${l.at}`,
      routine: MEMORY_ROUTINE,
      at: l.at,
      atMs,
      outcome: "done",
      by: null,
      checked: [],
      handed_to: null,
      notes: typeof l.note === "string" ? l.note : `kept ${l.kept ?? 0}, updated ${l.updated ?? 0}, removed ${l.removed ?? 0}, added ${l.added ?? 0}`,
      file: "logs/cycle.jsonl",
    });
  }
  return [...recorded, ...legacy].sort(byTime);
}

/** The bot's own `routines/memory-review.md`, when it overrides the built-in. */
export function memoryOverride(root: string, s: Settings, defs?: Definition[]): Definition | null {
  return (defs ?? readDefinitions(root, s).defs).find((d) => d.id === MEMORY_ROUTINE) ?? null;
}

/** The last `memory-review` line in the cycle log. */
export function lastReview(lines: LogLine[]): LogLine | null {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.outcome === REVIEW_OUTCOME) return lines[i]!;
  return null;
}

export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export interface MemoryStatus {
  dir: string;
  files: MemoryFile[];
  bytes: number;
  index: { bytes: number; lines: number } | null;
  last_review: string | null;
  /** Files changed since the last review (all of them with none). */
  unreviewed: MemoryFile[];
  oldest_unreviewed_ms: number | null;
  due: boolean;
  /** Why it is due, or when it will be. */
  why: string;
  /** When it became due, while due (null when due from the start). */
  due_at: number | null;
  /** When it next becomes due, while not due; null when it cannot (no memory files). */
  next: number | null;
  /** The newest run's time, or null. */
  last_review_ms: number | null;
  /** True when the bot's own routines/memory-review.md defines the schedule. */
  overridden: boolean;
}

/**
 * Where the memory stands. Due when there is at least one memory file and the last review is
 * `review_days` or more ago; with no review yet, when the oldest memory file is that old.
 */
export function memoryStatus(
  root: string,
  s: Settings,
  now: number,
  given: { runs?: Run[]; defs?: Definition[] } = {},
): MemoryStatus | null {
  const dir = memoryDir(root, s);
  if (!dir || !s.memory) return null;
  const files = listMemory(root, dir);
  const idxPath = join(dir, MEMORY_INDEX);
  let index: MemoryStatus["index"] = null;
  if (existsSync(idxPath)) {
    const t = readFileSync(idxPath, "utf8");
    index = { bytes: Buffer.byteLength(t), lines: t.split("\n").filter((l) => l.trim()).length };
  }
  const runs = memoryRuns(root, s, given.runs);
  const rev = runs.length ? runs[runs.length - 1]! : null;
  const revAt = rev ? rev.atMs : null;
  const unreviewed = files.filter((f) => revAt === null || f.changed === null || f.changed > revAt);
  const times = unreviewed.map((f) => f.changed).filter((t): t is number => t !== null);
  const oldest = times.length ? now - Math.min(...times) : null;
  const limit = s.memory.review_days * DAY;
  let due = false;
  let why: string;
  let dueAt: number | null = null;
  let next: number | null = null;
  const override = memoryOverride(root, s, given.defs);
  if (override) {
    // the bot's own definition decides the schedule, as for any routine
    const st = computeState(override, runs, now, s.timezone);
    due = st.due;
    dueAt = st.dueAt;
    next = st.next;
    why = due
      ? revAt !== null ? `last review ${ageText(now - revAt)} ago (${override.schedule})` : `never reviewed (${override.schedule})`
      : next !== null ? `next review in ${ageText(next - now)} (${override.schedule})` : `not scheduled (${override.file})`;
  } else if (files.length === 0) why = "no memory files";
  else if (revAt !== null) {
    dueAt = revAt + limit;
    due = now >= dueAt;
    why = due ? `last review ${ageText(now - revAt)} ago` : `next review in ${ageText(revAt + limit - now)}`;
  } else {
    const all = files.map((f) => f.changed).filter((t): t is number => t !== null);
    const first = all.length ? Math.min(...all) : now;
    dueAt = first + limit;
    due = now >= dueAt;
    why = due ? `never reviewed, oldest file ${ageText(now - first)} old` : `never reviewed; first review in ${ageText(first + limit - now)}`;
  }
  if (!override) {
    if (due) next = null;
    else {
      next = dueAt;
      dueAt = null;
    }
  }
  return {
    dir,
    files,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    index,
    last_review: rev ? rev.at : null,
    unreviewed,
    oldest_unreviewed_ms: oldest,
    due,
    why,
    due_at: dueAt,
    next,
    last_review_ms: revAt,
    overridden: override !== null,
  };
}

/** One line for the home view. */
export function memoryStatusLine(st: MemoryStatus | null): string {
  if (!st) return "off";
  const parts = [
    `${st.files.length} file${st.files.length === 1 ? "" : "s"}`,
    `${st.bytes} bytes`,
    st.index ? `index ${st.index.lines} lines` : "no index",
  ];
  if (st.files.length === 0) return parts.join(" · ");
  if (st.unreviewed.length && st.last_review) parts.push(`${st.unreviewed.length} changed since review`);
  parts.push(st.due ? `review due (${st.why})` : st.why);
  return parts.join(" · ");
}

/** The one line `cycle end` and the pack print when a review is due; null otherwise. */
export function memoryDueLine(root: string, s: Settings, now: number, cli: string): string | null {
  let st: MemoryStatus | null;
  try { st = memoryStatus(root, s, now); } catch { return null; }
  if (!st || !st.due) return null;
  return `memory review due: ${st.files.length} file${st.files.length === 1 ? "" : "s"}, ${st.why}; when the cycle allows, run \`${cli} memory review --begin\``;
}

// ------------------------------------------------------------ the review

export interface Snapshot {
  at: string;
  dir: string;
  files: Record<string, string>;
}

export function snapshotPath(root: string): string {
  return gitPath(root, REVIEW_SNAPSHOT);
}

export function writeSnapshot(root: string, snap: Snapshot): void {
  writeFileSync(snapshotPath(root), `${JSON.stringify(snap)}\n`);
}

export function readSnapshot(root: string): Snapshot | null {
  try {
    const v = JSON.parse(readFileSync(snapshotPath(root), "utf8"));
    return v && typeof v.files === "object" && v.files !== null ? (v as Snapshot) : null;
  } catch {
    return null;
  }
}

export function clearSnapshot(root: string): void {
  rmSync(snapshotPath(root), { force: true });
}

export interface ReviewCounts {
  files: number;
  kept: number;
  updated: number;
  /** Folded or pruned: both are a deleted file, so the count cannot tell them apart. */
  removed: number;
  added: number;
}

/** Each snapshot file against the directory now: same content kept, changed updated, gone removed. */
export function reviewCounts(snap: Snapshot, now: MemoryFile[]): ReviewCounts {
  const cur = new Map(now.map((f) => [f.name, f.sha]));
  const c: ReviewCounts = { files: Object.keys(snap.files).length, kept: 0, updated: 0, removed: 0, added: 0 };
  for (const [name, sha] of Object.entries(snap.files)) {
    const n = cur.get(name);
    if (n === undefined) c.removed++;
    else if (n === sha) c.kept++;
    else c.updated++;
  }
  for (const f of now) if (!(f.name in snap.files)) c.added++;
  return c;
}
