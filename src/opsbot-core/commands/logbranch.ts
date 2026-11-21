/**
 * The log branch's commands for scripts (specs/behaviors/log-branch.md, "Scripts never touch the
 * branch themselves"): `log append`, `log state get|set`, `log read`, `log seen`. Every write goes
 * through log.ts. A write made while a cycle holds the checkout is staged and rides that cycle's
 * one commit; a write made outside a cycle (a person running a script by hand) is its own commit.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit, usageError } from "../args.js";
import { keySeen } from "../backstop.js";
import { cliInvocation } from "../invocation.js";
import {
  clean,
  commitStaged,
  haveLocal,
  logBranch,
  queryRecords,
  recordHash,
  canonical,
  quietLines,
  quietRuns,
  readPending,
  sheetRecords,
  stage,
  DEFAULT_LOG_BRANCH,
  type Rec,
  type Sheet,
} from "../log.js";
import { git, gitPath, nowIso, nowMs, parseIso, requireRoot, run, trailers } from "../repo.js";
import { LEDGER_RESERVED, LOG_NAME_RE, loadSettings, type Settings } from "../settings.js";
import { pidAlive, readLock } from "../state.js";

export const APPEND_USAGE = "log append <ledger> | log append posts/<channel>   (JSON on stdin: one object, an array, or one per line)";
export const STATE_USAGE = "log state get <name> [--json-out <path>] | log state set <name>   (a JSON object on stdin)";
export const READ_USAGE = "log read <sheet> [--since <ISO time>] [--filter <clause>]... [--repo <path or remote>] [--branch <name>] [--json-out <path>]";
export const SEEN_USAGE = "log seen <key>";
const MIGRATE_USAGE_TEXT = "log migrate [--dry-run] [--assign <path>=ledger[:<name>]|state[:<name>]|ignore|keep]...";

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FETCH_TIMEOUT_MS = 60_000;
const PREVIEW = 20;

// ------------------------------------------------------------------ shared

function needBranch(root: string, _what: string): string {
  return logBranch(root);
}

/**
 * Whether a cycle holds the checkout now: the cycle lock is there, its process is not known to be
 * gone, and it is younger than lock_max_minutes. The session rule of `judgeLock` (a hold of this
 * same session is abandoned) does not apply: a script the cycle runs is in that session.
 */
export function cycleHolds(root: string, maxMinutes: number): boolean {
  const { hold } = readLock(root);
  if (!hold) return false;
  if (hold.pid && pidAlive(hold.pid) === "no") return false;
  const started = parseIso(hold.started);
  if (started === null) return false;
  return nowMs() - started < maxMinutes * 60_000;
}

/** Stage inside a cycle, else commit now. What the caller prints. */
function write(root: string, b: string, settings: Settings, records: Partial<Record<Sheet, Rec[]>>, subject: string): string {
  if (cycleHolds(root, settings.lock_max_minutes)) {
    stage(root, records);
    return "staged: rides this cycle's commit";
  }
  const r = commitStaged(root, b, records, { subject }, trailers());
  if (!r.ok) throw new AxiError(`cannot write the log: ${r.why}`, "WRITE_FAILED", ["Nothing was written; run it again once the log branch can be written"]);
  return `committed ${r.hash.slice(0, 12)} on ${b}`;
}

function readStdinRecords(what: string, usage: string): Rec[] {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  const t = text.trim();
  if (!t) throw usageError(`no ${what} on stdin`, usage);
  let vals: unknown[];
  try {
    const v = JSON.parse(t);
    vals = Array.isArray(v) ? v : [v];
  } catch {
    try {
      vals = t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      throw usageError(`the ${what} on stdin is not JSON (one object, an array of objects, or one object per line)`, usage);
    }
  }
  if (vals.length === 0) throw usageError(`no ${what} on stdin`, usage);
  vals.forEach((v, i) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw usageError(`${what} ${i + 1} is not a JSON object`, usage);
  });
  return vals as Rec[];
}

/** A record's time: its own `at` (an ISO time in UTC), or now. */
function recordAt(r: Rec, i: number, usage: string): string {
  if (r.at === undefined || r.at === null) return nowIso();
  if (typeof r.at !== "string" || !UTC_RE.test(r.at) || parseIso(r.at) === null) {
    throw usageError(`record ${i + 1}: at must be an ISO time in UTC such as 2026-03-02T15:04:05Z (got ${JSON.stringify(r.at)})`, usage);
  }
  return r.at;
}

export { canonical, recordHash };

function missingFields(r: Rec, fields: string[]): string[] {
  return fields.filter((f) => r[f] === undefined || r[f] === null);
}

// ------------------------------------------------------------------ log append

export function logAppend(args: string[]): Record<string, unknown> {
  const { positionals } = parseArgs(args, { maxPositionals: 1 }, APPEND_USAGE);
  const target = positionals[0];
  if (!target) throw usageError("log append needs a ledger name, or posts/<channel>", APPEND_USAGE);
  const root = requireRoot();
  const { settings } = loadSettings(root);
  const b = needBranch(root, "log append");
  const post = target.match(/^posts\/(.+)$/);
  const name = post ? post[1]! : target.replace(/^ledgers\//, "");
  if (!LOG_NAME_RE.test(name)) throw usageError(`${JSON.stringify(name)} is not a ${post ? "channel" : "ledger"} name (lower-case letters, digits, - and _)`, APPEND_USAGE);
  const declared = post ? [] : settings.log.ledgers[name];
  if (!declared) {
    const known = Object.keys(settings.log.ledgers);
    throw new AxiError(`no ledger ${name} in log.ledgers`, "VALIDATION_ERROR", [
      known.length ? `Declared ledgers: ${known.join(", ")}` : "Declare it in opsbot.json: \"log\": {\"ledgers\": {\"" + name + "\": [\"<field>\", ...]}}",
    ]);
  }
  const key = post ? "channel" : "ledger";
  const input = readStdinRecords("record", APPEND_USAGE);
  const records = input.map((r, i) => {
    for (const f of post ? ["channel", "hash"] : LEDGER_RESERVED) {
      if (r[f] !== undefined) throw usageError(`record ${i + 1}: ${f} is set by the log itself; name the field otherwise`, APPEND_USAGE);
    }
    const miss = missingFields(r, declared);
    if (miss.length) throw usageError(`record ${i + 1} has no ${miss.join(", ")}: ledger ${name} requires ${declared.join(", ")}`, APPEND_USAGE);
    const at = recordAt(r, i, APPEND_USAGE);
    const body = clean({ ...r, at });
    return { ...body, [key]: name, hash: recordHash(body) };
  });
  const sheet: Sheet = post ? "posts" : "ledgers";
  const said = write(root, b, settings, { [sheet]: records }, `log: ${records.length} ${post ? `post${records.length === 1 ? "" : "s"} to ${name}` : `${name} record${records.length === 1 ? "" : "s"}`}`);
  return { appended: `${records.length} to ${sheet}/${name} · ${said}` };
}

// ------------------------------------------------------------------ log state

function currentState(root: string, b: string, name: string): Rec | null {
  const staged = readPending(root).state.filter((r) => r.name === name).pop();
  if (staged) return staged;
  return sheetRecords(root, b, "state").find((r) => r.name === name) ?? null;
}

export function logState(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "get" && sub !== "set") throw usageError(sub ? `unknown log state subcommand ${sub}` : "log state needs get or set", STATE_USAGE);
  const { positionals, flags } = parseArgs(rest, { value: sub === "get" ? ["json-out"] : [], maxPositionals: 1 }, STATE_USAGE);
  const name = positionals[0];
  if (!name) throw usageError(`log state ${sub} needs a name`, STATE_USAGE);
  if (!LOG_NAME_RE.test(name)) throw usageError(`${JSON.stringify(name)} is not a state name (lower-case letters, digits, - and _)`, STATE_USAGE);
  const root = requireRoot();
  const { settings } = loadSettings(root);
  const b = needBranch(root, `log state ${sub}`);
  if (sub === "get") {
    const cur = currentState(root, b, name);
    if (typeof flags["json-out"] === "string") writeJsonOut(flags["json-out"], cur ? (cur.value ?? null) : null);
    if (!cur) return { state: `${name} · not set` };
    return { state: name, at: cur.at ?? "", value: cur.value ?? {} };
  }
  const declared = settings.log.state[name];
  if (!declared) {
    const known = Object.keys(settings.log.state);
    throw new AxiError(`no state ${name} in log.state`, "VALIDATION_ERROR", [
      known.length ? `Declared state: ${known.join(", ")}` : "Declare it in opsbot.json: \"log\": {\"state\": {\"" + name + "\": [\"<field>\", ...]}}",
    ]);
  }
  const vals = readStdinRecords("value", STATE_USAGE);
  if (vals.length !== 1) throw usageError("log state set takes one JSON object", STATE_USAGE);
  const value = clean(vals[0]!);
  const miss = missingFields(value, declared);
  if (miss.length) throw usageError(`the value has no ${miss.join(", ")}: state ${name} requires ${declared.join(", ")}`, STATE_USAGE);
  const cur = currentState(root, b, name);
  // an unchanged baseline writes nothing, so a quiet cycle stays quiet
  if (cur && canonical(cur.value ?? {}) === canonical(value)) return { state: `${name} · unchanged` };
  const said = write(root, b, settings, { state: [{ name, at: nowIso(), value }] }, `log: state ${name}`);
  return { state: `${name} · set · ${said}` };
}

// ------------------------------------------------------------------ log read

/** One gitsheets filter clause applied to a record in hand (the staged ones gitsheets cannot see). */
export function clauseMatches(r: Rec, clause: string): boolean {
  let m = clause.match(/^\s*([^\s:=<>!~]+)\s+in\s+\((.*)\)\s*$/);
  if (m) return m[2]!.split(",").map((x) => x.trim()).includes(scalar(r[m[1]!]));
  m = clause.match(/^([^:=<>!~]+):(present|empty)$/);
  if (m) {
    const v = r[m[1]!];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    return m[2] === "present" ? !empty : empty;
  }
  m = clause.match(/^([^:=<>!~]+)(!=|<=|>=|=|<|>|~)(.*)$/);
  if (!m) return false;
  const [, k, op, want] = m;
  const v = r[k!];
  if (op === "~") {
    try {
      return new RegExp(want!).test(scalar(v));
    } catch {
      return false;
    }
  }
  const have = scalar(v);
  if (op === "=") return v !== undefined && have === want;
  if (op === "!=") return have !== want;
  if (v === undefined || v === null) return false;
  const a = Number(have);
  const c = Number(want);
  const cmp = Number.isFinite(a) && Number.isFinite(c) && have.trim() !== "" && want!.trim() !== "" ? a - c : have < want! ? -1 : have > want! ? 1 : 0;
  return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
}

function scalar(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function writeJsonOut(path: string, v: unknown): void {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  writeFileSync(abs, `${JSON.stringify(v)}\n`);
}

/** The sheet a `log read` name means, and the clause that picks its records within it. */
function parseSheet(name: string): { sheet: Sheet; key?: string; value?: string } {
  if (name === "cycles" || name === "seen" || name === "outages" || name === "routines" || name === "posts" || name === "ledgers") return { sheet: name };
  const m = name.match(/^(posts|ledgers)\/(.+)$/);
  if (m && LOG_NAME_RE.test(m[2]!)) return { sheet: m[1] as Sheet, key: m[1] === "posts" ? "channel" : "ledger", value: m[2]! };
  if (name === "state" || name.startsWith("state/")) {
    throw usageError("a baseline is read with log state get <name>", READ_USAGE);
  }
  throw usageError(`unknown sheet ${name}`, READ_USAGE, "sheets: cycles, seen, outages, routines, posts/<channel>, ledgers/<name>");
}

/**
 * Fetch another repo's log branch into a private bare repository under this repo's git directory
 * (never a branch of this checkout) and return its path.
 */
function fetchPeer(root: string, source: string, branch: string): string {
  const src = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/]+@[^:]+:/.test(source) ? source : resolve(process.cwd(), source);
  const id = createHash("sha256").update(src).digest("hex").slice(0, 16);
  const dir = gitPath(root, join("opsbot-peers", `${id}.git`));
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    const init = run("git", ["init", "-q", "--bare", dir], { timeoutMs: FETCH_TIMEOUT_MS });
    if (init.code !== 0) throw new AxiError(`cannot make a place for ${source}'s log: ${init.stderr.trim().split("\n")[0] ?? ""}`, "CANNOT_RUN");
  }
  const f = run("git", ["-C", dir, "fetch", "-q", "--no-tags", src, `+refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: FETCH_TIMEOUT_MS });
  if (f.code !== 0) {
    throw new AxiError(`cannot fetch ${branch} from ${source}: ${(f.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`, "FETCH_FAILED", [
      `Check that ${source} has a branch ${branch} (--branch names another)`,
    ]);
  }
  return dir;
}

const byAt = (a: Rec, b: Rec) => (String(a.at ?? "") < String(b.at ?? "") ? -1 : String(a.at ?? "") > String(b.at ?? "") ? 1 : 0);

export function logRead(args: string[]): Record<string, unknown> {
  // --filter repeats
  const filters: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--filter") {
      const v = args[++i];
      if (v === undefined) throw usageError("--filter needs a clause", READ_USAGE);
      filters.push(v);
    } else if (a.startsWith("--filter=")) filters.push(a.slice("--filter=".length));
    else rest.push(a);
  }
  const { positionals, flags } = parseArgs(rest, { value: ["since", "repo", "branch", "json-out"], maxPositionals: 1 }, READ_USAGE);
  const name = positionals[0];
  if (!name) throw usageError("log read needs a sheet", READ_USAGE);
  const { sheet, key, value } = parseSheet(name);
  let since: string | null = null;
  if (typeof flags.since === "string") {
    const ms = parseIso(flags.since);
    if (ms === null) throw usageError(`--since must be an ISO time (got ${flags.since})`, READ_USAGE);
    since = new Date(ms).toISOString().replace(".000Z", "Z");
  }
  const root = requireRoot();
  const peer = typeof flags.repo === "string" ? flags.repo : null;
  let where = root;
  let b: string;
  if (peer) {
    b = typeof flags.branch === "string" ? flags.branch : DEFAULT_LOG_BRANCH;
    where = fetchPeer(root, peer, b);
  } else {
    if (typeof flags.branch === "string") throw usageError("--branch names another repo's log branch; use it with --repo", READ_USAGE);
    b = needBranch(root, "log read");
  }
  const clauses = [...(key ? [`${key}=${value}`] : []), ...(since ? [`at>=${since}`] : []), ...filters];
  let records: Rec[] = [];
  if (haveLocal(where, b) && git(where, ["cat-file", "-e", `refs/heads/${b}:.gitsheets/${sheet}.toml`]).code === 0) {
    const q = queryRecords(where, b, sheet, clauses);
    if ("error" in q) throw new AxiError(q.error, "READ_FAILED");
    records = q.records;
  }
  if (sheet === "cycles") {
    // quiet runs are trailers, not records: the lines they stand for
    records.push(...quietRuns(where, b).flatMap(quietLines).filter((r) => clauses.every((c) => clauseMatches(r, c))));
  }
  if (!peer) records.push(...readPending(root)[sheet].filter((r) => clauses.every((c) => clauseMatches(r, c))));
  records.sort(byAt);
  const shown = records.map((r) => {
    const o: Rec = { ...r };
    if (sheet === "posts" || sheet === "ledgers") {
      delete o.hash;
      if (key) delete o[key];
    }
    return o;
  });
  if (typeof flags["json-out"] === "string") writeJsonOut(flags["json-out"], shown);
  const out: Record<string, unknown> = {
    count: `${shown.length} record${shown.length === 1 ? "" : "s"} in ${name}${since ? ` since ${since}` : ""}${peer ? ` · ${peer} ${b}` : ""}`,
  };
  if (shown.length) out.records = shown.slice(-PREVIEW);
  if (shown.length > PREVIEW && typeof flags["json-out"] !== "string") {
    out.help = [`The newest ${PREVIEW} are shown; add --json-out <path> for all ${shown.length}`];
  }
  return out;
}

// ------------------------------------------------------------------ log seen

export function logSeen(args: string[]): Record<string, unknown> {
  const { positionals } = parseArgs(args, { maxPositionals: 1 }, SEEN_USAGE);
  const key = positionals[0];
  if (!key) throw usageError("log seen needs a key", SEEN_USAGE);
  const root = requireRoot();
  const seen = keySeen(root, key);
  setExit(seen ? 0 : 1);
  return { seen: seen ? "yes" : "no" };
}

export function logUsageHelp(): string[] {
  return [APPEND_USAGE, STATE_USAGE, READ_USAGE, SEEN_USAGE, "log tail [--n N]", MIGRATE_USAGE_TEXT].map((u) => `${cliInvocation()} ${u}`);
}
