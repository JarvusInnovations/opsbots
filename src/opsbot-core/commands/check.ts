/**
 * check — is anything new? One sweep of every stream, without the model.
 *
 * Runs every script in opsbot.d/heartbeat.d/. Each is one input: it prints
 * NDJSON items {key, at, conv, kind, from, text, ...}; exit 0 with no lines is
 * nothing new; non-zero is that input failing (the items it printed are still
 * reported). The core drops items whose key is already seen.
 *
 *   0   nothing new   one line; logs it to the log branch (a quiet commit), advances
 *                     the watermark to the time this run started
 *   10  new           the digest; records the reported keys as seen, logs, leaves
 *                     the watermark alone
 *   20  degraded      which inputs failed and why, then what could be read;
 *                     records, logs, leaves the watermark alone, writes if it can
 *   2   cannot run    no settings at HEAD; nothing read, nothing written
 *
 * A degraded input never yields "nothing new".
 */
import { hookTimesTrailer } from "../hooktimes.js";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { baseEnv, configSnapshot, discover, runScript } from "../lifecycle.js";
import { blockedBy, commitOnly, firstLine, hasHead, iso, nowMs, parseIso, requireRoot, trailers } from "../repo.js";
import { branchWatermark, commitStaged, hasStaged, logBranch, readPending, seenFileFor, seenRecords, stage, writeQuiet } from "../log.js";
import { loadSettings, type Settings } from "../settings.js";
import { cappedRows, queryRecall, recallCommand, recallFields, rowMatches } from "../record.js";
import { changedMemoryFiles } from "../memory.js";
import { loadRoutines, routineItems } from "../routines.js";
import { readSeen, readWatermark, validWatermark } from "../state.js";

export const MARGIN_MINUTES = 30;
export const FIRST_RUN_HOURS = 24;

export const CHECK_USAGE = "check [--no-commit] | check --peek";

export interface Item {
  input: string;
  key: string;
  /** More seen keys this item stands for (a digest row for a group of events). */
  keys?: string[];
  /** Exactly false: record the keys as seen, never show the item. */
  report?: unknown;
  at?: string;
  conv?: string;
  kind?: string;
  from?: string;
  text?: string;
  [k: string]: unknown;
}

export interface InputResult {
  input: string;
  ok: boolean;
  new: number;
  /** Items recorded as seen with `report: false`, never shown. */
  quiet: number;
  error?: string;
}

export interface CheckResult {
  code: 0 | 10 | 20;
  outcome: "nothing-new" | "new" | "degraded";
  line: string;
  output: Record<string, unknown>;
  /** Whether this check committed files on the program branch (memory), so the caller pushes it. */
  program?: boolean;
}

/** Whole-word, capitals-only presence of the gate word (judged elsewhere, never here). */
export function gateWordIn(text: string, word: string): boolean {
  if (!/^[A-Z]{3,}$/.test(word)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(text ?? "");
}

function parseItems(stdout: string, input: string): { items: Item[]; bad: number } {
  const items: Item[] = [];
  let bad = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      const keysOk = v?.keys === undefined || (Array.isArray(v.keys) && v.keys.every((k: unknown) => typeof k === "string" && k !== ""));
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.key === "string" && v.key !== "" && keysOk) {
        items.push({ ...v, input });
      } else bad++;
    } catch {
      bad++;
    }
  }
  return { items, bad };
}

const CORE_FIELDS = ["key", "at", "conv", "kind", "from"];

/** Every seen key an item carries: `key`, then each of `keys`. */
export function itemKeys(it: Item): string[] {
  return [it.key, ...(it.keys ?? [])];
}

/**
 * The `item` recalls: for each new item, the rows whose `match` field equals its `from` or `conv`,
 * capped per recall with "… N more". Each recall's query runs once per check, and only when there
 * are new items. A recall that cannot run is one line in `failed`, never an empty field.
 */
export function itemRecall(root: string, s: Settings, ms: number, items: Item[]): { byItem: string[][]; failed: string[] } {
  const byItem: string[][] = items.map(() => []);
  const failed: string[] = [];
  for (const r of s.record.recall.filter((x) => x.at === "item")) {
    const q = queryRecall(root, r, ms, s.timezone);
    if ("error" in q) {
      failed.push(`recall of ${r.sheet} could not run: ${q.error}`);
      continue;
    }
    const fields = recallFields(root, r, q.rows);
    items.forEach((it, i) => {
      const hits = q.rows.filter((row) => rowMatches(row, it));
      if (!hits.length) return;
      const key = typeof it.from === "string" && hits.some((h) => rowMatches(h, { from: it.from })) ? it.from : String(it.conv);
      byItem[i]!.push(`${r.title} (${r.sheet}): ${hits.length}`, ...cappedRows(hits, fields, r.limit, recallCommand(r, [...q.clauses, `match=${key}`])).map((l) => `  ${l}`));
    });
  }
  return { byItem, failed };
}

function renderItem(it: Item, n: number, total: number, gateWord: string | null, recall: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { n: `${n}/${total}`, input: it.input };
  for (const f of CORE_FIELDS) {
    if (it[f] === undefined) continue;
    out[f] = f === "kind" && typeof it.kind === "string" ? it.kind.toUpperCase() : it[f];
  }
  if (gateWord && typeof it.text === "string" && gateWordIn(it.text, gateWord)) {
    // An adapter may say the author cannot give the gate word (another bot's message, say).
    const voided = typeof it.gate_word_void === "string" && it.gate_word_void.trim() !== "";
    out.gate_word = voided ? `present, does not count: ${String(it.gate_word_void).trim()}` : "present";
  }
  for (const [k, v] of Object.entries(it)) {
    if (k === "input" || k === "text" || k === "report" || k === "gate_word_void" || CORE_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  if (recall.length) out.recall = recall;
  if (it.text !== undefined) out.text = it.text;
  return out;
}

export interface PeekResult {
  code: 0 | 10 | 20;
  outcome: CheckResult["outcome"];
  line: string;
  inputs: InputResult[];
  new: number;
  /** The earliest `at` among the new items, when any carries one. */
  earliest: string | null;
}

/**
 * The check's sweep without its record: every heartbeat script runs as in a check (with
 * OPSBOT_PEEK=1 in its environment, so an adapter that keeps state of its own can leave it), and
 * nothing is recorded, logged or committed. The watermark and the seen keys are read, never
 * written, so the check that follows sees the same items.
 */
export function runPeek(root: string): PeekResult {
  const r = sweep(root, { commit: false, peek: true });
  if (!("peek" in r)) throw new Error("unreachable: a peek returned a check");
  return r.peek;
}

/**
 * A fast check (specs/skills/opsbot-core.md, A fast cycle): only the named heartbeat.d inputs,
 * given the last full check's OPSBOT_SINCE; the watermark is left where it is.
 */
export interface FastCheck {
  inputs: string[];
  since: string;
}

/** An input of the core's own that the caller ran before the check (`repo_sync` at cycle begin):
 * its items join the check's, and are reported once like any stream's. */
export interface CoreInput {
  input: string;
  items: Array<Record<string, unknown> & { key: string }>;
}

/** What `cycle begin` adds to this check's record: its begin scripts' times and what it skipped. */
export interface CycleRecord {
  hooks?: Record<string, number>;
  skipped_hooks?: string[];
}

export function runCheck(root: string, opts: { commit: boolean; fast?: FastCheck | null; mode?: string; core?: CoreInput[]; record?: CycleRecord }): CheckResult {
  const r = sweep(root, { commit: opts.commit, peek: false, fast: opts.fast ?? null, mode: opts.mode, core: opts.core ?? [], record: opts.record });
  if (!("check" in r)) throw new Error("unreachable: a check returned a peek");
  return r.check;
}

function sweep(
  root: string,
  opts: { commit: boolean; peek: boolean; fast?: FastCheck | null; mode?: string; core?: CoreInput[]; record?: CycleRecord },
): { check: CheckResult } | { peek: PeekResult } {
  const fast = opts.peek ? null : (opts.fast ?? null);
  if (!hasHead(root)) {
    throw new AxiError("no commit at HEAD in this checkout", "CANNOT_RUN", ["Commit opsbot.json first"]);
  }
  const { settings, text } = loadSettings(root);
  const branch = logBranch(root);
  const startMs = nowMs();
  const NOW = iso(startMs);
  const inputs: InputResult[] = [];
  const failed = (input: string, error: string, n = 0, quiet = 0) => inputs.push({ input, ok: false, new: n, quiet, error });

  // the window
  let wm = readWatermark(root);
  let sinceMs: number;
  if (wm !== null && validWatermark(wm)) {
    sinceMs = parseIso(wm)! - MARGIN_MINUTES * 60_000;
  } else {
    if (wm !== null) failed("watermark", "the log tip's Watermark trailer is not one ISO-8601 UTC time");
    wm = null;
    sinceMs = startMs - FIRST_RUN_HOURS * 3_600_000;
  }
  // a fast check reads the window the last full check read: only a full check moves the watermark
  const SINCE = fast ? fast.since : iso(sinceMs);
  const seen = readSeen(root);

  // every stream; a fast check, only the inputs the wake named
  const configPath = configSnapshot(root, text);
  // the keys are on the log branch; scripts read a copy in the git dir
  const seenFile = seenFileFor(root, branch);
  const all = discover(root, "heartbeat").scripts;
  const scripts = fast ? all.filter((s) => fast.inputs.includes(s.name)) : all;
  if (scripts.length === 0) {
    failed("heartbeat.d", "no heartbeat scripts are installed, so no stream can be read");
  }
  const items: Item[] = [];
  // every key recorded this run, reported or quiet, in order
  const recorded: string[] = [];
  const recordedSet = new Set<string>();
  // new when any of its keys is not yet seen; then every one of its keys is recorded
  const take = (got: Item[]): { fresh: Item[]; quiet: number } => {
    const fresh: Item[] = [];
    let quiet = 0;
    for (const it of got) {
      const ks = itemKeys(it);
      if (!ks.some((k) => !seen.has(k) && !recordedSet.has(k))) continue;
      for (const k of ks) {
        if (seen.has(k) || recordedSet.has(k)) continue;
        recordedSet.add(k);
        recorded.push(k);
      }
      if (it.report === false) quiet++;
      else fresh.push(it);
    }
    return { fresh, quiet };
  };
  for (const s of scripts) {
    const env = baseEnv(root, settings, configPath, "heartbeat", {
      OPSBOT_SINCE: SINCE,
      OPSBOT_SEEN: seenFile,
      OPSBOT_WATERMARK: wm ?? "",
      ...(opts.peek ? { OPSBOT_PEEK: "1" } : {}),
    });
    const r = runScript(s, root, env);
    const { items: got, bad } = parseItems(r.stdout, s.name);
    const { fresh, quiet } = take(got);
    items.push(...fresh);
    if (r.code !== 0) {
      failed(s.name, `exit ${r.code}: ${firstLine(r.stderr) || "no message"}`, fresh.length, quiet);
    } else if (bad > 0) {
      failed(s.name, `${bad} line${bad === 1 ? "" : "s"} of output not a heartbeat item ({key, at, conv, kind, from, text})`, fresh.length, quiet);
    } else {
      inputs.push({ input: s.name, ok: true, new: fresh.length, quiet });
    }
  }

  // the core's own input: one item per due routine occurrence. Listed only when the bot has a
  // definition or there is something to say, so a bot without routines reads as before. A fast
  // check leaves it for the next full one.
  if (!fast) {
    let got: Item[] = [];
    let problems: string[] = [];
    let files = 0;
    try {
      const r = loadRoutines(root, settings, startMs);
      got = routineItems(r, settings, startMs, cliInvocation()).map((it) => ({ ...(it as { key: string }), input: "routines" }));
      problems = r.problems;
      files = r.files;
    } catch (e) {
      problems = [`the routines could not be read: ${(e as Error).message}`];
    }
    if (files > 0 || got.length > 0 || problems.length > 0) {
      const { fresh, quiet } = take(got);
      items.push(...fresh);
      if (problems.length) {
        failed("routines", `${problems.length} problem${problems.length === 1 ? "" : "s"}, first ${problems[0]}; run \`${cliInvocation()} routines validate --head\``, fresh.length, quiet);
      } else inputs.push({ input: "routines", ok: true, new: fresh.length, quiet });
    }
  }

  // the core's inputs its caller ran (repo_sync): reported once, like a stream's items
  for (const c of opts.core ?? []) {
    const { fresh, quiet } = take(c.items.map((it) => ({ ...it, input: c.input })));
    items.push(...fresh);
    inputs.push({ input: c.input, ok: true, new: fresh.length, quiet });
  }

  const NEW = items.length;
  const realInputs = () => inputs.filter((i) => i.input !== "watermark" && i.input !== "commit" && i.input !== "heartbeat.d");
  if (opts.peek) {
    const bad = inputs.filter((i) => !i.ok);
    const code: PeekResult["code"] = bad.length ? 20 : NEW > 0 ? 10 : 0;
    const outcome: CheckResult["outcome"] = code === 20 ? "degraded" : code === 10 ? "new" : "nothing-new";
    const ats = items.map((it) => (typeof it.at === "string" ? parseIso(it.at) : null)).filter((t): t is number => t !== null);
    const n = realInputs().length;
    const line =
      code === 0
        ? `nothing new · ${n} inputs · nothing recorded`
        : code === 10
          ? `new · ${NEW} new · ${n} inputs · nothing recorded`
          : `degraded · ${bad.length} failed · ${NEW} new · ${n} inputs · nothing recorded`;
    return { peek: { code, outcome, line, inputs, new: NEW, earliest: ats.length ? iso(Math.min(...ats)) : null } };
  }
  const blocked = opts.commit ? blockedBy(root) : null;
  if (blocked) failed("commit", `cannot commit: ${blocked}`);

  const failedList = () => inputs.filter((i) => !i.ok).map((i) => ({ input: i.input, error: i.error ?? "" }));
  let outcome: CheckResult["outcome"] = failedList().length ? "degraded" : NEW > 0 ? "new" : "nothing-new";

  return { check: branchState(root, branch, settings, { opts, fast, outcome, inputs, items, recorded, NOW, SINCE, startMs, blocked, failed, failedList, realInputs }) };
}

/** The check's output once its state is written: the one line, the failures and the items. */
function finishCheck(
  root: string,
  settings: Settings,
  o: { outcome: CheckResult["outcome"]; fast: FastCheck | null; items: Item[]; NEW: number; startMs: number; realInputs: () => InputResult[]; failedList: () => Array<{ input: string; error: string }> },
): CheckResult {
  const { outcome, fast, items, NEW, startMs, realInputs, failedList } = o;
  const cur = readWatermark(root);
  const n = realInputs().length;
  const code: CheckResult["code"] = outcome === "nothing-new" ? 0 : outcome === "new" ? 10 : 20;
  if (outcome === "nothing-new") {
    const line = `nothing new · ${n} inputs · watermark ${cur ?? "none"}${fast ? " (held: fast check)" : ""}`;
    return { code, outcome, line, output: { check: line } };
  }
  const fl = failedList();
  const line =
    outcome === "degraded"
      ? `degraded · ${fl.length} failed · ${NEW} new · ${n} inputs · watermark ${cur ?? "none"} (not advanced)`
      : `new · ${NEW} new · ${n} inputs · watermark ${cur ?? "none"} (not advanced)`;
  const output: Record<string, unknown> = { check: line };
  if (fl.length) output.failed = fl;
  if (NEW > 0) {
    const deco = itemRecall(root, settings, startMs, items);
    output.items = items.map((it, i) => renderItem(it, i + 1, NEW, settings.gate_word, deco.byItem[i]));
    if (deco.failed.length) output.recall = deco.failed;
  }
  return { code, outcome, line, output };
}

/**
 * The check's records go to the log branch, never the working tree. A quiet
 * check (nothing new, no key recorded, nothing staged) is a quiet commit, amended while the run
 * lasts. A check that found something inside a cycle is staged and rides the `cycle end` commit;
 * outside a cycle (`check`) it is its own commit. `--no-commit` stages everything.
 */
function branchState(
  root: string,
  branch: string,
  settings: Settings,
  c: {
    opts: { commit: boolean; mode?: string; record?: CycleRecord };
    fast: FastCheck | null;
    outcome: CheckResult["outcome"];
    inputs: InputResult[];
    items: Item[];
    recorded: string[];
    NOW: string;
    SINCE: string;
    startMs: number;
    blocked: string | null;
    failed: (input: string, error: string) => void;
    failedList: () => Array<{ input: string; error: string }>;
    realInputs: () => InputResult[];
  },
): CheckResult {
  const { opts, fast, recorded, NOW, SINCE, startMs, failed, failedList, realInputs, items } = c;
  let outcome = c.outcome;
  const NEW = items.length;
  const lineFor = (): Record<string, unknown> => {
    const inputsObj: Record<string, { ok: boolean; new: number; quiet?: number }> = {};
    for (const i of realInputs()) {
      inputsObj[i.input] = { ok: i.ok, new: i.new };
      if (i.quiet > 0) inputsObj[i.input]!.quiet = i.quiet;
    }
    const line: Record<string, unknown> = { at: NOW, outcome, inputs: inputsObj, new: NEW, failed: failedList() };
    if (opts.mode) {
      line.check = opts.mode;
      line.since = SINCE;
    }
    if (fast) line.fast = true;
    const hooks = opts.record?.hooks ?? {};
    if (Object.keys(hooks).length) line.hooks = hooks;
    if (opts.record?.skipped_hooks?.length) line.skipped_hooks = opts.record.skipped_hooks;
    return line;
  };
  const seen = seenRecords(recorded, NOW);
  const advance = outcome === "nothing-new" && !fast ? NOW : null;
  const kind = fast ? "fast" : "full";
  let program = false;
  if (!opts.commit) {
    stage(root, { cycles: [lineFor()], seen, ...(advance ? { watermark: advance } : {}) });
  } else {
    // a skipped begin script is a record of its own, never folded into a quiet run
    const quiet = outcome === "nothing-new" && recorded.length === 0 && !hasStaged(readPending(root)) && !opts.record?.skipped_hooks?.length;
    const hookTimes = opts.record?.hooks && Object.keys(opts.record.hooks).length ? [`Hook-Times: ${hookTimesTrailer(opts.record.hooks)}`] : [];
    const subject = outcome === "nothing-new" ? "nothing new" : outcome === "new" ? `${NEW} new` : `degraded, ${NEW} new`;
    let why: string | null = null;
    if (quiet) {
      const w = writeQuiet(root, branch, { now: NOW, watermark: advance ?? branchWatermark(root, branch), check: kind, since: SINCE, extra: hookTimes }, startMs, trailers());
      if (!w.ok) why = w.why;
    } else if (opts.mode && outcome !== "nothing-new") {
      // inside a cycle: the cycle's one commit is made at `cycle end`
      stage(root, { cycles: [lineFor()], seen });
    } else {
      const w = commitStaged(root, branch, { cycles: [lineFor()], seen }, { subject: `cycle: ${subject}`, watermark: advance ?? undefined, check: kind }, trailers());
      if (!w.ok) why = w.why;
    }
    if (why) {
      // nothing is lost: the line, now degraded, and the keys are staged for the next commit
      failed("commit", `cannot write the log: ${why}`);
      outcome = "degraded";
      stage(root, { cycles: [lineFor()], seen });
    }
    // what the cycle changed on the program branch (memory) stays an ordinary commit
    if (!c.blocked) {
      const files = changedMemoryFiles(root, settings);
      if (files.length) {
        const w = commitOnly(root, files, "chore(bot): the files the cycle changed");
        if (w) failed("commit", `cannot commit the program branch's files: ${w}`);
        else program = true;
        if (w && outcome !== "degraded") outcome = "degraded";
      }
    }
  }
  return { ...finishCheck(root, settings, { outcome, fast, items, NEW, startMs, realInputs, failedList }), program };
}

export function checkCommand(args: string[]): Record<string, unknown> {
  const { flags } = parseArgs(args, { bool: ["no-commit", "peek"] }, CHECK_USAGE);
  const root = requireRoot();
  if (flags.peek) {
    if (flags["no-commit"]) throw new AxiError("--peek commits nothing already; drop --no-commit", "VALIDATION_ERROR", [CHECK_USAGE]);
    if (!hasHead(root)) throw new AxiError("no commit at HEAD in this checkout", "CANNOT_RUN", ["Commit opsbot.json first"]);
    const r = runPeek(root);
    setExit(r.code);
    const out: Record<string, unknown> = {
      peek: r.line,
      inputs: r.inputs.map((i) => ({ input: i.input, ok: i.ok, new: i.new, error: i.error ?? "" })),
    };
    if (r.code !== 0) out.help = [`Nothing was recorded; run \`${cliInvocation()} cycle begin\` to work the items`];
    return out;
  }
  const r = runCheck(root, { commit: !flags["no-commit"] });
  setExit(r.code);
  if (r.code !== 0) {
    r.output.help = [`Work the items, then run \`${cliInvocation()} cycle end --records <n>\`${r.code === 20 ? " (add --degraded when an input could not be read)" : ""}`];
  }
  return r.output;
}

