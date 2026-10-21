/**
 * check — is anything new? One sweep of every stream, without the model.
 *
 * Runs every script in opsbot.d/heartbeat.d/. Each is one input: it prints
 * NDJSON items {key, at, conv, kind, from, text, ...}; exit 0 with no lines is
 * nothing new; non-zero is that input failing (the items it printed are still
 * reported). The core drops items whose key is already seen.
 *
 *   0   nothing new   one line; appends to the cycle log, advances the
 *                     watermark to the time this run started, commits
 *   10  new           the digest; records the reported keys as seen, logs,
 *                     leaves the watermark alone, commits
 *   20  degraded      which inputs failed and why, then what could be read;
 *                     records, logs, leaves the watermark alone, commits if it can
 *   2   cannot run    no settings at HEAD; nothing read, nothing written
 *
 * A degraded input never yields "nothing new".
 */
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { baseEnv, configSnapshot, discover, runScript } from "../lifecycle.js";
import { blockedBy, commitOnly, firstLine, hasHead, iso, nowMs, parseIso, requireRoot } from "../repo.js";
import { loadSettings } from "../settings.js";
import {
  appendJsonl,
  appendSeen,
  fileSize,
  paths,
  readSeen,
  readWatermark,
  truncateTo,
  validWatermark,
  writeWatermark,
} from "../state.js";
import { existsSync, rmSync } from "node:fs";

export const MARGIN_MINUTES = 30;
export const FIRST_RUN_HOURS = 24;

export const CHECK_USAGE = "check [--no-commit]";

export interface Item {
  input: string;
  key: string;
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
  error?: string;
}

export interface CheckResult {
  code: 0 | 10 | 20;
  outcome: "nothing-new" | "new" | "degraded";
  line: string;
  output: Record<string, unknown>;
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
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.key === "string" && v.key !== "") {
        items.push({ ...v, input });
      } else bad++;
    } catch {
      bad++;
    }
  }
  return { items, bad };
}

const CORE_FIELDS = ["key", "at", "conv", "kind", "from"];

function renderItem(it: Item, n: number, total: number, gateWord: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { n: `${n}/${total}`, input: it.input };
  for (const f of CORE_FIELDS) {
    if (it[f] === undefined) continue;
    out[f] = f === "kind" && typeof it.kind === "string" ? it.kind.toUpperCase() : it[f];
  }
  if (gateWord && typeof it.text === "string" && gateWordIn(it.text, gateWord)) out.gate_word = "present";
  for (const [k, v] of Object.entries(it)) {
    if (k === "input" || k === "text" || CORE_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  if (it.text !== undefined) out.text = it.text;
  return out;
}

export function runCheck(root: string, opts: { commit: boolean }): CheckResult {
  if (!hasHead(root)) {
    throw new AxiError("no commit at HEAD in this checkout", "CANNOT_RUN", ["Commit opsbot.json first"]);
  }
  const { settings, text } = loadSettings(root);
  const p = paths(root);
  const startMs = nowMs();
  const NOW = iso(startMs);
  const inputs: InputResult[] = [];
  const failed = (input: string, error: string, n = 0) => inputs.push({ input, ok: false, new: n, error });

  // the window
  let wm = readWatermark(root);
  let sinceMs: number;
  if (wm !== null && validWatermark(wm)) {
    sinceMs = parseIso(wm)! - MARGIN_MINUTES * 60_000;
  } else {
    if (wm !== null) failed("watermark", "the watermark file does not hold one ISO-8601 UTC time");
    wm = null;
    sinceMs = startMs - FIRST_RUN_HOURS * 3_600_000;
  }
  const SINCE = iso(sinceMs);
  const seen = readSeen(root);

  // every stream
  const configPath = configSnapshot(root, text);
  const { scripts } = discover(root, "heartbeat");
  if (scripts.length === 0) {
    failed("heartbeat.d", "no heartbeat scripts are installed, so no stream can be read");
  }
  const items: Item[] = [];
  const reported = new Set<string>();
  for (const s of scripts) {
    const env = baseEnv(root, settings, configPath, "heartbeat", {
      OPSBOT_SINCE: SINCE,
      OPSBOT_SEEN: p.seen,
      OPSBOT_WATERMARK: wm ?? "",
    });
    const r = runScript(s, root, env);
    const { items: got, bad } = parseItems(r.stdout, s.name);
    const fresh = got.filter((it) => !seen.has(it.key) && !reported.has(it.key));
    for (const it of fresh) reported.add(it.key);
    items.push(...fresh);
    if (r.code !== 0) {
      failed(s.name, `exit ${r.code}: ${firstLine(r.stderr) || "no message"}`, fresh.length);
    } else if (bad > 0) {
      failed(s.name, `${bad} line${bad === 1 ? "" : "s"} of output not a heartbeat item ({key, at, conv, kind, from, text})`, fresh.length);
    } else {
      inputs.push({ input: s.name, ok: true, new: fresh.length });
    }
  }

  const NEW = items.length;
  const realInputs = () => inputs.filter((i) => i.input !== "watermark" && i.input !== "commit" && i.input !== "heartbeat.d");
  const blocked = opts.commit ? blockedBy(root) : null;
  if (blocked) failed("commit", `cannot commit: ${blocked}`);

  const failedList = () => inputs.filter((i) => !i.ok).map((i) => ({ input: i.input, error: i.error ?? "" }));
  let outcome: CheckResult["outcome"] = failedList().length ? "degraded" : NEW > 0 ? "new" : "nothing-new";

  // the state
  const logSize = fileSize(p.log);
  const seenSize = fileSize(p.seen);
  const oldWm = readWatermark(root);
  const writeState = () => {
    appendSeen(root, items.map((i) => i.key));
    if (outcome === "nothing-new") writeWatermark(root, NOW);
    const cur = readWatermark(root);
    const inputsObj: Record<string, { ok: boolean; new: number }> = {};
    for (const i of realInputs()) inputsObj[i.input] = { ok: i.ok, new: i.new };
    appendJsonl(p.log, {
      at: NOW,
      outcome,
      inputs: inputsObj,
      new: NEW,
      failed: failedList(),
      watermark: cur ?? null,
    });
  };
  writeState();

  if (opts.commit && !blocked) {
    const subject = outcome === "nothing-new" ? "nothing new" : outcome === "new" ? `${NEW} new` : `degraded, ${NEW} new`;
    const files = [p.seen, p.log];
    if (existsSync(p.watermark)) files.push(p.watermark);
    if (existsSync(p.outages)) files.push(p.outages);
    const why = commitOnly(root, files, `chore(cycle): ${subject}`);
    if (why) {
      // undo what this run logged, so no line claims an outcome that was not recorded
      truncateTo(p.log, logSize);
      truncateTo(p.seen, seenSize);
      if (oldWm !== null) writeWatermark(root, oldWm);
      else rmSync(p.watermark, { force: true });
      failed("commit", `cannot commit: ${why}`);
      outcome = "degraded";
      writeState();
    }
  }

  const cur = readWatermark(root);
  const n = realInputs().length;
  const code: CheckResult["code"] = outcome === "nothing-new" ? 0 : outcome === "new" ? 10 : 20;
  if (outcome === "nothing-new") {
    const line = `nothing new · ${n} inputs · watermark ${cur}`;
    return { code, outcome, line, output: { check: line } };
  }
  const fl = failedList();
  const line =
    outcome === "degraded"
      ? `degraded · ${fl.length} failed · ${NEW} new · ${n} inputs · watermark ${cur ?? "none"} (not advanced)`
      : `new · ${NEW} new · ${n} inputs · watermark ${cur ?? "none"} (not advanced)`;
  const output: Record<string, unknown> = { check: line };
  if (fl.length) output.failed = fl;
  if (NEW > 0) output.items = items.map((it, i) => renderItem(it, i + 1, NEW, settings.gate_word));
  return { code, outcome, line, output };
}

export function checkCommand(args: string[]): Record<string, unknown> {
  const { flags } = parseArgs(args, { bool: ["no-commit"] }, CHECK_USAGE);
  const root = requireRoot();
  const r = runCheck(root, { commit: !flags["no-commit"] });
  setExit(r.code);
  if (r.code !== 0) {
    r.output.help = [`Work the items, then run \`${cliInvocation()} cycle end --records <n>\`${r.code === 20 ? " (add --degraded when an input could not be read)" : ""}`];
  }
  return r.output;
}

