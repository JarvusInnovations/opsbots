/**
 * The log branch (specs/behaviors/log-branch.md): the loop's own log written to a branch that is
 * never checked out, through gitsheets. This module owns every call to
 * `gitsheets-axi --branch <log.branch>`; nothing else in the kit shells out to gitsheets for the
 * log. Opt-in: with `log.branch` unset in opsbot.json at HEAD, `logBranch` is null and the file
 * writer in state.ts is used, unchanged.
 *
 *   cycles    cycles/YYYY/MM/DD/HH/<mmss>-<outcome>   one record per cycle-log line that is not a
 *                                                     quiet check (time in the path; gitsheets
 *                                                     also keeps `at` in the record)
 *   seen      seen/YYYY/MM/DD/<key hash>              one record per seen key
 *   outages   outages/YYYY/MM/DD/<hhmmss>-<kind>-<start|end>   one record per outage line
 *   routines  routines/<routine>/YYYY/MM/DD/<hhmmss>            one record per routine run
 *
 * Every log commit after the root carries `Program`, `Watermark` and `Check` trailers; a quiet
 * commit adds `Quiet-Cycles`, `Quiet-Since`, `Quiet-Until` and `Since`. The second parent (the
 * program commit) is added when the tip's `Program` differs from the program's head.
 *
 * What a cycle writes between `check` and `cycle end`, and what the watchdog, `outage` and
 * `memory review --done` write outside a cycle, is staged in <git dir>/opsbot-log-pending.json
 * and rides the next log commit, as the file writer's uncommitted lines rode the next cycle
 * commit. Readers see staged lines as well as committed ones.
 *
 * Records are read with `gitsheets-axi query --json-out` and cached in
 * <git dir>/opsbot-log-cache.json per sheet, keyed by the sheet's tree on the branch; a changed
 * tree re-reads only the days that changed. A read of the tip (liveness, the watermark) is one
 * `git log` call and opens no sheet.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine, git, gitPath, iso, parseIso, run, showHead } from "./repo.js";

export const DEFAULT_LOG_BRANCH = "opsbot/log";
export const MIN_GITSHEETS = "2.15.0";
const PENDING = "opsbot-log-pending.json";
const CACHE = "opsbot-log-cache.json";
const GS_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 60_000;

export type Sheet = "cycles" | "seen" | "outages" | "routines";
export const SHEETS: Sheet[] = ["cycles", "outages", "seen", "routines"];
export type Rec = Record<string, unknown>;

// a path component from `at`, guarded: while gitsheets walks a range on the date bucket it
// renders the template with a Date there, and an unguarded `at.slice` fails the whole query
const HH = "${{ typeof at == 'string' ? at.slice(11,13) : wild }}";
const MMSS = "${{ typeof at == 'string' ? at.slice(14,16) + at.slice(17,19) : wild }}";
const HHMMSS = "${{ typeof at == 'string' ? at.slice(11,13) + at.slice(14,16) + at.slice(17,19) : wild }}";
const DAY = "${{ at: YYYY/MM/DD }}";

const AT = { type: "string", format: "date-time" };
export const SHEET_CONFIGS: Record<Sheet, { path: string; schema: Rec }> = {
  cycles: {
    path: `${DAY}/${HH}/${MMSS}-\${{ outcome }}`,
    schema: { type: "object", required: ["at", "outcome"], properties: { at: AT, outcome: { type: "string" } } },
  },
  seen: {
    path: `${DAY}/\${{ hash }}`,
    schema: { type: "object", required: ["at", "hash", "key"], properties: { at: AT, hash: { type: "string" }, key: { type: "string" } } },
  },
  outages: {
    path: `${DAY}/${HHMMSS}-\${{ kind }}-\${{ edge }}`,
    schema: {
      type: "object",
      required: ["at", "kind", "edge", "outcome"],
      properties: { at: AT, kind: { type: "string" }, edge: { type: "string", enum: ["start", "end"] }, outcome: { type: "string" } },
    },
  },
  routines: {
    path: `\${{ routine }}/${DAY}/${HHMMSS}`,
    schema: { type: "object", required: ["at", "routine"], properties: { at: AT, routine: { type: "string" } } },
  },
};

/** A record's identity within its sheet: what its path is made of. */
function ident(sheet: Sheet, r: Rec): string {
  const at = String(r.at ?? "");
  if (sheet === "seen") return String(r.hash ?? "");
  if (sheet === "cycles") return `${at}|${String(r.outcome ?? "")}`;
  if (sheet === "outages") return `${at}|${String(r.kind ?? "")}|${String(r.edge ?? "")}`;
  return `${String(r.routine ?? "")}|${at}`;
}

// ------------------------------------------------------------------ the setting

const branchCache = new Map<string, string | null>();

/** `log.branch` from opsbot.json at HEAD, or null when it is unset (the file writer). */
export function logBranch(root: string): string | null {
  if (branchCache.has(root)) return branchCache.get(root)!;
  let b: string | null = null;
  const text = showHead(root, "opsbot.json");
  if (text !== null) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v.log === "object" && v.log && typeof v.log.branch === "string" && v.log.branch) b = v.log.branch;
    } catch {
      // settings that cannot be read are refused by loadSettings, not here
    }
  }
  branchCache.set(root, b);
  return b;
}

/** For tests in one process: forget what was read. */
export function forgetLogBranch(): void {
  branchCache.clear();
}

export function gitsheetsBin(): string {
  return process.env.OPSBOT_GITSHEETS_AXI || "gitsheets-axi";
}

/** The installed gitsheets-axi version, or null when it does not run. */
export function gitsheetsVersion(): string | null {
  const r = run(gitsheetsBin(), ["--version"], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  const m = r.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : null;
}

/** Whether version `a` is at least `b` (both x.y.z). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ gitsheets

interface GsResult {
  code: number;
  out: string;
  /** The `code:` gitsheets-axi printed with an error (TIP_MISMATCH, NON_FAST_FORWARD, …). */
  error: string | null;
  message: string;
}

function gs(root: string, branch: string, args: string[], input?: string, timeoutMs = GS_TIMEOUT_MS): GsResult {
  const r = run(gitsheetsBin(), ["--branch", branch, ...args], { cwd: root, input, timeoutMs });
  const text = `${r.stdout}\n${r.stderr}`;
  const code = r.code === 0 ? null : (text.match(/^code:\s*(\S+)/m)?.[1] ?? (r.code === 124 ? "TIMEOUT" : "FAILED"));
  const err = text.split("\n").find((l) => l.startsWith("error:"));
  const message = (err ? err.replace(/^error:\s*/, "").replace(/^"|"$/g, "") : "") || firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
  return { code: r.code, out: r.stdout, error: code, message: message.slice(0, 300) };
}

// ------------------------------------------------------------------ the tip

export interface Tip {
  hash: string;
  parents: string[];
  trailers: Record<string, string>;
  /** Paths the tip added or changed against its first parent, under cycles/. */
  cyclePaths: string[];
}

const ref = (b: string) => `refs/heads/${b}`;

function revParse(root: string, r: string): string | null {
  const x = git(root, ["rev-parse", "--verify", "-q", `${r}^{commit}`]);
  return x.code === 0 ? x.stdout.trim() || null : null;
}

/** The program commit the loop runs on: the checkout's HEAD. */
export function programHead(root: string): string | null {
  return revParse(root, "HEAD");
}

/**
 * The local log branch, taken from the remote when only the remote has it (a fresh clone resumes
 * from what was pushed). Never initialises. Returns whether the branch exists locally.
 */
function haveLocal(root: string, b: string): boolean {
  if (revParse(root, ref(b))) return true;
  const remote = revParse(root, `refs/remotes/origin/${b}`);
  if (!remote) return false;
  return git(root, ["branch", "-q", "--no-track", b, remote]).code === 0;
}

/** The tip of the log branch, read with one git call; null when there is no branch yet. */
export function readTip(root: string, b: string): Tip | null {
  return readTips(root, b, 1)[0] ?? null;
}

/** The newest `n` commits on the branch's first-parent line, newest first. One git call. */
function readTips(root: string, b: string, n: number): Tip[] {
  if (!haveLocal(root, b)) return [];
  const r = git(root, ["log", "--first-parent", `-${n}`, "--diff-merges=first-parent", "--name-only", "--format=%x1e%H%x1f%P%x1f%(trailers:only,unfold)%x1f", ref(b)]);
  if (r.code !== 0) return [];
  return r.stdout.split("\x1e").slice(1).map(parseTip);
}

function parseTip(body: string): Tip {
  const [hash = "", parents = "", tr = "", names = ""] = body.split("\x1f");
  const trailers: Record<string, string> = {};
  for (const line of tr.split("\n")) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) trailers[m[1]!] = m[2]!.trim();
  }
  return {
    hash: hash.trim(),
    parents: parents.trim().split(/\s+/).filter(Boolean),
    trailers,
    cyclePaths: names.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("cycles/")),
  };
}

const CYCLE_PATH_RE = /^cycles\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})-(.+)\.toml$/;

/** The time and outcome a cycles record's path says. */
export function cyclePathTime(p: string): { at: string; outcome: string } | null {
  const m = p.match(CYCLE_PATH_RE);
  if (!m) return null;
  return { at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, outcome: m[7]! };
}

const LIVE_OUTCOMES = ["nothing-new", "new", "degraded", "finished"];

/** The time of the newest cycle the tip stands for: a quiet run's `Quiet-Until`, else the
 * newest check or finish whose record the tip added. */
export function tipLastCycleAt(tip: Tip | null): string | null {
  if (!tip) return null;
  let best: string | null = null;
  const q = tip.trailers["Quiet-Until"];
  if (q && parseIso(q) !== null) best = q;
  for (const p of tip.cyclePaths) {
    const t = cyclePathTime(p);
    if (t && LIVE_OUTCOMES.includes(t.outcome) && (best === null || t.at > best)) best = t.at;
  }
  return best;
}

export function tipWatermark(tip: Tip | null): string | null {
  const w = tip?.trailers.Watermark;
  return w && parseIso(w) !== null ? w : null;
}

/** Whether the tip is an open quiet commit at `nowMs`: quiet, and from the current hour. Whether
 * it was pushed is gitsheets' to judge (TIP_PUBLISHED). */
export function isOpenQuiet(tip: Tip | null, nowMs: number): boolean {
  if (!tip || !tip.trailers["Quiet-Cycles"]) return false;
  const until = tip.trailers["Quiet-Until"] ?? "";
  return until.slice(0, 13) === iso(nowMs).slice(0, 13);
}

// ------------------------------------------------------------------ staged lines

export interface Pending {
  cycles: Rec[];
  seen: Rec[];
  outages: Rec[];
  routines: Rec[];
  /** A watermark a `check --no-commit` advanced, for the next commit's trailer. */
  watermark?: string;
}

const emptyPending = (): Pending => ({ cycles: [], seen: [], outages: [], routines: [] });

export function readPending(root: string): Pending {
  try {
    const v = JSON.parse(readFileSync(gitPath(root, PENDING), "utf8"));
    const p = emptyPending();
    for (const s of SHEETS) if (Array.isArray(v[s])) p[s] = v[s];
    if (typeof v.watermark === "string") p.watermark = v.watermark;
    return p;
  } catch {
    return emptyPending();
  }
}

function writePending(root: string, p: Pending): void {
  const f = gitPath(root, PENDING);
  if (SHEETS.every((s) => p[s].length === 0) && !p.watermark) {
    rmSync(f, { force: true });
    return;
  }
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p)}\n`);
  renameSync(tmp, f);
}

/** Stage records to ride the next log commit. */
export function stage(root: string, add: Partial<Pending>): void {
  const p = readPending(root);
  for (const s of SHEETS) if (add[s]?.length) p[s].push(...add[s]!.map(clean));
  if (add.watermark) p.watermark = add.watermark;
  writePending(root, p);
}

/** Drop records from the stage (what a commit took, or a line it could not write) (by identity), keeping anything staged since. */
export function dropStaged(root: string, took: Partial<Pending>): void {
  const p = readPending(root);
  for (const s of SHEETS) {
    const gone = new Set((took[s] ?? []).map((r) => ident(s, r)));
    p[s] = p[s].filter((r) => !gone.has(ident(s, r)));
  }
  if (took.watermark && p.watermark === took.watermark) delete p.watermark;
  writePending(root, p);
}

export function hasStaged(p: Pending): boolean {
  return SHEETS.some((s) => p[s].length > 0);
}

/** A record as TOML can hold it: no nulls, at any depth. */
export function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(clean) as T;
  if (v && typeof v === "object") {
    const o: Rec = {};
    for (const [k, x] of Object.entries(v as Rec)) if (x !== null && x !== undefined) o[k] = clean(x);
    return o as T;
  }
  return v;
}

export function seenHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 20);
}

export function seenRecords(keys: string[], at: string): Rec[] {
  return keys.map((key) => ({ at, hash: seenHash(key), key }));
}

// ------------------------------------------------------------------ init

/** Make the branch's root: one orphan commit holding the sheet configs. gitsheets refuses an
 * additional parent on an orphan commit, so the program commit is the second parent of the first
 * log commit after the root instead. */
function initBranch(root: string, b: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-log-init-"));
  try {
    let tip: string | null = null;
    for (const s of SHEETS) {
      const schema = join(dir, `${s}.json`);
      writeFileSync(schema, JSON.stringify(SHEET_CONFIGS[s].schema));
      const args = ["init", s, "--path", SHEET_CONFIGS[s].path, "--schema", schema, "--message", "log: the sheets of the loop's log"];
      if (tip) args.push("--replace", tip);
      const r = gs(root, b, args);
      if (r.code !== 0) return `gitsheets-axi init ${s} failed: ${r.message}`;
      tip = revParse(root, ref(b));
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The local branch exists after this, taken from the remote or made new. Null, or why not. */
export function ensureBranch(root: string, b: string): string | null {
  if (haveLocal(root, b)) return null;
  // a single-branch clone has not fetched it: one try, then a new branch
  if (git(root, ["remote", "get-url", "origin"]).code === 0) {
    const f = run("git", ["-C", root, "fetch", "-q", "origin", `+${ref(b)}:refs/remotes/origin/${b}`], { timeoutMs: PUSH_TIMEOUT_MS });
    if (f.code === 0 && haveLocal(root, b)) return null;
  }
  return initBranch(root, b);
}

// ------------------------------------------------------------------ writes

export interface Write {
  records: Partial<Record<Sheet, Rec[]>>;
  subject: string;
  watermark: string | null;
  check: string;
}

function sessionTrailers(extra: string): string[] {
  return extra
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9-]+:\s*\S/.test(l));
}

function trailerArgs(list: string[]): string[] {
  return list.flatMap((t) => ["--trailer", t]);
}

/** The trailers every log commit carries. */
function baseTrailers(head: string | null, watermark: string | null, check: string): string[] {
  return [`Program: ${head ?? "none"}`, `Watermark: ${watermark ?? "none"}`, `Check: ${check}`];
}

export type WriteResult = { ok: true; hash: string } | { ok: false; why: string };

/**
 * One log commit with every record in `w`: the first sheet's write makes the commit (with the
 * second parent when the program moved), each further sheet replaces it, so the cycle is one
 * commit whatever it wrote. A TIP_MISMATCH midway (another writer committed on top) starts the
 * rest over as a new commit, once.
 */
export function writeLog(root: string, b: string, w: Write, session = ""): WriteResult {
  const why = ensureBranch(root, b);
  if (why) return { ok: false, why };
  const sheets = SHEETS.filter((s) => (w.records[s]?.length ?? 0) > 0);
  let retried = false;
  const attempt = (todo: Sheet[]): WriteResult => {
    const tip = readTip(root, b);
    if (!tip) return { ok: false, why: `the log branch ${b} cannot be read` };
    const head = programHead(root);
    const trailers = trailerArgs([...baseTrailers(head, w.watermark, w.check), ...sessionTrailers(session)]);
    const also = head && tip.trailers.Program !== head ? ["--also-parent", head] : [];
    const before = snapshotTrees(root, b);
    let made: string | null = null;
    const done: Sheet[] = [];
    if (todo.length === 0) {
      const r = gs(root, b, ["commit", "--allow-empty", "--message", w.subject, ...also, ...trailers]);
      if (r.code !== 0) return { ok: false, why: `gitsheets-axi commit failed: ${r.message}` };
      return { ok: true, hash: revParse(root, ref(b)) ?? "" };
    }
    for (const s of todo) {
      const input = w.records[s]!.map((x) => JSON.stringify(clean(x))).join("\n");
      const args = ["upsert", s, "--message", w.subject, ...trailers, ...(made ? ["--replace", made] : also)];
      const r = gs(root, b, args, `${input}\n`);
      if (r.code !== 0) {
        if (r.error === "TIP_MISMATCH" && !retried) {
          retried = true;
          return attempt(todo.filter((x) => !done.includes(x)));
        }
        return { ok: false, why: `gitsheets-axi upsert ${s} failed: ${r.message}` };
      }
      const now = revParse(root, ref(b));
      // a batch that changed nothing makes no commit: the next sheet makes it
      if (now && now !== (made ?? tip.hash)) made = now;
      done.push(s);
    }
    noteWritten(root, b, before, Object.fromEntries(done.map((s) => [s, w.records[s]!])) as Partial<Record<Sheet, Rec[]>>);
    return { ok: true, hash: made ?? tip.hash };
  };
  return attempt(sheets);
}

/** Commit what is staged plus `extra`, then drop from the stage what the commit took. */
export function commitStaged(root: string, b: string, extra: Partial<Record<Sheet, Rec[]>>, o: { subject: string; watermark?: string | null; check?: string | null }, session = ""): WriteResult {
  const p = readPending(root);
  const records: Partial<Record<Sheet, Rec[]>> = {};
  for (const s of SHEETS) {
    const all = [...p[s], ...(extra[s] ?? []).map(clean)];
    if (all.length) records[s] = all;
  }
  const tip = readTip(root, b);
  const wm = o.watermark !== undefined ? o.watermark : laterOf(p.watermark ?? null, tipWatermark(tip));
  const r = writeLog(root, b, { records, subject: o.subject, watermark: wm, check: o.check ?? tip?.trailers.Check ?? "full" }, session);
  if (r.ok) dropStaged(root, { ...p, watermark: p.watermark });
  return r;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export interface Quiet {
  now: string;
  watermark: string | null;
  check: string;
  since: string;
}

/**
 * A quiet cycle: it replaces the tip when the tip is an open quiet commit of the same kind of
 * check on the same program (`Quiet-Cycles` one higher, `Quiet-Since` kept, no record changed),
 * and otherwise opens a new one. TIP_MISMATCH and TIP_PUBLISHED fall back to a new quiet commit.
 */
export function writeQuiet(root: string, b: string, q: Quiet, nowMs: number, session = ""): WriteResult & { cycles?: number } {
  const why = ensureBranch(root, b);
  if (why) return { ok: false, why };
  const tip = readTip(root, b);
  if (!tip) return { ok: false, why: `the log branch ${b} cannot be read` };
  const head = programHead(root);
  const base = baseTrailers(head, q.watermark, q.check);
  const own = sessionTrailers(session);
  const n = Number(tip.trailers["Quiet-Cycles"] ?? 0);
  const open = isOpenQuiet(tip, nowMs) && tip.trailers.Check === q.check && tip.trailers.Program === (head ?? "none") && n > 0;
  if (open) {
    const since = tip.trailers["Quiet-Since"] ?? q.now;
    const r = gs(root, b, [
      "commit", "--allow-empty", "--replace", tip.hash,
      "--message", quietSubject(n + 1, since, q.now),
      ...trailerArgs([...base, `Quiet-Cycles: ${n + 1}`, `Quiet-Since: ${since}`, `Quiet-Until: ${q.now}`, `Since: ${q.since}`, ...own]),
    ]);
    if (r.code === 0) return { ok: true, hash: revParse(root, ref(b)) ?? "", cycles: n + 1 };
    if (r.error !== "TIP_MISMATCH" && r.error !== "TIP_PUBLISHED") return { ok: false, why: `gitsheets-axi commit failed: ${r.message}` };
  }
  const cur = readTip(root, b) ?? tip;
  const also = head && cur.trailers.Program !== head ? ["--also-parent", head] : [];
  const r = gs(root, b, [
    "commit", "--allow-empty", ...also,
    "--message", quietSubject(1, q.now, q.now),
    ...trailerArgs([...base, "Quiet-Cycles: 1", `Quiet-Since: ${q.now}`, `Quiet-Until: ${q.now}`, `Since: ${q.since}`, ...own]),
  ]);
  if (r.code !== 0) return { ok: false, why: `gitsheets-axi commit failed: ${r.message}` };
  return { ok: true, hash: revParse(root, ref(b)) ?? "", cycles: 1 };
}

function quietSubject(n: number, since: string, until: string): string {
  return n === 1 ? `cycle: nothing new at ${until.slice(11, 16)}Z` : `cycle: nothing new ×${n}, ${since.slice(11, 16)}Z to ${until.slice(11, 16)}Z`;
}

// ------------------------------------------------------------------ push

export type PushResult = { pushed: boolean; refused: boolean; why: string | null };

/**
 * Push the log branch up to its newest sealed commit: the tip, unless the tip is an open quiet
 * commit, then its first parent. A plain push, never forced. NON_FAST_FORWARD is `refused`: another
 * host writes this bot's log.
 */
export function pushLog(root: string, b: string, nowMs: number): PushResult {
  if (git(root, ["remote", "get-url", "origin"]).code !== 0) return { pushed: false, refused: false, why: "no remote named origin" };
  const tip = readTip(root, b);
  if (!tip) return { pushed: false, refused: false, why: null };
  const target = isOpenQuiet(tip, nowMs) ? tip.parents[0] : tip.hash;
  if (!target) return { pushed: false, refused: false, why: null };
  const remote = revParse(root, `refs/remotes/origin/${b}`);
  if (remote && git(root, ["merge-base", "--is-ancestor", target, remote]).code === 0) return { pushed: false, refused: false, why: null };
  const r = gs(root, b, ["push", "--to", target], undefined, PUSH_TIMEOUT_MS);
  if (r.code === 0) return { pushed: true, refused: false, why: null };
  if (r.error === "NON_FAST_FORWARD") {
    const ls = run("git", ["-C", root, "ls-remote", "origin", ref(b)], { timeoutMs: PUSH_TIMEOUT_MS });
    const theirs = ls.code === 0 ? ls.stdout.split(/\s/)[0]?.slice(0, 12) : null;
    return {
      pushed: false,
      refused: true,
      why: `log push refused: the remote's ${b} is at ${theirs || "a commit this host does not have"}, not on this host's log; another host may be running this bot`,
    };
  }
  return { pushed: false, refused: false, why: `log push failed: ${r.message.slice(0, 120)}` };
}

// ------------------------------------------------------------------ reads

interface SheetCache {
  tree: string;
  records: Rec[];
}
type Cache = Partial<Record<Sheet, SheetCache>>;

function readCache(root: string): Cache {
  try {
    return JSON.parse(readFileSync(gitPath(root, CACHE), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function writeCache(root: string, c: Cache): void {
  const f = gitPath(root, CACHE);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, f);
  } catch {
    // a cache: the next read rebuilds it
  }
}

/** Each sheet's tree on the branch tip (absent: no record yet). One git call. */
function sheetTrees(root: string, b: string): Partial<Record<Sheet, string>> {
  const r = git(root, ["ls-tree", ref(b)]);
  const out: Partial<Record<Sheet, string>> = {};
  if (r.code !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\d+ tree ([0-9a-f]+)\t(.+)$/);
    if (m && (SHEETS as string[]).includes(m[2]!)) out[m[2] as Sheet] = m[1]!;
  }
  return out;
}

function snapshotTrees(root: string, b: string): Partial<Record<Sheet, string>> {
  return sheetTrees(root, b);
}

/** After our own write: the cache is the records it had plus those written, under the new tree,
 * when it was current before the write; otherwise it is left for the next read to sync. */
function noteWritten(root: string, b: string, before: Partial<Record<Sheet, string>>, written: Partial<Record<Sheet, Rec[]>>): void {
  const after = sheetTrees(root, b);
  const c = readCache(root);
  for (const s of SHEETS) {
    if (!written[s]?.length) continue;
    const cur = c[s];
    const was = before[s] ?? "";
    if (!after[s]) continue;
    if ((cur && cur.tree === was) || (!cur && !was)) {
      const map = new Map((cur?.records ?? []).map((r) => [ident(s, r), r]));
      for (const r of written[s]!) map.set(ident(s, r), clean(r));
      c[s] = { tree: after[s]!, records: [...map.values()] };
    }
  }
  writeCache(root, c);
}

function query(root: string, b: string, sheet: Sheet, filter: string | null): Rec[] | null {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-log-q-"));
  try {
    const out = join(dir, "rows.json");
    const args = ["query", sheet, "--limit", "1", `--json-out=${out}`];
    if (filter) args.push("--filter", filter);
    const r = gs(root, b, args);
    if (r.code !== 0) return null;
    if (!existsSync(out)) return [];
    const v = JSON.parse(readFileSync(out, "utf8"));
    return Array.isArray(v) ? (v as Rec[]) : [];
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DAY_IN_PATH = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/;

/** Every record of a sheet on the branch tip, from the cache when its tree is unchanged. */
export function sheetRecords(root: string, b: string, sheet: Sheet): Rec[] {
  if (!haveLocal(root, b)) return [];
  const trees = sheetTrees(root, b);
  const tree = trees[sheet];
  if (!tree) return [];
  const c = readCache(root);
  const cur = c[sheet];
  if (cur && cur.tree === tree) return cur.records;
  let records: Rec[] | null = null;
  if (cur) {
    // only the days that changed are read again
    const d = git(root, ["diff-tree", "-r", "--name-only", cur.tree, tree]);
    const days = d.code === 0 ? d.stdout.split("\n").map((p) => p.match(DAY_IN_PATH)).filter((m): m is RegExpMatchArray => !!m).map((m) => `${m[1]}-${m[2]}-${m[3]}`) : [];
    const changed = d.code === 0 ? d.stdout.split("\n").filter((p) => p.trim()).length : -1;
    if (changed >= 0 && days.length === changed && days.length > 0) {
      const from = days.sort()[0]!;
      const fresh = query(root, b, sheet, `at>=${from}`);
      if (fresh) records = [...cur.records.filter((r) => String(r.at ?? "") < from), ...fresh];
    }
  }
  if (records === null) records = query(root, b, sheet, null);
  if (records === null) return cur?.records ?? [];
  c[sheet] = { tree, records };
  writeCache(root, c);
  return records;
}

/** The quiet commits on the branch's first-parent line, oldest first. One git call. */
export function quietRuns(root: string, b: string): Array<Record<string, string>> {
  if (!haveLocal(root, b)) return [];
  const r = git(root, ["log", "--first-parent", "--format=%x1e%(trailers:only,unfold)", ref(b)]);
  if (r.code !== 0) return [];
  const out: Array<Record<string, string>> = [];
  for (const block of r.stdout.split("\x1e")) {
    if (!block.includes("Quiet-Cycles:")) continue;
    const t: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) t[m[1]!] = m[2]!.trim();
    }
    out.push(t);
  }
  return out.reverse();
}

/**
 * The lines a quiet commit stands for: `Quiet-Cycles` nothing-new checks from `Quiet-Since` to
 * `Quiet-Until`, the times between spread evenly (the commit keeps only the first and the last).
 */
export function quietLines(t: Record<string, string>): Rec[] {
  const n = Math.max(1, Number(t["Quiet-Cycles"] ?? 1) || 1);
  const from = parseIso(t["Quiet-Since"]);
  const to = parseIso(t["Quiet-Until"] ?? t.Watermark);
  if (from === null || to === null) return [];
  const fast = t.Check === "fast";
  const out: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const at = n === 1 ? to : from + Math.round(((to - from) * i) / (n - 1));
    const line: Rec = { at: iso(at), outcome: "nothing-new", inputs: {}, new: 0, failed: [], check: fast ? "fast" : "full" };
    if (fast) line.fast = true;
    if (i === n - 1) {
      if (t.Since) line.since = t.Since;
      line.watermark = t.Watermark && t.Watermark !== "none" ? t.Watermark : null;
    }
    out.push(line);
  }
  return out;
}

const byAt = (a: Rec, b: Rec) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0);

/** The cycle log as the file writer would have it: records, the quiet runs, and staged lines. */
export function branchCycleLines(root: string, b: string): Rec[] {
  const recs = sheetRecords(root, b, "cycles");
  const quiet = quietRuns(root, b).flatMap(quietLines);
  const staged = readPending(root).cycles;
  return [...recs, ...quiet, ...staged].sort(byAt);
}

export function branchOutageLines(root: string, b: string): Rec[] {
  return [...sheetRecords(root, b, "outages"), ...readPending(root).outages].sort(byAt);
}

export function branchSeen(root: string, b: string): Set<string> {
  const keys = new Set<string>();
  for (const r of sheetRecords(root, b, "seen")) if (typeof r.key === "string") keys.add(r.key);
  for (const r of readPending(root).seen) if (typeof r.key === "string") keys.add(r.key);
  return keys;
}

export function branchRoutineRecords(root: string, b: string): Rec[] {
  return [...sheetRecords(root, b, "routines"), ...readPending(root).routines].sort(byAt);
}

/** The watermark: a staged one when a `check --no-commit` advanced it, else the tip's trailer. */
export function branchWatermark(root: string, b: string): string | null {
  return laterOf(readPending(root).watermark ?? null, tipWatermark(readTip(root, b)));
}

/** The newest cycle: the tip's trailers and paths (or, when the tip is a sleep or another
 * commit that is not a cycle, the newest such commit's below it), and any check or finish staged
 * since. One git call. */
export function branchLastCycleAt(root: string, b: string): string | null {
  let best: string | null = null;
  for (const t of readTips(root, b, 20)) {
    best = tipLastCycleAt(t);
    if (best) break;
  }
  for (const l of readPending(root).cycles) {
    if (LIVE_OUTCOMES.includes(String(l.outcome)) && typeof l.at === "string" && (best === null || l.at > best)) best = l.at;
  }
  return best;
}

/** The seen keys, one per line, for heartbeat scripts (OPSBOT_SEEN): a file in the git dir,
 * never the working tree. */
export function seenFileFor(root: string, b: string): string {
  const f = gitPath(root, "opsbot-seen");
  try {
    writeFileSync(f, [...branchSeen(root, b)].map((k) => `${k}\n`).join(""));
  } catch {
    // the scripts then read an empty or older list; the core still drops seen keys
  }
  return f;
}
