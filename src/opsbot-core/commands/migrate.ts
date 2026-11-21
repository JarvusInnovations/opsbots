/**
 * `log migrate` (plans/log-branch-migrate.md; specs/behaviors/log-branch.md, "What it needs"): move
 * a bot's log files to the log branch and prepare the one commit that removes them.
 *
 * It reads every file the old settings listed plus the kit's own log files, the post logs and the
 * routine runs, from the working tree (lines a failed commit left uncommitted are lines too), and
 * writes them to the log branch as records in one commit after its root, each record keeping its
 * own time. A line it cannot place is a record of ledger `unparsed`, never dropped. Then it builds
 * `opsbot/log-migrate`: HEAD plus one commit that removes those files and the settings only they
 * needed, sets `log.branch`, and declares the ledgers and baselines it moved. It changes nothing on
 * the current branch or in the working tree, and prints what to push and the pull request to open.
 *
 * It stops, writing nothing, until every tracked file under `logs/` that no setting names, and
 * every data file a hook names, is assigned (`--assign <path>=…`): a ledger, a state record,
 * untracked and ignored, or (a file a hook reads that a person edits, outside `logs/`) kept.
 *
 * It refuses a bot whose cycle log shows a release older than the one before this: that release
 * is the last that writes the files, and the shapes read here are its shapes.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { setExit, usageError } from "../args.js";
import { FrontmatterError, parseRecord } from "../frontmatter.js";
import { cliInvocation } from "../invocation.js";
import {
  OLD_CYCLE_LOG,
  OLD_KIT_FILES,
  OLD_OUTAGES,
  OLD_PATHS_KEY,
  OLD_POST_LOGS,
  OLD_RUNS_DIR,
  OLD_SEEN,
  OLD_WATERMARK,
  oldSetup,
} from "../legacy.js";
import {
  DEFAULT_LOG_BRANCH,
  MIGRATE_BRANCH,
  MIN_GITSHEETS,
  SHEETS,
  clean,
  ensureBranch,
  gitsheetsVersion,
  haveLocal,
  ident,
  readTip,
  routineRecord,
  seenHash,
  sheetRecords,
  versionAtLeast,
  writeLog,
  type Rec,
  type Sheet,
} from "../log.js";
import { blockedBy, git, gitPath, iso, nowIso, parseIso, requireRoot, run, showHead, trailers } from "../repo.js";
import { LOG_NAME_RE, parseSettingsText } from "../settings.js";
import { canonical, cycleHolds, recordHash } from "./logbranch.js";

export const MIGRATE_USAGE = "log migrate [--dry-run] [--assign <path>=ledger[:<name>]|state[:<name>]|ignore|keep]...";
/** The last release that writes the log files: a bot migrates from it. */
export const PREVIOUS_RELEASE = "v0.16.0";
/** The oldest release whose files have the shapes read here (a cycle's check line says `check`). */
const OLDEST_SHAPES = "v0.15.0";
const KIT = "JarvusInnovations/opsbots";
const UNPARSED = "unparsed";
const MIGRATE_TIMEOUT_MS = 30 * 60_000;
const DATA_EXT = [".json", ".jsonl", ".ndjson", ".log", ".txt", ".csv", ".tsv"];
const CHECK_OUTCOMES = ["nothing-new", "new", "degraded"];
const PREVIEW = 20;

type Kind = "cycles" | "outages" | "seen" | "watermark" | "posts" | "ledger" | "state" | "runs" | "ignore" | "keep";

interface Source {
  path: string;
  kind: Kind | null;
  /** The ledger, state or channel name. */
  name?: string;
  /** Why the migration reads it. */
  why: string;
  tracked: boolean;
  exists: boolean;
}

interface Tally {
  path: string;
  lines: number;
  to: Record<string, number>;
}

type Json = Record<string, unknown>;

// ------------------------------------------------------------------ small helpers

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function nameFor(path: string): string {
  const stem = basename(path).replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return (stem || "ledger").slice(0, 64);
}

function trackedFiles(root: string): string[] {
  const r = git(root, ["ls-files", "-z"]);
  return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

function walkFiles(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

const norm = (p: string) => p.replace(/^\.\/+/, "").replace(/\/+$/, "");

/** An ISO time as the log keeps it (UTC, whole seconds), or null when it cannot be read. */
function utc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = parseIso(v);
  return ms === null ? null : iso(ms);
}

/** Each line's commit time (author time), from one `git blame`; now for lines not committed. */
function lineTimes(root: string, path: string, nowIsoText: string): string[] {
  const r = run("git", ["-C", root, "blame", "--line-porcelain", "--", path], { timeoutMs: MIGRATE_TIMEOUT_MS });
  if (r.code !== 0) return [];
  const out: string[] = [];
  let t = nowIsoText;
  let committed = true;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("\t")) {
      out.push(committed ? t : nowIsoText);
      continue;
    }
    const m = line.match(/^author-time (\d+)$/);
    if (m) t = iso(Number(m[1]) * 1000);
    if (/^[0-9a-f]{40} /.test(line)) committed = !/^0{40} /.test(line);
  }
  return out;
}

// ------------------------------------------------------------------ the assignments

type Assign = { kind: "ledger" | "state" | "ignore" | "keep"; name?: string };

function parseAssigns(args: string[]): { dry: boolean; assigns: Map<string, Assign> } {
  let dry = false;
  const assigns = new Map<string, Assign>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") dry = true;
    else if (a === "--assign" || a.startsWith("--assign=")) {
      const v = a === "--assign" ? args[++i] : a.slice("--assign=".length);
      if (!v) throw usageError("--assign needs <path>=ledger[:<name>]|state[:<name>]|ignore|keep", MIGRATE_USAGE);
      const eq = v.lastIndexOf("=");
      if (eq <= 0) throw usageError(`--assign ${v}: expected <path>=ledger[:<name>]|state[:<name>]|ignore|keep`, MIGRATE_USAGE);
      const path = norm(v.slice(0, eq));
      const [kind, name] = v.slice(eq + 1).split(":");
      if (kind !== "ledger" && kind !== "state" && kind !== "ignore" && kind !== "keep") {
        throw usageError(`--assign ${v}: ${kind} is not ledger, state, ignore or keep`, MIGRATE_USAGE);
      }
      if (name !== undefined && (kind === "ignore" || kind === "keep")) throw usageError(`--assign ${v}: ${kind} takes no name`, MIGRATE_USAGE);
      if (name !== undefined && !LOG_NAME_RE.test(name)) throw usageError(`--assign ${v}: ${name} is not a ${kind} name (lower-case letters, digits, - and _)`, MIGRATE_USAGE);
      assigns.set(path, { kind, ...(name ? { name } : {}) });
    } else if (a === "-h" || a === "--help") throw usageError("help", MIGRATE_USAGE);
    else if (a.startsWith("--")) throw usageError(`unknown flag ${a.split("=")[0]}`, MIGRATE_USAGE, "valid flags here: --dry-run, --assign");
    else throw usageError(`log migrate takes no argument (got ${a})`, MIGRATE_USAGE);
  }
  return { dry, assigns };
}

// ------------------------------------------------------------------ the inventory

function postLogs(raw: Json): Record<string, string> {
  const out: Record<string, string> = {};
  const streams = isObj(raw.streams) ? raw.streams : {};
  for (const [ch, def] of Object.entries(OLD_POST_LOGS)) {
    const s = streams[ch];
    out[ch] = isObj(s) && typeof s.post_log === "string" && s.post_log ? norm(s.post_log) : def;
  }
  return out;
}

function runsDir(raw: Json): string {
  const r = isObj(raw.routines) ? raw.routines : {};
  return typeof r.runs_dir === "string" && r.runs_dir ? norm(r.runs_dir) : OLD_RUNS_DIR;
}

/** Every file the migration reads, ignores or must have assigned. */
function inventory(root: string, raw: Json, assigns: Map<string, Assign>): { sources: Source[]; absent: string[]; unknownAssigns: string[] } {
  const tracked = new Set(trackedFiles(root));
  const sources: Source[] = [];
  const seen = new Set<string>();
  const absent: string[] = [];
  const add = (path: string, kind: Kind | null, why: string, name?: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const a = assigns.get(path);
    const exists = existsSync(join(root, path));
    if (a && !OLD_KIT_FILES.includes(path)) sources.push({ path, kind: a.kind, name: a.name ?? (a.kind === "ledger" || a.kind === "state" ? nameFor(path) : undefined), why, tracked: tracked.has(path), exists });
    else sources.push({ path, kind, ...(name ? { name } : {}), why, tracked: tracked.has(path), exists });
  };
  // the kit's own files
  const kitKind: Record<string, Kind> = { [OLD_CYCLE_LOG]: "cycles", [OLD_OUTAGES]: "outages", [OLD_SEEN]: "seen", [OLD_WATERMARK]: "watermark" };
  for (const f of OLD_KIT_FILES) if (tracked.has(f) || existsSync(join(root, f))) add(f, kitKind[f]!, "the kit's log");
  const posts = postLogs(raw);
  const byPath = new Map(Object.entries(posts).map(([ch, p]) => [p, ch]));
  const classify = (p: string, why: string) => {
    const ch = byPath.get(p);
    if (ch) return add(p, "posts", why, ch);
    const ext = extname(p).toLowerCase();
    if (ext === ".jsonl" || ext === ".ndjson") return add(p, "ledger", why, nameFor(p));
    if (ext === ".json") return add(p, "state", why, nameFor(p));
    return add(p, null, `${why}, but it is neither JSON lines nor one JSON object`);
  };
  // what the old setting listed (a directory: each file in it)
  const listed = Array.isArray(raw[OLD_PATHS_KEY]) ? (raw[OLD_PATHS_KEY] as unknown[]).filter((x): x is string => typeof x === "string").map(norm) : [];
  for (const entry of listed) {
    const files = [...new Set([...walkFiles(root, entry), ...[...tracked].filter((t) => t === entry || t.startsWith(`${entry}/`))])].sort();
    if (files.length === 0) absent.push(entry);
    for (const f of files) if (!OLD_KIT_FILES.includes(f)) classify(f, `listed in ${OLD_PATHS_KEY}`);
  }
  // the post logs where the post scripts wrote them
  for (const [ch, p] of Object.entries(posts)) if (tracked.has(p) || existsSync(join(root, p))) add(p, "posts", `the ${ch} post log`, ch);
  // routine runs
  const rd = runsDir(raw);
  for (const f of [...new Set([...walkFiles(root, rd), ...[...tracked].filter((t) => t.startsWith(`${rd}/`))])].sort()) {
    if (f.endsWith(".md") && basename(f) !== "README.md") add(f, "runs", "a routine run");
  }
  // tracked under logs/ and named by nothing
  for (const f of [...tracked].sort()) if (f.startsWith("logs/") && !seen.has(f)) add(f, null, "tracked under logs/, named by no setting");
  // data files a hook names: a baseline it may read from the working tree
  const hooks = [...tracked].filter((f) => f.startsWith("opsbot.d/"));
  const hookText = hooks.map((h) => {
    try {
      return [h, readFileSync(join(root, h), "utf8")] as const;
    } catch {
      return [h, ""] as const;
    }
  });
  const skip = (f: string) => f === "opsbot.json" || /^(opsbot\.d|\.claude|\.agents|\.gitsheets|skills|node_modules)\//.test(f) || f.startsWith(".git");
  for (const f of [...tracked].sort()) {
    if (seen.has(f) || skip(f) || !DATA_EXT.includes(extname(f).toLowerCase())) continue;
    const by = hookText.find(([, t]) => t.includes(f));
    if (by) add(f, null, `named by the hook ${by[0]}: a baseline it may read from the working tree`);
  }
  // an assignment must name a file found here
  const unknownAssigns = [...assigns.keys()].filter((p) => !seen.has(p));
  return { sources, absent, unknownAssigns };
}

// ------------------------------------------------------------------ the records

interface Built {
  records: Record<Sheet, Rec[]>;
  tallies: Tally[];
  unparsed: Rec[];
  watermark: string | null;
  ledgers: Set<string>;
  states: Set<string>;
  notes: string[];
}

function build(root: string, sources: Source[], branch: string, now: string): Built {
  const records = Object.fromEntries(SHEETS.map((s) => [s, [] as Rec[]])) as unknown as Record<Sheet, Rec[]>;
  const unparsed: Rec[] = [];
  const tallies: Tally[] = [];
  const ledgers = new Set<string>();
  const states = new Set<string>();
  const notes: string[] = [];
  let watermark: string | null = null;
  // what is already on the branch (a bot that opted in before) and what this run placed, by path
  const placed = new Map<string, { rec: Rec; from: string }>();
  if (haveLocal(root, branch)) {
    for (const s of SHEETS) for (const r of sheetRecords(root, branch, s)) placed.set(`${s}|${ident(s, r)}`, { rec: r, from: `${branch}` });
  }

  // an outage end carries the kind of the outage it ends
  const outageKind = new Map<string, string>();
  for (const src of sources) {
    if (src.kind !== "cycles" && src.kind !== "outages") continue;
    for (const l of readLines(root, src.path)) {
      try {
        const v = JSON.parse(l);
        if (isObj(v) && v.outcome === "outage" && typeof v.started === "string" && typeof v.kind === "string") outageKind.set(v.started, v.kind);
      } catch {
        // an unreadable line is placed below
      }
    }
  }

  for (const src of sources) {
    if (src.kind === null || src.kind === "keep" || src.kind === "ignore" || !src.exists) continue;
    const tally: Tally = { path: src.path, lines: 0, to: {} };
    tallies.push(tally);
    const count = (k: string) => (tally.to[k] = (tally.to[k] ?? 0) + 1);
    const lost = (text: string, line: number, at: string, reason: string) => {
      const body = clean({ at, file: src.path, line, text, reason });
      unparsed.push({ ...body, ledger: UNPARSED, hash: recordHash(body) });
      count(UNPARSED);
    };
    const place = (sheet: Sheet, rec: Rec, text: string, line: number, at: string) => {
      const key = `${sheet}|${ident(sheet, rec)}`;
      const had = placed.get(key);
      if (had) {
        if (canonical(had.rec) === canonical(rec)) {
          count(`${sheet} (already)`);
          return;
        }
        // said the same way on a run again, so the unparsed record is the same record
        return lost(text, line, at, `the same ${sheet} path as a different record`);
      }
      placed.set(key, { rec, from: `${src.path}:${line}` });
      records[sheet].push(rec);
      count(sheet === "ledgers" ? `ledgers/${String(rec.ledger)}` : sheet === "posts" ? `posts/${String(rec.channel)}` : sheet);
    };

    if (src.kind === "runs") {
      const text = readFileSync(join(root, src.path), "utf8");
      tally.lines = 1;
      const at0 = lineTimes(root, src.path, now)[0] ?? now;
      try {
        const { data, body } = parseRecord(text);
        const at = utc(data.at);
        if (typeof data.routine !== "string" || !LOG_NAME_RE.test(data.routine)) throw new FrontmatterError("no routine name");
        if (!at) throw new FrontmatterError("no readable at");
        const rec: Rec = clean({
          id: typeof data.id === "string" ? data.id : basename(src.path, ".md"),
          routine: data.routine,
          at,
          outcome: typeof data.outcome === "string" ? data.outcome : "done",
          by: typeof data.by === "string" ? data.by : undefined,
          checked: Array.isArray(data.checked) ? data.checked.map(String) : [],
          title: typeof data.title === "string" ? data.title : undefined,
          notes: body.replace(/^#\s+[^\n]*\n*/, "").trim(),
          handed_to: typeof data.handed_to === "string" ? data.handed_to : undefined,
        });
        place("routines", routineRecord(rec), text, 1, at);
      } catch (e) {
        lost(text, 1, at0, `not a routine run: ${(e as Error).message}`);
      }
      continue;
    }

    if (src.kind === "state") {
      const text = readFileSync(join(root, src.path), "utf8");
      tally.lines = 1;
      const times = lineTimes(root, src.path, now).sort();
      const at = times[times.length - 1] ?? now;
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch (e) {
        lost(text, 1, at, `not one JSON value: ${(e as Error).message}`);
        continue;
      }
      const value = isObj(v) ? clean(v) : { value: clean(v) };
      if (!isObj(v)) notes.push(`${src.path} holds a JSON ${Array.isArray(v) ? "array" : typeof v}, not an object: state ${src.name} keeps it under value.value`);
      states.add(src.name!);
      place("state", { name: src.name!, at, value }, text, 1, at);
      continue;
    }

    const lines = readLines(root, src.path, true);
    const times = lineTimes(root, src.path, now);
    lines.forEach((text, i) => {
      if (!text.trim()) return;
      tally.lines++;
      const n = i + 1;
      const lineAt = times[i] ?? now;
      if (src.kind === "seen") {
        place("seen", { at: lineAt, hash: seenHash(text), key: text }, text, n, lineAt);
        return;
      }
      if (src.kind === "watermark") {
        const w = utc(text.trim());
        if (w && n === 1) {
          watermark = w;
          count("watermark trailer");
        } else lost(text, n, lineAt, "not one ISO-8601 time on the first line");
        return;
      }
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch (e) {
        return lost(text, n, lineAt, `not JSON: ${(e as Error).message}`);
      }
      if (!isObj(v)) return lost(text, n, lineAt, "not a JSON object");
      const own = v.at === undefined ? null : utc(v.at);
      if (v.at !== undefined && own === null) return lost(text, n, lineAt, "its at is not a time");
      const at = own ?? lineAt;
      // a time written otherwise than UTC whole seconds is kept as written beside the one the path uses
      const body: Rec = clean({ ...v, at, ...(typeof v.at === "string" && v.at !== at ? { at_as_written: v.at } : {}) });
      if (src.kind === "cycles" || src.kind === "outages") {
        const outcome = typeof v.outcome === "string" ? v.outcome : "";
        if (!own) return lost(text, n, lineAt, "no at");
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(outcome)) return lost(text, n, lineAt, outcome ? `outcome ${outcome} cannot name a record` : "no outcome");
        if (outcome === "outage" || outcome === "outage-end") {
          const end = outcome === "outage-end";
          const kind = end ? (outageKind.get(String(v.started)) ?? "outage") : String(v.kind ?? "outage");
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(kind)) return lost(text, n, lineAt, `outage kind ${kind} cannot name a record`);
          return place("outages", { ...body, kind, edge: end ? "end" : "start" }, text, n, at);
        }
        if (src.kind === "outages") return lost(text, n, lineAt, `outcome ${outcome} in the outages file`);
        return place("cycles", body, text, n, at);
      }
      if (src.kind === "posts") {
        for (const f of ["channel", "hash"]) if (v[f] !== undefined) return lost(text, n, lineAt, `it has a ${f} field, which the post log sets itself`);
        return place("posts", { ...body, channel: src.name!, hash: recordHash(body) }, text, n, at);
      }
      // a ledger
      for (const f of ["ledger", "hash"]) if (v[f] !== undefined) return lost(text, n, lineAt, `it has a ${f} field, which the log sets itself`);
      ledgers.add(src.name!);
      return place("ledgers", { ...body, ledger: src.name!, hash: recordHash(body) }, text, n, at);
    });
  }
  records.ledgers.push(...unparsed);
  return { records, tallies, unparsed, watermark, ledgers, states, notes };
}

function readLines(root: string, path: string, keepEmpty = false): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return keepEmpty ? lines : lines.filter((l) => l.trim());
}

// ------------------------------------------------------------------ the release

/** Why the cycle log shows a release older than the shapes read here, or null. */
function releaseProblem(root: string): string | null {
  const checks: Json[] = [];
  for (const l of readLines(root, OLD_CYCLE_LOG)) {
    try {
      const v = JSON.parse(l);
      if (isObj(v) && CHECK_OUTCOMES.includes(String(v.outcome))) checks.push(v);
    } catch {
      // placed as unparsed later
    }
  }
  const recent = checks.slice(-PREVIEW);
  if (recent.length === 0 || recent.some((l) => typeof l.check === "string")) return null;
  return `none of the newest ${recent.length} check lines in ${OLD_CYCLE_LOG} says which check it was (the \`check\` field every release since ${OLDEST_SHAPES} writes on a cycle's check), so this bot last ran an older release`;
}

// ------------------------------------------------------------------ the prepared commit

function newSettings(raw: Json, branch: string, ledgers: Set<string>, states: Set<string>): { json: Json; changes: string[] } {
  const json: Json = JSON.parse(JSON.stringify(raw));
  const changes: string[] = [];
  if (json[OLD_PATHS_KEY] !== undefined) {
    delete json[OLD_PATHS_KEY];
    changes.push(`${OLD_PATHS_KEY} removed`);
  }
  if (isObj(json.routines) && json.routines.runs_dir !== undefined) {
    delete json.routines.runs_dir;
    if (Object.keys(json.routines).filter((k) => k !== "//").length === 0) delete json.routines;
    changes.push("routines.runs_dir removed");
  }
  if (json.repo_sync === "pull-on-clean" || json.repo_sync === "never-pull") {
    const to = json.repo_sync === "never-pull" ? "never" : "pull";
    changes.push(`repo_sync ${JSON.stringify(json.repo_sync)} is now ${JSON.stringify(to)}${to === "never" ? " (cycle begin then leaves the checkout alone; remove it to have each cycle fast-forward the checkout, which replaces a repo-sync hook)" : ""}`);
    json.repo_sync = to;
  }
  const log: Json = isObj(json.log) ? json.log : {};
  if (log.branch !== branch) changes.push(`log.branch set to ${JSON.stringify(branch)}`);
  log.branch = branch;
  for (const [k, names] of [["ledgers", ledgers], ["state", states]] as const) {
    const cur: Json = isObj(log[k]) ? log[k] : {};
    const added = [...names].filter((n) => cur[n] === undefined).sort();
    for (const n of added) cur[n] = [];
    if (added.length) {
      log[k] = cur;
      changes.push(`log.${k} declares ${added.join(", ")} (no required fields yet: add the fields each record must carry)`);
    }
  }
  json.log = log;
  return { json, changes };
}

function gitEnv(root: string, args: string[], env: Record<string, string>, input?: string) {
  return run("git", ["-C", root, ...args], { env: { ...process.env, ...env }, input });
}

/** HEAD plus one commit removing `remove`, untracking and ignoring `ignore`, with the new
 * settings, on MIGRATE_BRANCH. The working tree, the index and the current branch are untouched. */
function prepare(root: string, o: { remove: string[]; untrack: string[]; ignore: string[]; settings: Json; message: string }): string {
  const index = gitPath(root, "opsbot-migrate-index");
  const env = { GIT_INDEX_FILE: index };
  const fail = (what: string, r: { stderr: string; stdout: string; code: number }): never => {
    throw new AxiError(`cannot prepare ${MIGRATE_BRANCH}: ${what} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? `exit ${r.code}`}`, "CANNOT_RUN");
  };
  try {
    let r = gitEnv(root, ["read-tree", "HEAD"], env);
    if (r.code !== 0) fail("git read-tree", r);
    const gone = [...o.remove, ...o.untrack];
    if (gone.length) {
      r = gitEnv(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...gone], env);
      if (r.code !== 0) fail("git rm --cached", r);
    }
    const blob = (text: string) => {
      const h = gitEnv(root, ["hash-object", "-w", "--stdin"], env, text);
      if (h.code !== 0) fail("git hash-object", h);
      return h.stdout.trim();
    };
    r = gitEnv(root, ["update-index", "--add", "--cacheinfo", `100644,${blob(`${JSON.stringify(o.settings, null, 2)}\n`)},opsbot.json`], env);
    if (r.code !== 0) fail("git update-index opsbot.json", r);
    // .gitignore: no line for a removed file is left, and each ignored file gets one
    const was = showHead(root, ".gitignore");
    const named = new Set([...gone, ...o.ignore].flatMap((p) => [p, `/${p}`, `!${p}`, `!/${p}`]));
    const kept = (was ?? "").split("\n").filter((l) => !named.has(l.trim()));
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    const add = o.ignore.map((p) => `/${p}`);
    const next = [...kept, ...(add.length ? ["# untracked by opsbot-core log migrate: written by the bot, read by no person", ...add] : [])].join("\n");
    if (was !== null || add.length) {
      r = gitEnv(root, ["update-index", "--add", "--cacheinfo", `100644,${blob(next ? `${next}\n` : "")},.gitignore`], env);
      if (r.code !== 0) fail("git update-index .gitignore", r);
    }
    const tree = gitEnv(root, ["write-tree"], env);
    if (tree.code !== 0) fail("git write-tree", tree);
    const commit = gitEnv(root, ["commit-tree", tree.stdout.trim(), "-p", "HEAD", "-F", "-"], {}, o.message);
    if (commit.code !== 0) fail("git commit-tree", commit);
    const hash = commit.stdout.trim();
    r = gitEnv(root, ["update-ref", `refs/heads/${MIGRATE_BRANCH}`, hash], {});
    if (r.code !== 0) fail("git update-ref", r);
    return hash;
  } finally {
    rmSync(index, { force: true });
  }
}

// ------------------------------------------------------------------ the command

/** The remote's log branch, when it has one (a bot that opted in before), so what is there is
 * read and never overwritten. Read only: nothing is made here. */
function fetchLog(root: string, branch: string): void {
  if (git(root, ["remote", "get-url", "origin"]).code !== 0) return;
  run("git", ["-C", root, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: 60_000 });
}

export function logMigrate(args: string[]): Record<string, unknown> {
  const { dry, assigns } = parseAssigns(args);
  const root = requireRoot();
  const cli = cliInvocation();
  const why = oldSetup(root);
  if (!why) {
    return { migrate: "nothing to migrate · this checkout has none of the old log files' settings; the log is written to its branch" };
  }
  const headText = showHead(root, "opsbot.json");
  if (headText === null) throw new AxiError("opsbot.json is not committed in this checkout", "CANNOT_RUN");
  const wt = existsSync(join(root, "opsbot.json")) ? readFileSync(join(root, "opsbot.json"), "utf8") : null;
  if (wt !== headText) {
    throw new AxiError("opsbot.json has changes that are not committed; the prepared commit is made from the one at HEAD", "CANNOT_RUN", ["Commit or discard the change to opsbot.json, then run log migrate again"]);
  }
  let raw: Json;
  try {
    raw = JSON.parse(headText) as Json;
  } catch (e) {
    throw new AxiError(`opsbot.json is not JSON: ${(e as Error).message}`, "CANNOT_RUN");
  }
  const blocked = blockedBy(root);
  if (blocked) throw new AxiError(`cannot migrate: ${blocked}`, "CANNOT_RUN", ["Finish it, then run log migrate again"]);
  if (cycleHolds(root, typeof raw.lock_max_minutes === "number" ? raw.lock_max_minutes : 60)) {
    throw new AxiError("a cycle holds the checkout, so the log files may still be written to", "CANNOT_RUN", [
      "Stop the bot's loop (the release before this one still writes the files), then run log migrate again",
    ]);
  }
  // a bot several releases behind updates to the release before this one first
  const behind = releaseProblem(root);
  if (behind) {
    throw new AxiError(`cannot migrate from this bot's release: ${behind}`, "CANNOT_RUN", [
      `Update the kit to ${PREVIOUS_RELEASE} first (\`npx skills add ${KIT}#${PREVIOUS_RELEASE}\`), let the loop run one full cycle on it, then update to this release and run \`${cli} log migrate --dry-run\` again`,
    ]);
  }

  const branch = isObj(raw.log) && typeof raw.log.branch === "string" && raw.log.branch ? raw.log.branch : DEFAULT_LOG_BRANCH;
  const { sources, absent, unknownAssigns } = inventory(root, raw, assigns);
  if (unknownAssigns.length) {
    throw usageError(`--assign names ${unknownAssigns.join(", ")}, which the migration does not read: only a file it lists may be assigned`, MIGRATE_USAGE);
  }
  // keep is for a file a hook names outside logs/, nothing the log wrote
  const badKeep = sources.filter((s) => s.kind === "keep" && (s.path.startsWith("logs/") || !s.why.startsWith("named by the hook")));
  if (badKeep.length) {
    throw usageError(`keep is only for a file a hook names outside logs/ that a person edits: ${badKeep.map((s) => s.path).join(", ")}`, MIGRATE_USAGE);
  }
  const unassigned = sources.filter((s) => s.kind === null);
  const now = nowIso();
  fetchLog(root, branch);
  const built = build(root, sources, branch, now);
  const { json: settings, changes } = newSettings(raw, branch, built.ledgers, built.states);
  const problems = parseSettingsText(JSON.stringify(settings), "the migrated opsbot.json").problems;

  const totals: Record<string, number> = {};
  for (const s of SHEETS) {
    if (s === "ledgers") {
      for (const r of built.records.ledgers) totals[`ledgers/${String(r.ledger)}`] = (totals[`ledgers/${String(r.ledger)}`] ?? 0) + 1;
    } else if (s === "posts") {
      for (const r of built.records.posts) totals[`posts/${String(r.channel)}`] = (totals[`posts/${String(r.channel)}`] ?? 0) + 1;
    } else if (built.records[s].length) totals[s] = built.records[s].length;
  }
  const out: Record<string, unknown> = {};
  const files = built.tallies.map((t) => ({
    file: t.path,
    lines: t.lines,
    to: Object.entries(t.to).map(([k, n]) => `${k} ${n}`).join(", ") || "nothing",
  }));
  const lineCount = built.tallies.reduce((n, t) => n + t.lines, 0);
  const ignored = sources.filter((s) => s.kind === "ignore");
  const keptFiles = sources.filter((s) => s.kind === "keep");

  if (unassigned.length || problems.length) {
    setExit(1);
    out.migrate = `${dry ? "dry run · " : ""}stopped · nothing written${unassigned.length ? ` · ${unassigned.length} file${unassigned.length === 1 ? "" : "s"} to assign` : ""}${problems.length ? ` · ${problems.length} settings problem${problems.length === 1 ? "" : "s"}` : ""}`;
    if (unassigned.length) {
      out.unassigned = unassigned.map((s) => ({ file: s.path, why: s.why }));
    }
    if (problems.length) out.problems = problems;
    out.files = files;
    out.help = [
      ...(unassigned.length
        ? [
            "Assign each file above and run it again, one --assign per file:",
            ...unassigned.map((s) => `  --assign ${s.path}=${extname(s.path) === ".json" ? "state" : extname(s.path) === ".jsonl" ? "ledger" : "ignore"}`),
            "  ledger[:<name>]: each line a record of that ledger · state[:<name>]: the file one baseline · ignore: untracked and ignored, its lines not moved · keep: a file outside logs/ a person edits, left as it is",
          ]
        : []),
      ...(problems.length ? ["Fix the settings problems in opsbot.json (they are not the migration's), commit, then run it again"] : []),
    ];
    return out;
  }

  const sheetLine = Object.entries(totals).map(([k, n]) => `${k} ${n}`).join(", ") || "no records";
  const removeTracked = sources.filter((s) => s.tracked && s.kind !== "ignore" && s.kind !== "keep").map((s) => s.path);
  const untrackedLeft = sources.filter((s) => !s.tracked && s.exists && s.kind !== "ignore" && s.kind !== "keep").map((s) => s.path);

  if (dry) {
    out.migrate = `dry run · ${lineCount} lines from ${built.tallies.length} files would go to ${branch}: ${sheetLine}${built.watermark ? ` · watermark ${built.watermark}` : ""}`;
    out.files = files;
    if (built.unparsed.length) out.unparsed = built.unparsed.slice(0, PREVIEW).map((u) => `${String(u.file)}:${String(u.line)} · ${String(u.reason)}`);
    if (ignored.length) out.ignored = ignored.map((s) => s.path);
    if (keptFiles.length) out.kept = keptFiles.map((s) => s.path);
    if (absent.length) out.absent = absent.map((p) => `${p}: listed, not there; nothing to move`);
    out.settings = changes;
    if (built.notes.length) out.notes = built.notes;
    out.help = [`Run \`${cli} log migrate${[...assigns].map(([p, a]) => ` --assign ${p}=${a.kind}${a.name ? `:${a.name}` : ""}`).join("")}\` to write them and prepare ${MIGRATE_BRANCH}`];
    return out;
  }

  const v = gitsheetsVersion();
  if (v === null || !versionAtLeast(v, MIN_GITSHEETS)) {
    throw new AxiError(`the log branch needs gitsheets-axi ${MIN_GITSHEETS} or later (${v ? `found ${v}` : "it does not run here"})`, "CANNOT_RUN", ["`opsbot-host bootstrap` installs it"]);
  }
  const ensured = ensureBranch(root, branch);
  if (ensured) throw new AxiError(`cannot make the log branch ${branch}: ${ensured}`, "CANNOT_RUN");
  const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const records: Partial<Record<Sheet, Rec[]>> = {};
  for (const s of SHEETS) if (built.records[s].length) records[s] = built.records[s];
  // a run again finds its records already there: nothing new, no commit
  const w = Object.keys(records).length === 0 ? { ok: true as const, hash: readTip(root, branch)?.hash ?? "" } : writeLog(
    root,
    branch,
    { records, subject: `log: migrated from the log files at ${head.slice(0, 12)}`, watermark: built.watermark, check: "full", timeoutMs: MIGRATE_TIMEOUT_MS },
    [`Migrated-From: ${head}`, trailers()].filter(Boolean).join("\n"),
  );
  if (!w.ok) throw new AxiError(`cannot write the log branch ${branch}: ${w.why}; nothing was prepared`, "WRITE_FAILED", ["Fix it and run log migrate again: what was written is written once"]);
  const logTip = readTip(root, branch)?.hash ?? w.hash;

  // a copy of each file left out of the log, in case the pull removes what someone wanted
  const backup = gitPath(root, "opsbot-migrate");
  for (const s of ignored) {
    if (!s.exists) continue;
    const dst = join(backup, s.path);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(root, s.path), dst);
  }

  const cur = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim() || "main";
  const body = [
    `The loop's log moves to the branch ${branch} (${logTip.slice(0, 12)}), and this commit removes the files it was kept in.`,
    "",
    `- On ${branch}: ${lineCount} lines from ${built.tallies.length} files: ${sheetLine}${built.watermark ? `; watermark ${built.watermark}` : ""}.`,
    ...(built.unparsed.length ? [`- ${built.unparsed.length} lines could not be placed and are kept as ledger ${UNPARSED} records (\`${cli} log read ledgers/${UNPARSED}\`).`] : []),
    `- Removed: ${removeTracked.length ? removeTracked.join(", ") : "nothing tracked"}.`,
    ...(ignored.length ? [`- Untracked and ignored: ${ignored.map((s) => s.path).join(", ")}.`] : []),
    `- opsbot.json: ${changes.join("; ")}.`,
    "",
    `Until this is merged and pulled into the bot's checkout, the loop refuses to run: nothing is written to both places.`,
    "",
    `Prepared by \`opsbot-core log migrate\`.`,
  ].join("\n");
  const message = `chore(bot): the loop's log moves to ${branch}\n\n${body}\n`;
  const prepared = prepare(root, { remove: removeTracked, untrack: ignored.filter((s) => s.tracked).map((s) => s.path), ignore: ignored.map((s) => s.path), settings, message });
  const prBody = gitPath(root, "opsbot-log-migrate.md");
  writeFileSync(prBody, `${body}\n`);

  const discard = [...removeTracked, ...ignored.filter((s) => s.tracked).map((s) => s.path)];
  out.migrate = `done · ${lineCount} lines from ${built.tallies.length} files on ${branch} at ${logTip.slice(0, 12)}: ${sheetLine} · prepared ${MIGRATE_BRANCH} at ${prepared.slice(0, 12)} · nothing changed on ${cur}`;
  out.files = files;
  if (built.unparsed.length) out.unparsed = built.unparsed.slice(0, PREVIEW).map((u) => `${String(u.file)}:${String(u.line)} · ${String(u.reason)}`);
  out.settings = changes;
  if (built.notes.length) out.notes = built.notes;
  out.next = [
    `1. Push both branches: git push origin ${branch} ${MIGRATE_BRANCH}`,
    `2. Open the pull request and merge it: gh pr create --base ${cur} --head ${MIGRATE_BRANCH} --title "chore(bot): the loop's log moves to ${branch}" --body-file ${prBody}`,
    `3. Then, in this checkout: git checkout HEAD -- ${discard.length ? discard.join(" ") : "."} && git pull --ff-only   (the files' lines are on ${branch}; the pull removes the files)`,
    ...(untrackedLeft.length ? [`4. Delete the untracked files whose lines moved: rm ${untrackedLeft.join(" ")}`] : []),
    `${untrackedLeft.length ? 5 : 4}. Start the loop again: \`${cli} cycle begin\` writes to ${branch} from here on. Until step 3 it refuses to run.`,
    ...(built.ledgers.size || built.states.size
      ? [`${untrackedLeft.length ? 6 : 5}. Change the hooks that wrote ${[...built.ledgers].map((n) => `ledger ${n}`).concat([...built.states].map((n) => `state ${n}`)).join(", ")} to \`${cli} log append <ledger>\` and \`${cli} log state set <name>\`, and delete any repo-sync hook of the bot's own: cycle begin fast-forwards the checkout itself`]
      : [`${untrackedLeft.length ? 6 : 5}. Delete any repo-sync hook of the bot's own: cycle begin fast-forwards the checkout itself`]),
  ];
  if (ignored.length) out.ignored = ignored.map((s) => `${s.path}: untracked and ignored by ${MIGRATE_BRANCH}; the pull removes it from this checkout, a copy is at ${join(backup, s.path)}`);
  return out;
}
