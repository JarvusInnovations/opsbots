/**
 * The log branch (specs/behaviors/log-branch.md): the loop's own log written to a branch that is
 * never checked out, through gitsheets. This module owns every call to
 * `gitsheets-axi --branch <log.branch>`; nothing else in the kit shells out to gitsheets for the
 * log. It is the only writer of the log: `log.branch` in opsbot.json at HEAD names the branch
 * (default `opsbot/log`), and a checkout still set up for the old log files is refused until
 * `log migrate`'s commit is merged into it (see `logWriter`).
 *
 *   cycles    cycles/YYYY/MM/DD/HH/<mmss>-<outcome>   one record per cycle-log line that is not a
 *                                                     quiet check (time in the path; gitsheets
 *                                                     also keeps `at` in the record)
 *   seen      seen/YYYY/MM/DD/<key hash>              one record per seen key
 *   outages   outages/YYYY/MM/DD/<hhmmss>-<kind>-<start|end>   one record per outage line
 *   routines  routines/<routine>/YYYY/MM/DD/<hhmmss>            one record per routine run
 *   posts     posts/<channel>/YYYY/MM/DD/<hhmmss>-<hash>        one record per post attempt
 *   ledgers   ledgers/<name>/YYYY/MM/DD/<hhmmss>-<hash>         one record per action a script took
 *   state     state/<name>                                      one baseline per name, replaced
 *
 * The root holds the `cycles` config; a sheet whose config is not yet on the branch has it added
 * by the first commit that writes the sheet, in that same commit.
 *
 * Every log commit after the root carries `Program`, `Watermark` and `Check` trailers; a quiet
 * commit adds `Quiet-Cycles`, `Quiet-Since`, `Quiet-Until` and `Since`. The second parent (the
 * program commit) is added when the tip's `Program` differs from the program's head.
 *
 * What a cycle writes between `check` and `cycle end`, and what the watchdog, `outage` and
 * `memory review --done` write outside a cycle, is staged in <git dir>/opsbot-log-pending.json
 * and rides the next log commit. Readers see staged lines as well as committed ones.
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
import { AxiError } from "axi-sdk-js";
import { cliInvocation } from "./invocation.js";
import { oldSetup } from "./legacy.js";
import { firstLine, git, gitPath, iso, parseIso, run, showHead } from "./repo.js";

export const DEFAULT_LOG_BRANCH = "opsbot/log";
export const MIN_GITSHEETS = "2.15.0";
const PENDING = "opsbot-log-pending.json";
const CACHE = "opsbot-log-cache.json";
const GS_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 60_000;

export type Sheet = "cycles" | "seen" | "outages" | "routines" | "posts" | "ledgers" | "state";
export const SHEETS: Sheet[] = ["cycles", "outages", "seen", "routines", "posts", "ledgers", "state"];
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
  posts: {
    path: `\${{ channel }}/${DAY}/${HHMMSS}-\${{ hash }}`,
    schema: { type: "object", required: ["at", "channel", "hash"], properties: { at: AT, channel: { type: "string" }, hash: { type: "string" } } },
  },
  ledgers: {
    path: `\${{ ledger }}/${DAY}/${HHMMSS}-\${{ hash }}`,
    schema: { type: "object", required: ["at", "ledger", "hash"], properties: { at: AT, ledger: { type: "string" }, hash: { type: "string" } } },
  },
  state: {
    path: "${{ name }}",
    schema: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, at: AT, value: { type: "object" } } },
  },
};

/** A record's identity within its sheet: what its path is made of. */
export function ident(sheet: Sheet, r: Rec): string {
  const at = String(r.at ?? "");
  if (sheet === "seen") return String(r.hash ?? "");
  if (sheet === "cycles") return `${at}|${String(r.outcome ?? "")}`;
  if (sheet === "outages") return `${at}|${String(r.kind ?? "")}|${String(r.edge ?? "")}`;
  if (sheet === "posts") return `${String(r.channel ?? "")}|${at}|${String(r.hash ?? "")}`;
  if (sheet === "ledgers") return `${String(r.ledger ?? "")}|${at}|${String(r.hash ?? "")}`;
  if (sheet === "state") return String(r.name ?? "");
  return `${String(r.routine ?? "")}|${at}`;
}

// ------------------------------------------------------------------ the writer

/** The program branch `log migrate` prepares for a person to merge. */
export const MIGRATE_BRANCH = "opsbot/log-migrate";

export type Writer = { branch: string } | { notMigrated: string };

const writerCache = new Map<string, Writer>();

/**
 * Who writes this checkout's log, from the settings at HEAD (one writer at a time,
 * plans/log-branch-migrate.md): `log.branch`, else `opsbot/log`, unless the checkout is still
 * set up for the log files this release no longer writes (legacy.ts). Such a checkout is written
 * nowhere until `log migrate`'s commit is merged into it.
 */
export function logWriter(root: string): Writer {
  const hit = writerCache.get(root);
  if (hit) return hit;
  const text = showHead(root, "opsbot.json");
  const why = oldSetup(root, text);
  let branch: string | null = null;
  if (!why) {
    try {
      const v = text === null ? null : JSON.parse(text);
      if (v && typeof v.log === "object" && v.log && typeof v.log.branch === "string" && v.log.branch) branch = v.log.branch;
    } catch {
      // settings that cannot be read are refused by loadSettings, not here
    }
  }
  const w: Writer = why ? { notMigrated: why } : { branch: branch ?? DEFAULT_LOG_BRANCH };
  writerCache.set(root, w);
  return w;
}

/** The refusal for a checkout set up for the log files: what to run, and what to merge
 * when `log migrate` has already prepared it. */
export function notMigratedError(root: string, why: string): AxiError {
  const prepared = revParse(root, ref(MIGRATE_BRANCH));
  const cli = cliInvocation();
  const help = prepared
    ? [
        `\`${cli} log migrate\` prepared ${MIGRATE_BRANCH} (${prepared.slice(0, 12)}): push it and merge its pull request, then pull it into this checkout; \`${cli} log migrate --dry-run\` shows it again`,
      ]
    : [`Run \`${cli} log migrate --dry-run\`, then \`${cli} log migrate\`, and merge the pull request it prepares`];
  return new AxiError(
    `this checkout is set up for the log files (${why}); this release writes the log only to its branch, so nothing is written until the migration is merged here`,
    "CANNOT_RUN",
    help,
  );
}

/** The log branch, or the refusal of a checkout the migration has not reached (see logWriter). */
export function logBranch(root: string): string {
  const w = logWriter(root);
  if ("notMigrated" in w) throw notMigratedError(root, w.notMigrated);
  return w.branch;
}

/** For tests in one process, and after a pull moved HEAD: forget what was read. */
export function forgetLogBranch(): void {
  writerCache.clear();
  forgetReads();
}

// What this process read of the branch (its tip, its trees, its quiet runs), kept until this
// process writes: a command asks the same questions many times, and each answer was a git call.
// A write anywhere in this module (every gitsheets-axi call, a branch made or fetched) forgets
// it; a write by another process meanwhile is seen by the next command, as if this one had read
// a moment earlier. Writes themselves never use it: writeLog reads the tip fresh.
const reads = new Map<string, unknown>();

function remembered<T>(key: string, f: () => T): T {
  if (reads.has(key)) return reads.get(key) as T;
  const v = f();
  reads.set(key, v);
  return v;
}

function forgetReads(): void {
  reads.clear();
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
  forgetReads();
  const r = run(gitsheetsBin(), ["--branch", branch, ...args], { cwd: root, input, timeoutMs });
  const text = `${r.stdout}\n${r.stderr}`;
  const code = r.code === 0 ? null : (text.match(/^code:\s*(\S+)/m)?.[1] ?? (r.code === 124 ? "TIMEOUT" : "FAILED"));
  const err = text.split("\n").find((l) => l.startsWith("error:"));
  const message = (err ? err.replace(/^error:\s*/, "").replace(/^"|"$/g, "") : "") || firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
  return { code: r.code, out: r.stdout, error: code, message: message.slice(0, 300) };
}

/** The commit a gitsheets-axi write reports (`commit: <hash>`), or null when it made none. */
function committed(out: string): string | null {
  return out.match(/^commit:\s*([0-9a-f]{40})\s*$/m)?.[1] ?? null;
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
export function haveLocal(root: string, b: string): boolean {
  const key = `have\0${root}\0${b}`;
  if (reads.get(key) === true) return true;
  let have = !!revParse(root, ref(b));
  if (!have) {
    const remote = revParse(root, `refs/remotes/origin/${b}`);
    have = !!remote && git(root, ["branch", "-q", "--no-track", b, remote]).code === 0;
    forgetReads();
  }
  if (have) reads.set(key, true);
  return have;
}

/** The tip of the log branch, read with one git call; null when there is no branch yet. */
export function readTip(root: string, b: string): Tip | null {
  return readTips(root, b, 1)[0] ?? null;
}

/** The tip as it is now, never what this process read before: for a write. */
function freshTip(root: string, b: string): Tip | null {
  forgetReads();
  return readTip(root, b);
}

/** The newest `n` commits on the branch's first-parent line, newest first. One git call. */
function readTips(root: string, b: string, n: number): Tip[] {
  return remembered(`tips\0${root}\0${b}\0${n}`, () => readTipsNow(root, b, n));
}

function readTipsNow(root: string, b: string, n: number): Tip[] {
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

export type Pending = Record<Sheet, Rec[]> & {
  /** A watermark a `check --no-commit` advanced, for the next commit's trailer. */
  watermark?: string;
};

const emptyPending = (): Pending => ({ cycles: [], seen: [], outages: [], routines: [], posts: [], ledgers: [], state: [] });

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
  for (const s of SHEETS) {
    if (!add[s]?.length) continue;
    // a baseline is one record: a later set replaces the one staged before it
    if (s === "state") {
      const names = new Set(add[s]!.map((r) => ident(s, r)));
      p[s] = p[s].filter((r) => !names.has(ident(s, r)));
    }
    p[s].push(...add[s]!.map(clean));
  }
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

/** Make the branch's root: one orphan commit holding a sheet config (`cycles`, which nearly
 * every log commit writes). Every other sheet's config is added by the first commit that writes
 * the sheet, in that commit, so a new branch costs one gitsheets call, not one per sheet.
 * gitsheets refuses an additional parent on an orphan commit, so the program commit is the second
 * parent of the first log commit after the root instead. */
function initBranch(root: string, b: string): string | null {
  return initSheet(root, b, "cycles", ["--message", "log: the sheets of the loop's log"]);
}

/** Write one sheet's config to the branch with the given commit flags. Null, or why not. */
function initSheet(root: string, b: string, s: Sheet, commitArgs: string[]): string | null {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-log-init-"));
  try {
    const schema = join(dir, `${s}.json`);
    writeFileSync(schema, JSON.stringify(SHEET_CONFIGS[s].schema));
    const r = gs(root, b, ["init", s, "--path", SHEET_CONFIGS[s].path, "--schema", schema, ...commitArgs]);
    return r.code === 0 ? null : `gitsheets-axi init ${s} failed: ${r.message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The sheets whose config is on the branch tip. One git call. */
function sheetConfigs(root: string, b: string): Set<Sheet> {
  const r = git(root, ["ls-tree", "--name-only", `${ref(b)}:.gitsheets`]);
  const out = new Set<Sheet>();
  if (r.code !== 0) return out;
  for (const n of r.stdout.split("\n")) {
    const m = n.trim().match(/^(.+)\.toml$/);
    if (m && (SHEETS as string[]).includes(m[1]!)) out.add(m[1] as Sheet);
  }
  return out;
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
  /** How long each gitsheets-axi call may take (default two minutes): a migration writes more. */
  timeoutMs?: number;
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
    const tip = freshTip(root, b);
    if (!tip) return { ok: false, why: `the log branch ${b} cannot be read` };
    const head = programHead(root);
    const trailers = trailerArgs([...baseTrailers(head, w.watermark, w.check), ...sessionTrailers(session)]);
    const also = head && tip.trailers.Program !== head ? ["--also-parent", head] : [];
    const before = snapshotTrees(root, b);
    let made: string | null = null;
    const done: Sheet[] = [];
    if (todo.length === 0) {
      const r = gs(root, b, ["commit", "--allow-empty", "--message", w.subject, ...also, ...trailers], undefined, w.timeoutMs);
      if (r.code !== 0) return { ok: false, why: `gitsheets-axi commit failed: ${r.message}` };
      return { ok: true, hash: revParse(root, ref(b)) ?? "" };
    }
    // a sheet the branch has no config for yet (made before the sheet existed) gets one, in this commit
    const present = sheetConfigs(root, b);
    for (const s of todo.filter((x) => !present.has(x))) {
      const why = initSheet(root, b, s, ["--message", w.subject, ...trailers, ...(made ? ["--replace", made] : also)]);
      if (why) return { ok: false, why };
      const now = revParse(root, ref(b));
      if (now && now !== (made ?? tip.hash)) made = now;
    }
    for (const s of todo) {
      const input = w.records[s]!.map((x) => JSON.stringify(clean(x))).join("\n");
      const args = ["upsert", s, "--message", w.subject, ...trailers, ...(made ? ["--replace", made] : also)];
      const r = gs(root, b, args, `${input}\n`, w.timeoutMs);
      if (r.code !== 0) {
        if (r.error === "TIP_MISMATCH" && !retried) {
          retried = true;
          return attempt(todo.filter((x) => !done.includes(x)));
        }
        return { ok: false, why: `gitsheets-axi upsert ${s} failed: ${r.message}` };
      }
      // the commit gitsheets-axi made is in its answer; a batch that changed nothing makes none,
      // and the next sheet makes it
      const now = committed(r.out) ?? revParse(root, ref(b));
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
  const tip = freshTip(root, b);
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
  const cur = freshTip(root, b) ?? tip;
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
  const tip = freshTip(root, b);
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
type Cache = Partial<Record<Sheet, SheetCache>> & {
  /** The quiet runs up to `base`, a sealed commit of `branch` (quietRuns). */
  quiet?: { branch: string; base: string; runs: Array<Record<string, string>> };
};

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
  return remembered(`trees\0${root}\0${b}`, () => sheetTreesNow(root, b));
}

function sheetTreesNow(root: string, b: string): Partial<Record<Sheet, string>> {
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
  return sheetTreesNow(root, b);
}

/** After our own write: the cache is the records it had plus those written, under the new tree,
 * when it was current before the write; otherwise it is left for the next read to sync. */
function noteWritten(root: string, b: string, before: Partial<Record<Sheet, string>>, written: Partial<Record<Sheet, Rec[]>>): void {
  const after = sheetTreesNow(root, b);
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
  const r = queryRecords(root, b, sheet, filter ? [filter] : []);
  return "error" in r ? null : r.records;
}

/**
 * One `gitsheets-axi query` of a sheet on the branch, with gitsheets filter clauses. A clause on
 * `at` (`at>=<time>`) walks only the days from that time on: the day is the path's first bucket.
 */
export function queryRecords(root: string, b: string, sheet: Sheet, filters: string[]): { records: Rec[] } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), "opsbot-log-q-"));
  try {
    const out = join(dir, "rows.json");
    const args = ["query", sheet, "--limit", "1", `--json-out=${out}`, ...filters.flatMap((f) => ["--filter", f])];
    const r = gs(root, b, args);
    if (r.code !== 0) return { error: `gitsheets-axi query ${sheet} failed: ${r.message}` };
    if (!existsSync(out)) return { records: [] };
    const v = JSON.parse(readFileSync(out, "utf8"));
    return { records: Array.isArray(v) ? (v as Rec[]) : [] };
  } catch (e) {
    return { error: `gitsheets-axi query ${sheet} could not be read: ${(e as Error).message}` };
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

/**
 * The quiet commits on the branch's first-parent line, oldest first. The runs up to the tip's
 * first parent (sealed: never replaced) are kept in the read cache with that commit, so a later
 * read walks only the commits since, not the whole history: two git calls whatever its length.
 */
export function quietRuns(root: string, b: string): Array<Record<string, string>> {
  return remembered(`quiet\0${root}\0${b}`, () => quietRunsNow(root, b));
}

function quietRunsNow(root: string, b: string): Array<Record<string, string>> {
  if (!haveLocal(root, b)) return [];
  const c = readCache(root);
  const cached = c.quiet && c.quiet.branch === b ? c.quiet : null;
  const since = cached && git(root, ["merge-base", "--is-ancestor", cached.base, ref(b)]).code === 0 ? cached : null;
  const r = git(root, ["log", "--first-parent", "--format=%x1e%H%x1f%P%x1f%(trailers:only,unfold)", since ? `${since.base}..${ref(b)}` : ref(b)]);
  if (r.code !== 0) return [];
  const commits = r.stdout.split("\x1e").slice(1).map((block) => {
    const [hash = "", parents = "", tr = ""] = block.split("\x1f");
    const t: Record<string, string> = {};
    for (const line of tr.split("\n")) {
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m) t[m[1]!] = m[2]!.trim();
    }
    return { hash: hash.trim(), parent: parents.trim().split(/\s+/)[0] ?? "", t };
  });
  // newest first: the tip, then what is sealed below it
  const fresh = commits.filter((x) => x.t["Quiet-Cycles"]).map((x) => x.t).reverse();
  const runs = [...(since?.runs ?? []), ...fresh];
  const tip = commits[0];
  if (tip && tip.parent) {
    const below = [...(since?.runs ?? []), ...commits.slice(1).filter((x) => x.t["Quiet-Cycles"]).map((x) => x.t).reverse()];
    writeCache(root, { ...readCache(root), quiet: { branch: b, base: tip.parent, runs: below } });
  }
  return runs;
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

// within one second, the order a cycle writes its lines in: a wake at the begin, the check, the
// finish, then a sleep
const RANK: Record<string, number> = { wake: 0, "nothing-new": 1, new: 1, degraded: 1, finished: 2, sleep: 3 };
const rank = (r: Rec) => RANK[String(r.outcome)] ?? 1;
const byAtInCycle = (a: Rec, b: Rec) => byAt(a, b) || rank(a) - rank(b);

/** The cycle log as lines: records, the lines the quiet runs stand for, and staged lines. */
export function branchCycleLines(root: string, b: string): Rec[] {
  const recs = sheetRecords(root, b, "cycles");
  const quiet = quietRuns(root, b).flatMap(quietLines);
  const staged = readPending(root).cycles;
  return [...recs, ...quiet, ...staged].sort(byAtInCycle);
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
