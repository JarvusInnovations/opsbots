/**
 * Routines: the definitions (the bot's program) and the runs (its record), read and written
 * directly, and the due computation (specs/skills/opsbot-core.md, Routines).
 *
 *   <routines.dir>/<id>.md                       one definition: schedule as TOML frontmatter,
 *                                                instructions as the body; read at HEAD
 *   <routines.runs_dir>/YYYY/MM/<run id>.md      one run: id, routine, at, outcome, by, checked,
 *                                                handed_to, title; notes as the body
 *
 * Due is computed, never stored: an interval routine is due once its interval has passed since
 * its newest run (or `since`); a slot routine when its latest slot at or before now has no run
 * at or after it. Nothing here knows about any built-in routine; see routines.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { FrontmatterError, parseRecord, serializeRecord, type Frontmatter } from "./frontmatter.js";
import { git, hasHead, iso } from "./repo.js";
import type { Settings } from "./settings.js";

export const DAY = 86_400_000;
export const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
export const OUTCOMES = ["done", "partial", "skipped", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KEYS = ["id", "title", "cadence", "every", "at", "days", "since", "active", "owner", "hands_to"];
const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface Definition {
  id: string;
  title: string;
  /** Repo-relative path of its file; null for a built-in. */
  file: string | null;
  builtin: boolean;
  /** Days between runs, for an interval routine; null for a slot routine. */
  intervalDays: number | null;
  /** The schedule in words: `weekly`, `every 10d`, `08:30 Mon/Tue/Wed`. */
  schedule: string;
  at: string | null;
  days: number[] | null;
  since: string | null;
  active: boolean;
  owner: string | null;
  hands_to: string | null;
  /** The instructions. */
  body: string;
}

export interface Run {
  id: string;
  routine: string;
  at: string;
  atMs: number;
  outcome: string;
  by: string | null;
  checked: string[];
  handed_to: string | null;
  notes: string;
  /** Repo-relative path of its record. */
  file: string;
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join("/");

// ------------------------------------------------------------ time in the bot's zone

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  /** ISO weekday, 1 = Monday. */
  dow: number;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year!, m: +o.month!, d: +o.day!, h: +o.hour!, mi: +o.minute!, dow: DOW.indexOf(o.weekday!) };
}

/** The instant of a local wall-clock time in a zone. A time a daylight-saving change skips
 * lands an hour later; a time it repeats is the first of the two. */
export function instantOf(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(t, timeZone);
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    if (diff === 0) break;
    t += diff;
  }
  return t;
}

/** `since` as an instant: a bare date is local midnight in the zone. */
export function sinceMs(since: string | null, timeZone: string): number | null {
  if (!since) return null;
  const m = since.match(DATE_RE);
  if (m) return instantOf(+m[1]!, +m[2]!, +m[3]!, 0, 0, timeZone);
  const t = Date.parse(since);
  return Number.isNaN(t) ? null : t;
}

/** The local calendar day `offset` days from the day of `ms`, with its ISO weekday. */
function dayAt(ms: number, offset: number, timeZone: string): { y: number; m: number; d: number; dow: number } {
  const p = zonedParts(ms, timeZone);
  const probe = new Date(Date.UTC(p.y, p.m - 1, p.d + offset, 12));
  const dow = probe.getUTCDay() || 7;
  return { y: probe.getUTCFullYear(), m: probe.getUTCMonth() + 1, d: probe.getUTCDate(), dow };
}

function slotOn(def: Definition, day: { y: number; m: number; d: number }, timeZone: string): number {
  const [h, mi] = def.at!.split(":").map(Number);
  return instantOf(day.y, day.m, day.d, h!, mi!, timeZone);
}

/** The latest slot at or before `now`, not before `since`; null when there is none yet. */
export function latestSlot(def: Definition, now: number, timeZone: string): number | null {
  const since = sinceMs(def.since, timeZone);
  for (let back = 0; back <= 8; back++) {
    const day = dayAt(now, -back, timeZone);
    if (!def.days!.includes(day.dow)) continue;
    const slot = slotOn(def, day, timeZone);
    if (slot > now) continue;
    return since !== null && slot < since ? null : slot;
  }
  return null;
}

/** The first slot after `now` and not before `since`. */
export function nextSlot(def: Definition, now: number, timeZone: string): number | null {
  const since = sinceMs(def.since, timeZone);
  const from = since !== null && since > now ? since : now;
  for (let fwd = 0; fwd <= 8; fwd++) {
    const day = dayAt(from, fwd, timeZone);
    if (!def.days!.includes(day.dow)) continue;
    const slot = slotOn(def, day, timeZone);
    if (slot > now && (since === null || slot >= since)) return slot;
  }
  return null;
}

// ------------------------------------------------------------ the due computation

export interface RoutineState {
  def: Definition;
  /** Its runs, oldest first. */
  runs: Run[];
  last: Run | null;
  due: boolean;
  /** When it became due (the slot, or the end of the interval); null when never run and due
   * from the start, or not due. */
  dueAt: number | null;
  /** When it next becomes due, while it is not due; null when unknown or never. */
  next: number | null;
  /** The seen key of this due occurrence; null while not due. */
  key: string | null;
}

/** Oldest first; runs in the same second by their file, `-2` after the first. */
export function byTime(a: Run, b: Run): number {
  return a.atMs - b.atMs || a.file.length - b.file.length || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

export function computeState(def: Definition, runs: Run[], now: number, timeZone: string): RoutineState {
  const mine = runs.filter((r) => r.routine === def.id).sort(byTime);
  const last = mine.length ? mine[mine.length - 1]! : null;
  const base = { def, runs: mine, last };
  if (!def.active) return { ...base, due: false, dueAt: null, next: null, key: null };
  if (def.at) {
    const slot = latestSlot(def, now, timeZone);
    const due = slot !== null && !(last && last.atMs >= slot);
    return {
      ...base,
      due,
      dueAt: due ? slot : null,
      next: due ? null : nextSlot(def, now, timeZone),
      key: due ? `routine:${def.id}:slot:${iso(slot!)}` : null,
    };
  }
  const since = sinceMs(def.since, timeZone);
  const anchor = last ? last.atMs : since;
  if (anchor === null) return { ...base, due: true, dueAt: null, next: null, key: `routine:${def.id}:after:never` };
  const dueAt = anchor + def.intervalDays! * DAY;
  const due = now >= dueAt;
  return {
    ...base,
    due,
    dueAt: due ? dueAt : null,
    next: due ? null : dueAt,
    key: due ? `routine:${def.id}:after:${last ? last.at : `since:${def.since}`}` : null,
  };
}

// ------------------------------------------------------------ definitions

/** One definition file's problems, or its definition. */
export function parseDefinition(file: string, text: string): { def: Definition | null; problems: string[] } {
  const where = file;
  let fm: Frontmatter;
  let body: string;
  try {
    ({ data: fm, body } = parseRecord(text));
  } catch (e) {
    return { def: null, problems: [`${where}: ${e instanceof FrontmatterError ? e.message : (e as Error).message}`] };
  }
  const problems: string[] = [];
  const p = (msg: string) => problems.push(`${where}: ${msg}`);
  for (const k of Object.keys(fm)) if (!KEYS.includes(k)) p(`unknown key ${k} (allowed: ${KEYS.join(", ")})`);
  const str = (k: string): string | null => {
    const v = fm[k];
    if (v === undefined) return null;
    if (typeof v !== "string" || !v.trim()) {
      p(`${k} must be a non-empty string`);
      return null;
    }
    return v;
  };
  const id = str("id");
  const stem = basename(file).replace(/\.md$/, "");
  if (id === null) {
    if (fm.id === undefined) p("missing required key id");
  } else if (!ID_RE.test(id)) p(`id ${JSON.stringify(id)} must be lowercase letters, digits and dashes (2 to 61 characters)`);
  else if (id !== stem) p(`id ${JSON.stringify(id)} is not the file's name (${stem}.md)`);
  const title = str("title");
  if (title === null && fm.title === undefined) p("missing required key title");
  const cadence = str("cadence");
  const every = str("every");
  const at = str("at");
  const daysRaw = fm.days;
  let intervalDays: number | null = null;
  let schedule = "";
  let days: number[] | null = null;
  const hasInterval = fm.cadence !== undefined || fm.every !== undefined;
  const hasSlot = fm.at !== undefined || fm.days !== undefined;
  if (fm.cadence !== undefined && fm.every !== undefined) p("give cadence or every, not both");
  if (hasInterval && hasSlot) p("give an interval (cadence or every) or a slot (at with days), not both");
  if (!hasInterval && !hasSlot) p("no schedule: give cadence, every, or at with days");
  if (cadence !== null) {
    const m = cadence.match(/^every (\d+)d$/);
    if (cadence in CADENCE_DAYS) intervalDays = CADENCE_DAYS[cadence]!;
    else if (m && Number(m[1]) >= 1) intervalDays = Number(m[1]);
    else p(`cadence ${JSON.stringify(cadence)} must be daily, weekly, monthly, quarterly, yearly or "every Nd"`);
    schedule = cadence;
  }
  if (every !== null) {
    const m = every.match(/^(\d+)d$/);
    if (m && Number(m[1]) >= 1) intervalDays = Number(m[1]);
    else p(`every ${JSON.stringify(every)} must be a number of days such as "10d"`);
    schedule = `every ${every}`;
  }
  if (at !== null && !HM_RE.test(at)) p(`at ${JSON.stringify(at)} must be a local time HH:MM`);
  if (fm.at !== undefined && daysRaw === undefined) p("a slot needs days: the ISO weekdays it exists on (1 = Monday; all seven for every day)");
  if (daysRaw !== undefined) {
    if (fm.at === undefined) p("days goes with at");
    if (!Array.isArray(daysRaw) || daysRaw.length === 0 || !daysRaw.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7)) {
      p("days must be a non-empty array of ISO weekdays 1 to 7");
    } else if (new Set(daysRaw).size !== daysRaw.length) p("days lists a weekday twice");
    else days = [...(daysRaw as number[])].sort((a, b) => a - b);
  }
  if (at !== null && days) schedule = `${at} ${days.length === 7 ? "daily" : days.map((d) => DOW[d]).join("/")}`;
  const since = str("since");
  if (since !== null && !(DATE_RE.test(since) && !Number.isNaN(Date.parse(`${since}T00:00:00Z`))) && Number.isNaN(Date.parse(since))) {
    p(`since ${JSON.stringify(since)} must be a date YYYY-MM-DD or an ISO time`);
  }
  if (fm.active !== undefined && typeof fm.active !== "boolean") p("active must be true or false");
  const owner = str("owner");
  const hands = str("hands_to");
  if (problems.length) return { def: null, problems };
  return {
    def: {
      id: id!,
      title: title!,
      file,
      builtin: false,
      intervalDays: at !== null ? null : intervalDays,
      schedule,
      at,
      days: at !== null ? days : null,
      since,
      active: fm.active !== false,
      owner,
      hands_to: hands,
      body,
    },
    problems,
  };
}

/** The definition files in `routines.dir`: name and text, at HEAD (or the working tree). */
function definitionFiles(root: string, dir: string, head: boolean): Array<{ file: string; text: string | null }> {
  const out: Array<{ file: string; text: string | null }> = [];
  const keep = (name: string) => name.endsWith(".md") && !name.startsWith(".") && name !== "README.md";
  if (head) {
    const r = git(root, ["ls-tree", "-z", "HEAD", "--", `${dir}/`]);
    if (r.code !== 0) return out;
    for (const rec of r.stdout.split("\0")) {
      const m = rec.match(/^\d+ (\w+) [0-9a-f]+\t(.+)$/);
      if (!m || m[1] !== "blob" || !keep(basename(m[2]!))) continue;
      const s = git(root, ["show", `HEAD:${m[2]}`]);
      out.push({ file: m[2]!, text: s.code === 0 ? s.stdout : null });
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : 1));
  }
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (!e.isFile() || !keep(e.name)) continue;
    out.push({ file: `${dir}/${e.name}`, text: readFileSync(join(abs, e.name), "utf8") });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

export interface Definitions {
  defs: Definition[];
  problems: string[];
  /** How many definition files there are, valid or not. */
  files: number;
}

/** Every definition in `routines.dir`, at HEAD by default (what was reviewed), with every
 * problem named. A checkout without a HEAD reads the working tree. */
export function readDefinitions(root: string, s: Settings, opts: { head?: boolean } = {}): Definitions {
  const head = opts.head !== false && hasHead(root);
  const files = definitionFiles(root, s.routines.dir, head);
  const defs: Definition[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    if (f.text === null) {
      problems.push(`${f.file}: cannot be read`);
      continue;
    }
    const r = parseDefinition(f.file, f.text);
    problems.push(...r.problems);
    if (!r.def) continue;
    const prev = seen.get(r.def.id);
    if (prev) {
      problems.push(`${f.file}: duplicate id ${r.def.id}, also in ${prev}`);
      continue;
    }
    seen.set(r.def.id, f.file);
    defs.push(r.def);
  }
  return { defs, problems, files: files.length };
}

// ------------------------------------------------------------ runs

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") out.push(p);
  }
  return out.sort();
}

/** The notes of a run: its body without the leading `# title` line. */
function notesOf(body: string): string {
  return body.replace(/^#\s+[^\n]*\n*/, "").trim();
}

/** Every run in `routines.runs_dir` (the working tree: runs are the bot's own record). */
export function readRuns(root: string, s: Settings): { runs: Run[]; problems: string[] } {
  const runs: Run[] = [];
  const problems: string[] = [];
  for (const abs of walk(resolve(root, s.routines.runs_dir))) {
    const file = rel(root, abs);
    try {
      const { data, body } = parseRecord(readFileSync(abs, "utf8"));
      const at = typeof data.at === "string" ? data.at : null;
      const atMs = at ? Date.parse(at) : NaN;
      if (typeof data.routine !== "string" || !data.routine) throw new FrontmatterError("no routine");
      if (at === null || Number.isNaN(atMs)) throw new FrontmatterError("no readable at");
      runs.push({
        id: typeof data.id === "string" ? data.id : basename(file, ".md"),
        routine: data.routine,
        at,
        atMs,
        outcome: typeof data.outcome === "string" ? data.outcome : "done",
        by: typeof data.by === "string" ? data.by : null,
        checked: Array.isArray(data.checked) ? data.checked.map(String) : [],
        handed_to: typeof data.handed_to === "string" ? data.handed_to : null,
        notes: notesOf(body),
        file,
      });
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { runs, problems };
}

export interface NewRun {
  routine: string;
  title: string;
  atMs: number;
  outcome: string;
  by: string;
  notes: string;
  checked: string[];
  handed_to: string | null;
}

/** Write one run record; returns its repo-relative path and id. Never overwrites: a run in the
 * same minute gets `-2`, `-3`. */
export function writeRun(root: string, s: Settings, r: NewRun): { file: string; id: string } {
  const at = iso(r.atMs);
  const dir = resolve(root, s.routines.runs_dir, at.slice(0, 4), at.slice(5, 7));
  const stem = `${r.routine}-${at.slice(0, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}`;
  let id = stem;
  for (let n = 2; existsSync(join(dir, `${id}.md`)); n++) id = `${stem}-${n}`;
  const title = `${r.title}: ${r.outcome} ${at.slice(0, 10)}`;
  const data: Frontmatter = { id, routine: r.routine, at, outcome: r.outcome, by: r.by, checked: r.checked, title };
  if (r.handed_to) data.handed_to = r.handed_to;
  const path = join(dir, `${id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRecord(data, `# ${title}\n\n${r.notes.trim()}`));
  return { file: rel(root, path), id };
}

/**
 * Every changed path under the runs directory (new, modified, deleted), as absolute paths for a
 * commit's `--only` list, leaving out any in `already`. As for memory: one `git status` names
 * each file, so a deletion is a deletion and an ignored file is never taken.
 */
export function changedRunFiles(root: string, s: Settings, already: string[] = []): string[] {
  const dir = resolve(root, s.routines.runs_dir);
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", dir]);
  if (r.code !== 0) return [];
  const have = new Set(already.map((f) => resolve(root, f)));
  const out: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (rec.length < 4 || rec.slice(0, 2) === "AD") continue;
    const abs = resolve(root, rec.slice(3));
    if (have.has(abs)) continue;
    have.add(abs);
    out.push(abs);
  }
  return out;
}
