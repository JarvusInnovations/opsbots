/**
 * The record's way back (specs/skills/opsbot-core.md, The console, and the record).
 *
 * `record.recall` in opsbot.json lists recalls: each names a gitsheet in the repo's
 * `.gitsheets/`, a filter, and where its rows come back to the session: `cold-start` (a section
 * of the pack, inside the wake.d budget), `cycle-end` (printed with the closing lines) or `item`
 * (added to a check item whose `from` or `conv` equals a row's `match` field).
 *
 * The core runs each recall with `gitsheets-axi query <sheet> --filter <clause>... --json-out=<tmp
 * file>` and reads the file, never the TOON on stdout. `OPSBOT_GITSHEETS_AXI` names another
 * binary. `filter` is one clause (a string) or several (a list), each in gitsheets-axi's own
 * syntax; a clause whose value is exactly `today` gets the date in the bot's timezone. A recall
 * never writes: the query only reads, and the result file lives in a temporary directory that is
 * removed. A recall that cannot run is one line saying so, never an empty section.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstLine, run, showHead } from "./repo.js";

export const RECALL_AT = ["cold-start", "cycle-end", "item"] as const;
export type RecallAt = (typeof RECALL_AT)[number];
export const RECALL_KEYS = ["sheet", "filter", "at", "title", "fields", "limit"];
export const DEFAULT_RECALL_LIMIT = 20;
/** Columns printed when `fields` is unset: the sheet's first four. */
export const DEFAULT_RECALL_FIELDS = 4;
/** A row's printed line is cut to this many characters. */
const ROW_MAX = 300;
const QUERY_TIMEOUT_MS = 30_000;
export const SHEETS_DIR = ".gitsheets";

export interface Recall {
  sheet: string;
  /** The clauses as written; `today` not yet resolved. */
  filter: string[];
  at: RecallAt;
  title: string;
  fields: string[] | null;
  limit: number;
}

const SHEET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const KEY = "[A-Za-z_][A-Za-z0-9_.-]*";
/** gitsheets-axi's clause forms: k=v · k!=v · k<v · k>v · k<=v · k>=v · k~regex · "k in (a,b)" · k:present · k:empty */
const CLAUSE_RE = new RegExp(`^(?:${KEY}(?:!=|<=|>=|=|<|>|~).*|${KEY}:(?:present|empty)|${KEY} in \\(.*\\))$`);
/** One token that opens a clause: used to catch two clauses written in one string. */
const CLAUSE_START_RE = new RegExp(`^(?:${KEY}(?:!=|<=|>=|=|<|>|~)|${KEY}:(?:present|empty)$)`);
const TODAY_RE = new RegExp(`^(${KEY})(!=|<=|>=|=|<|>)today$`);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The clauses of a `filter` value: a string is one clause, a list is several, absent is none. */
export function filterClauses(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return [];
}

/** Problems with one clause, as gitsheets-axi would parse it. */
function clauseProblems(c: string, where: string): string[] {
  if (!CLAUSE_RE.test(c)) {
    return [`${where} ${JSON.stringify(c)} is not a gitsheets-axi filter clause (k=v, k!=v, k<v, k>v, k<=v, k>=v, k~regex, "k in (a,b)", k:present, k:empty)`];
  }
  const starts = c.split(/\s+/).filter((t) => CLAUSE_START_RE.test(t)).length;
  if (starts > 1) return [`${where} ${JSON.stringify(c)} holds more than one clause; write them as a list, one clause each`];
  return [];
}

/** Problems with the `record` settings block's shape; whether each sheet exists is `recallSheetProblems`. */
export function recordProblems(v: unknown): string[] {
  if (!isObj(v)) return ["record must be an object ({recall: [...]})"];
  const problems: string[] = [];
  for (const k of Object.keys(v)) if (k !== "//" && k !== "recall") problems.push(`unknown key record.${k}`);
  if (v.recall === undefined) return problems;
  if (!Array.isArray(v.recall)) return [...problems, "record.recall must be a list of recalls"];
  v.recall.forEach((r, i) => {
    const w = `record.recall[${i}]`;
    if (!isObj(r)) {
      problems.push(`${w} must be an object ({sheet, filter, at, title, fields, limit})`);
      return;
    }
    for (const k of Object.keys(r)) if (k !== "//" && !RECALL_KEYS.includes(k)) problems.push(`unknown key ${w}.${k}`);
    if (typeof r.sheet !== "string" || !r.sheet) problems.push(`missing required key ${w}.sheet`);
    else if (!SHEET_RE.test(r.sheet)) problems.push(`${w}.sheet ${JSON.stringify(r.sheet)} must be a sheet name (.gitsheets/<name>.toml)`);
    if (r.at === undefined) problems.push(`missing required key ${w}.at`);
    else if (!RECALL_AT.includes(r.at as RecallAt)) problems.push(`${w}.at must be one of ${RECALL_AT.join(", ")} (got ${JSON.stringify(r.at)})`);
    if (r.filter !== undefined) {
      if (typeof r.filter === "string") problems.push(...clauseProblems(r.filter.trim(), `${w}.filter`));
      else if (Array.isArray(r.filter)) {
        r.filter.forEach((c, j) => {
          if (typeof c !== "string" || !c.trim()) problems.push(`${w}.filter[${j}] must be a non-empty string`);
          else problems.push(...clauseProblems(c.trim(), `${w}.filter[${j}]`));
        });
      } else problems.push(`${w}.filter must be a gitsheets-axi filter clause (a string) or a list of them`);
    }
    if (r.title !== undefined && (typeof r.title !== "string" || !r.title.trim())) problems.push(`${w}.title must be a non-empty string`);
    if (r.fields !== undefined && (!Array.isArray(r.fields) || r.fields.length === 0 || r.fields.some((f) => typeof f !== "string" || !f.trim()))) {
      problems.push(`${w}.fields must be a non-empty list of field names`);
    }
    if (r.limit !== undefined && (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit <= 0)) problems.push(`${w}.limit must be a positive whole number`);
  });
  return problems;
}

/** The recalls of a `record` block that validated. */
export function recallEntries(v: unknown): Recall[] {
  if (!isObj(v) || !Array.isArray(v.recall)) return [];
  return v.recall.filter(isObj).map((r) => ({
    sheet: String(r.sheet),
    filter: filterClauses(r.filter),
    at: r.at as RecallAt,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : String(r.sheet),
    fields: Array.isArray(r.fields) ? (r.fields as string[]) : null,
    limit: typeof r.limit === "number" ? r.limit : DEFAULT_RECALL_LIMIT,
  }));
}

/** The sheet config's text: the working tree's, else HEAD's; null when neither has it. */
export function sheetConfig(root: string, sheet: string, head = false): string | null {
  const rel = `${SHEETS_DIR}/${sheet}.toml`;
  const p = join(root, rel);
  if (!head && existsSync(p)) {
    try { return readFileSync(p, "utf8"); } catch { /* fall through to HEAD */ }
  }
  return showHead(root, rel);
}

/** Every sheet the repo configures: `.gitsheets/*.toml` in the working tree, sorted. */
export function listSheets(root: string): string[] {
  const dir = join(root, SHEETS_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/** A sheet's fields in the order its config declares them (`[gitsheet.schema.properties.<f>]`). */
export function sheetFieldOrder(config: string | null): string[] {
  if (!config) return [];
  const out: string[] = [];
  for (const m of config.matchAll(/^\s*\[gitsheet\.schema\.properties\.([A-Za-z0-9_-]+)\]\s*$/gm)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Problems a recall would hit before it runs: the sheet it names is not under `.gitsheets/`. */
export function recallSheetProblems(root: string, recalls: Recall[], head = false): string[] {
  const problems: string[] = [];
  recalls.forEach((r, i) => {
    const cfg = head ? sheetConfig(root, r.sheet, true) : existsSync(join(root, SHEETS_DIR, `${r.sheet}.toml`)) ? sheetConfig(root, r.sheet) : null;
    if (cfg === null) {
      problems.push(`record.recall[${i}] names sheet ${r.sheet}, but ${SHEETS_DIR}/${r.sheet}.toml does not exist${head ? " at HEAD" : ""}`);
      return;
    }
    if (r.at === "item") {
      const fields = sheetFieldOrder(cfg);
      if (fields.length && !fields.includes("match")) {
        problems.push(`record.recall[${i}] is an item recall, but sheet ${r.sheet} declares no match field to compare with an item's from or conv`);
      }
    }
  });
  return problems;
}

/** The date in a zone, YYYY-MM-DD. */
export function localDate(ms: number, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The clauses with `today` resolved to the date in the bot's timezone. */
export function resolveFilter(clauses: string[], ms: number, timeZone: string): string[] {
  const today = localDate(ms, timeZone);
  return clauses.map((c) => {
    const m = c.match(TODAY_RE);
    return m ? `${m[1]}${m[2]}${today}` : c;
  });
}

export function gitsheetsBin(): string {
  return process.env.OPSBOT_GITSHEETS_AXI || "gitsheets-axi";
}

export type Row = Record<string, unknown>;

/** The command a person or the bot runs to see every row of a recall. */
export function recallCommand(r: Recall, clauses: string[]): string {
  const q = (c: string) => (/^[A-Za-z0-9_.:=,-]+$/.test(c) ? c : `'${c.replace(/'/g, `'\\''`)}'`);
  return ["gitsheets-axi", "query", r.sheet, ...clauses.flatMap((c) => ["--filter", q(c)])].join(" ");
}

/**
 * Run one recall's query: its rows, or why it could not run. Reads the full result from the
 * `--json-out` file in a temporary directory, which is removed; writes nothing in the repo.
 */
export function queryRecall(root: string, r: Recall, ms: number, timeZone: string): { rows: Row[]; clauses: string[] } | { error: string; clauses: string[] } {
  const clauses = resolveFilter(r.filter, ms, timeZone);
  if (sheetConfig(root, r.sheet) === null) return { error: `sheet ${r.sheet} is missing: no ${SHEETS_DIR}/${r.sheet}.toml`, clauses };
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "opsbot-recall-"));
    const out = join(dir, "rows.json");
    const res = run(gitsheetsBin(), ["query", r.sheet, ...clauses.flatMap((c) => ["--filter", c]), `--json-out=${out}`], { cwd: root, timeoutMs: QUERY_TIMEOUT_MS });
    if (res.code !== 0) {
      const err = res.stdout.split("\n").find((l) => l.startsWith("error:"));
      const why = (err ? err.replace(/^error:\s*/, "").replace(/^"|"$/g, "") : "") || firstLine(res.stderr) || firstLine(res.stdout) || "no message";
      return { error: `gitsheets-axi query failed (exit ${res.code}): ${why}`, clauses };
    }
    if (!existsSync(out)) return { error: "gitsheets-axi query wrote no result file", clauses };
    const v = JSON.parse(readFileSync(out, "utf8"));
    if (!Array.isArray(v)) return { error: "gitsheets-axi query's result file is not a JSON array", clauses };
    return { rows: v.filter(isObj), clauses };
  } catch (e) {
    return { error: `the query could not run: ${(e as Error).message}`, clauses };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cell).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ").trim();
}

/** The columns a recall prints: its `fields`, else the sheet's first four, else the row's. */
export function recallFields(root: string, r: Recall, rows: Row[]): string[] {
  if (r.fields) return r.fields;
  const order = sheetFieldOrder(sheetConfig(root, r.sheet));
  if (order.length) return order.slice(0, DEFAULT_RECALL_FIELDS);
  return rows.length ? Object.keys(rows[0]!).slice(0, DEFAULT_RECALL_FIELDS) : [];
}

/** One row as one line: `field: value` pairs, empty values left out. */
export function rowLine(row: Row, fields: string[]): string {
  const parts = fields.map((f) => [f, cell(row[f])] as const).filter(([, v]) => v !== "").map(([f, v]) => `${f}: ${v}`);
  const line = parts.join(" · ") || "(no values in the shown fields)";
  return line.length > ROW_MAX ? `${line.slice(0, ROW_MAX - 1)}…` : line;
}

/** At most `limit` row lines, then "… N more" with the command that shows them all. */
export function cappedRows(rows: Row[], fields: string[], limit: number, more: string): string[] {
  const out = rows.slice(0, limit).map((row) => rowLine(row, fields));
  if (rows.length > limit) out.push(`… ${rows.length - limit} more: ${more}`);
  return out;
}

export interface RecallOutcome {
  recall: Recall;
  /** The heading: title, sheet and the resolved filter. */
  head: string;
  /** The resolved clauses, space-separated, or "no filter". */
  filter: string;
  /** The row lines (capped), or the one line saying why it could not run. */
  lines: string[];
  ok: boolean;
  count: number;
}

/** Run one recall for printing: rows as capped lines, or one line saying why not. */
export function runRecall(root: string, r: Recall, ms: number, timeZone: string): RecallOutcome {
  const q = queryRecall(root, r, ms, timeZone);
  const filter = q.clauses.length ? q.clauses.join(" ") : "no filter";
  const head = `${r.title} (${r.sheet}: ${filter})`;
  if ("error" in q) return { recall: r, head, filter, lines: [`recall of ${r.sheet} could not run: ${q.error}`], ok: false, count: 0 };
  const fields = recallFields(root, r, q.rows);
  return { recall: r, head, filter, lines: cappedRows(q.rows, fields, r.limit, recallCommand(r, q.clauses)), ok: true, count: q.rows.length };
}

/** Whether a row's `match` field names an item's `from` or `conv` (a string, or a list of them). */
export function rowMatches(row: Row, item: { from?: unknown; conv?: unknown }): boolean {
  const keys = [item.from, item.conv].filter((x): x is string => typeof x === "string" && x !== "");
  if (!keys.length) return false;
  const m = row.match;
  if (typeof m === "string") return keys.includes(m);
  if (Array.isArray(m)) return m.some((x) => typeof x === "string" && keys.includes(x));
  return false;
}
