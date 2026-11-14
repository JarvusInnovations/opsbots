/**
 * routines — recurring work, due by schedule, every run recorded (specs/skills/opsbot-core.md,
 * Routines).
 *
 *   routines | routines due [--all]     what is due now; --all every routine with its state
 *   routines view <id>                  the schedule, the state and the instructions
 *   routines history <id>               the runs, with the stretches longer than the schedule
 *   routines done <id> --notes TEXT [--outcome done|partial|skipped|blocked] [--checked ITEM]...
 *                 [--handed-to WHO] [--at ISO]
 *                                       record one run; committed with the next cycle
 *   routines validate [--head]          every problem in the definitions and the run records
 *
 * No command here writes to the definitions directory: a definition is the bot's program and
 * changes through review, like the rule card.
 */
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit, usageError } from "../args.js";
import { cliInvocation } from "../invocation.js";
import { humanTime, iso, nowMs, parseIso, requireRoot } from "../repo.js";
import { DAY, OUTCOMES, instantOf, readDefinitions, readRuns, sinceMs, writeRun, zonedParts, type RoutineState } from "../routine-store.js";
import { MEMORY_ROUTINE } from "../memory.js";
import { loadRoutines } from "../routines.js";
import { loadSettings, trySettings, type Settings } from "../settings.js";

export const ROUTINES_USAGE =
  "routines [due [--all]] | routines view <id> | routines history <id> | routines done <id> --notes TEXT [--outcome done|partial|skipped|blocked] [--checked ITEM]... [--handed-to WHO] [--at ISO] | routines validate [--head]";

function settingsFor(root: string): Settings {
  // the committed settings when they validate; the working tree's otherwise (a new bot)
  try {
    return loadSettings(root).settings;
  } catch (e) {
    const s = trySettings(root);
    if (s) return s;
    throw e;
  }
}

export function routinesCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "due" || sub.startsWith("--")) return due(sub === "due" ? rest : args);
  if (sub === "view") return view(rest);
  if (sub === "history") return history(rest);
  if (sub === "done") return done(rest);
  if (sub === "validate") return validate(rest);
  throw usageError(`unknown routines subcommand ${sub}`, ROUTINES_USAGE);
}

const when = (ms: number | null, s: Settings) => (ms === null ? "-" : humanTime(ms, s.timezone));

function stateWord(st: RoutineState): string {
  if (!st.def.active) return "inactive";
  return st.due ? "due" : "ok";
}

function find(states: RoutineState[], id: string | undefined, usage: string): RoutineState {
  if (!id) throw usageError("give the routine's id", usage);
  const st = states.find((x) => x.def.id === id);
  if (!st) {
    setExit(1);
    throw new AxiError(`no routine ${id}`, "NOT_FOUND", [`Run \`${cliInvocation()} routines due --all\` to list them`]);
  }
  return st;
}

function due(args: string[]): Record<string, unknown> {
  const { flags } = parseArgs(args, { bool: ["all"] }, "routines due [--all]");
  const root = requireRoot();
  const s = settingsFor(root);
  const now = nowMs();
  const r = loadRoutines(root, s, now);
  const cli = cliInvocation();
  setExit(r.problems.length ? 1 : 0);
  const out: Record<string, unknown> = {};
  if (flags.all) {
    out.routines = r.states.length
      ? r.states.map((st) => ({
          id: st.def.id,
          schedule: st.def.schedule,
          state: stateWord(st),
          last_run: st.last ? `${st.last.at.slice(0, 10)} ${st.last.outcome}` : "never",
          next: st.due ? "now" : when(st.next, s),
          source: st.def.file ?? "built-in",
        }))
      : `none · no definitions in ${s.routines.dir}/`;
  } else {
    const dueNow = r.states.filter((st) => st.due);
    if (dueNow.length === 0) {
      const upcoming = r.states.filter((st) => st.next !== null).sort((a, b) => a.next! - b.next!)[0];
      out.due = `nothing due · ${r.states.length} routine${r.states.length === 1 ? "" : "s"}${upcoming ? ` · next ${upcoming.def.id} at ${when(upcoming.next, s)}` : ""}`;
    } else {
      out.due = dueNow.map((st) => ({
        id: st.def.id,
        title: st.def.title,
        schedule: st.def.schedule,
        since: st.dueAt === null ? "never run" : when(st.dueAt, s),
        last_run: st.last ? `${st.last.at.slice(0, 10)} ${st.last.outcome}` : "never",
      }));
      out.help = [`Read one with \`${cli} routines view <id>\`, do it, then \`${cli} routines done <id> --notes "…"\``];
    }
  }
  if (r.problems.length) {
    out.problems = r.problems;
    out.help = [`A definition changes through review, like the rule card; \`${cli} routines validate\` checks a fix`];
  }
  return out;
}

/** Paragraphs and list items of a markdown body, one entry each, wrapped lines joined. */
function paragraphs(text: string): string[] {
  const items: string[] = [];
  let cur: string | null = null;
  let fence = false;
  for (const line of text.split("\n")) {
    const t = line.trimEnd();
    if (t.trim().startsWith("```")) fence = !fence;
    if (fence || t.trim().startsWith("```")) {
      if (cur !== null) items.push(cur);
      cur = null;
      items.push(t);
      continue;
    }
    if (!t.trim()) {
      if (cur !== null) items.push(cur);
      cur = null;
      continue;
    }
    const s = t.trim();
    if (cur === null || /^([-*+]|\d+\.)\s/.test(s) || s.startsWith("#") || s.startsWith("|")) {
      if (cur !== null) items.push(cur);
      cur = s;
      if (s.startsWith("#") || s.startsWith("|")) {
        items.push(cur);
        cur = null;
      }
    } else cur += ` ${s}`;
  }
  if (cur !== null) items.push(cur);
  return items;
}

function view(args: string[]): Record<string, unknown> {
  const usage = "routines view <id>";
  const { positionals } = parseArgs(args, { maxPositionals: 1 }, usage);
  const root = requireRoot();
  const s = settingsFor(root);
  const now = nowMs();
  const r = loadRoutines(root, s, now);
  const st = find(r.states, positionals[0], usage);
  const d = st.def;
  const cli = cliInvocation();
  setExit(0);
  const out: Record<string, unknown> = {
    routine: `${d.id} · ${d.title}`,
    schedule: `${d.schedule}${d.since ? ` · since ${d.since}` : ""}${d.at ? ` · ${s.timezone}` : ""}`,
    source: d.file ? `${d.file} at HEAD` : "built-in (the kit's)",
    state: !d.active
      ? "inactive"
      : st.due
        ? `due${st.dueAt !== null ? ` since ${when(st.dueAt, s)}` : ""}`
        : `ok · next due ${when(st.next, s)}`,
    last_run: st.last ? `${st.last.at} ${st.last.outcome}${st.last.notes ? ` · ${st.last.notes.split("\n")[0]!.slice(0, 120)}` : ""}` : "never",
  };
  if (d.owner) out.owner = d.owner;
  if (d.hands_to) out.hands_to = d.hands_to;
  out.instructions = d.body.trim() ? paragraphs(d.body) : "(the definition has no body: say so to the operator)";
  out.help =
    d.builtin && d.id === MEMORY_ROUTINE
      ? [`Run \`${cli} memory review --begin\`, then \`${cli} memory review --done --note "<what was folded where>"\``]
      : [`When it is done: \`${cli} routines done ${d.id} --notes "<what was found, changed, left>"\``];
  return out;
}

/** How many slots fall in (from, to]. */
function slotsBetween(st: RoutineState, from: number, to: number, tz: string): number {
  const d = st.def;
  if (!d.at || !d.days) return 0;
  const [h, mi] = d.at.split(":").map(Number);
  let n = 0;
  const p = zonedParts(from, tz);
  for (let off = 0; off <= 400; off++) {
    const probe = new Date(Date.UTC(p.y, p.m - 1, p.d + off, 12));
    const dow = probe.getUTCDay() || 7;
    const slot = instantOf(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), h!, mi!, tz);
    if (slot > to) break;
    if (slot > from && d.days.includes(dow)) n++;
  }
  return n;
}

function history(args: string[]): Record<string, unknown> {
  const usage = "routines history <id>";
  const { positionals } = parseArgs(args, { maxPositionals: 1 }, usage);
  const root = requireRoot();
  const s = settingsFor(root);
  const now = nowMs();
  const r = loadRoutines(root, s, now);
  const st = find(r.states, positionals[0], usage);
  const d = st.def;
  setExit(0);
  let prev = sinceMs(d.since, s.timezone);
  const rows = st.runs.map((run) => {
    const gap = prev === null ? null : run.atMs - prev;
    let missed = "";
    if (gap !== null) {
      if (d.intervalDays !== null && Math.floor(gap / DAY) > d.intervalDays) missed = "missed stretch";
      else if (d.at) {
        const k = slotsBetween(st, prev!, run.atMs, s.timezone) - 1;
        if (k > 0) missed = `${k} slot${k === 1 ? "" : "s"} missed`;
      }
    }
    prev = run.atMs;
    return {
      at: run.at,
      outcome: run.outcome,
      gap_days: gap === null ? "-" : Math.floor(gap / DAY),
      missed,
      handed_to: run.handed_to ?? "",
      notes: run.notes.split("\n")[0]!.slice(0, 100),
    };
  });
  const since = st.last ? `${Math.floor((now - st.last.atMs) / DAY)} days since the last run` : "never run";
  return {
    routine: `${d.id} · ${d.schedule}${d.active ? "" : " · inactive"} · ${st.runs.length} run${st.runs.length === 1 ? "" : "s"}`,
    runs: rows.length ? rows : "none recorded",
    now: `${since}; ${!d.active ? "inactive" : st.due ? "due" : `not due, next ${when(st.next, s)}`}`,
  };
}

/** `--checked` may repeat: every value, in order, and the arguments without them. */
function takeRepeated(args: string[], name: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw usageError(`--${name} needs a value`, ROUTINES_USAGE);
      values.push(v);
      i++;
    } else if (a.startsWith(`--${name}=`)) values.push(a.slice(name.length + 3));
    else rest.push(a);
  }
  return { values, rest };
}

function done(args: string[]): Record<string, unknown> {
  const usage = "routines done <id> --notes TEXT [--outcome done|partial|skipped|blocked] [--checked ITEM]... [--handed-to WHO] [--at ISO]";
  const { values: checked, rest } = takeRepeated(args, "checked");
  const { positionals, flags } = parseArgs(rest, { value: ["notes", "outcome", "handed-to", "at"], maxPositionals: 1 }, usage);
  const notes = typeof flags.notes === "string" ? flags.notes.trim() : "";
  if (!notes) throw usageError("--notes is required: what was found, what was changed, what was left (a skip says why)", usage);
  const outcome = typeof flags.outcome === "string" ? flags.outcome : "done";
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw usageError(`--outcome must be one of ${OUTCOMES.join(", ")}`, usage);
  const root = requireRoot();
  const s = settingsFor(root);
  const now = nowMs();
  let atMs = now;
  if (typeof flags.at === "string") {
    const t = parseIso(flags.at);
    if (t === null) throw usageError(`--at ${JSON.stringify(flags.at)} is not an ISO time`, usage);
    if (t > now + 60_000) {
      setExit(1);
      throw new AxiError(`refused: --at ${flags.at} is later than the clock, ${iso(now)}`, "REFUSED", ["A run is recorded when it happened, never ahead"]);
    }
    atMs = t;
  }
  const r = loadRoutines(root, s, now);
  const st = find(r.states, positionals[0], usage);
  if (!st.def.active) {
    setExit(1);
    throw new AxiError(`refused: ${st.def.id} is inactive`, "REFUSED", ["An inactive routine is turned back on in its definition, through review"]);
  }
  const handed = typeof flags["handed-to"] === "string" ? flags["handed-to"].trim() : "";
  const run = writeRun(root, s, { routine: st.def.id, title: st.def.title, atMs, outcome, by: s.name, notes, checked, handed_to: handed || null });
  const after = loadRoutines(root, s, now).states.find((x) => x.def.id === st.def.id)!;
  setExit(0);
  return {
    recorded: `${run.id} · ${outcome} · ${run.file}`,
    next: after.due ? "still due: a run before the latest slot does not satisfy it" : `due again ${when(after.next, s)}`,
    help: ["The next cycle commits the run with its own files"],
  };
}

function validate(args: string[]): Record<string, unknown> {
  const { flags } = parseArgs(args, { bool: ["head"] }, "routines validate [--head]");
  const root = requireRoot();
  const s = settingsFor(root);
  const d = readDefinitions(root, s, { head: flags.head === true });
  const runs = readRuns(root, s);
  const where = `${s.routines.dir}/${flags.head ? " at HEAD" : ""}`;
  const problems = [...d.problems, ...runs.problems];
  if (problems.length) {
    setExit(1);
    return { routines: `invalid · ${where} · ${problems.length} problem${problems.length === 1 ? "" : "s"}`, problems };
  }
  setExit(0);
  return { routines: `valid · ${where} · ${d.defs.length} definition${d.defs.length === 1 ? "" : "s"} · ${runs.runs.length} run${runs.runs.length === 1 ? "" : "s"}` };
}

/** The problems `settings validate` adds: the definitions, read as `settings validate` reads. */
export function routineProblems(root: string, s: Settings, head: boolean): string[] {
  return readDefinitions(root, s, { head }).problems;
}
