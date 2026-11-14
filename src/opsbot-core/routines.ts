/**
 * The bot's routines as the loop sees them: its definitions at HEAD plus the kit's built-in
 * routines, each with its state, and what the check, `cycle end`, the cold-start pack and the
 * sleep decision print for them (specs/skills/opsbot-core.md, Routines).
 *
 * Built-in: `memory-review`, while auto memory is on and the bot has no
 * `routines/memory-review.md` of its own. Its state is the memory status's, so the memory
 * feature and the routine can never disagree.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { skillDir } from "./invocation.js";
import { MEMORY_ROUTINE, memoryRuns, memoryStatus } from "./memory.js";
import { humanTime, iso } from "./repo.js";
import { computeState, readDefinitions, readRuns, type Definition, type RoutineState, type Run } from "./routine-store.js";
import type { Settings } from "./settings.js";

export const MEMORY_GUIDE = "references/memory-review.md";

/** The built-in memory review's instructions: the shipped protocol. */
function memoryInstructions(): string {
  const f = join(skillDir(), MEMORY_GUIDE);
  if (!existsSync(f)) return `The memory review protocol: ${f}. Run \`memory review --begin\`, work the worksheet, then \`memory review --done --note "<what was folded where>"\`.`;
  return readFileSync(f, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

export function builtinMemoryRoutine(s: Settings): Definition | null {
  if (!s.memory) return null;
  return {
    id: MEMORY_ROUTINE,
    title: "Review the memory files",
    file: null,
    builtin: true,
    intervalDays: s.memory.review_days,
    schedule: `every ${s.memory.review_days}d (memory.review_days)`,
    at: null,
    days: null,
    since: null,
    active: true,
    owner: null,
    hands_to: null,
    body: memoryInstructions(),
  };
}

export interface Routines {
  states: RoutineState[];
  /** Every problem with a definition or a run record, named. */
  problems: string[];
  /** Definition files in `routines.dir` at HEAD, valid or not. */
  files: number;
}

/** Every routine and its state at `now`. Definitions are read at HEAD unless `head` is false. */
export function loadRoutines(root: string, s: Settings, now: number, opts: { head?: boolean } = {}): Routines {
  const d = readDefinitions(root, s, { head: opts.head });
  const r = readRuns(root, s);
  const problems = [...d.problems, ...r.problems];
  const states: RoutineState[] = [];
  for (const def of d.defs) {
    const runs: Run[] = def.id === MEMORY_ROUTINE ? memoryRuns(root, s, r.runs) : r.runs;
    states.push(computeState(def, runs, now, s.timezone));
  }
  const builtin = builtinMemoryRoutine(s);
  if (builtin && !d.defs.some((x) => x.id === MEMORY_ROUTINE)) {
    const runs = memoryRuns(root, s, r.runs);
    const st = memoryStatus(root, s, now, { runs: r.runs, defs: d.defs })!;
    const last = runs.length ? runs[runs.length - 1]! : null;
    states.push({
      def: builtin,
      runs,
      last,
      due: st.due,
      dueAt: st.due_at,
      next: st.next,
      key: st.due ? `routine:${MEMORY_ROUTINE}:after:${last ? last.at : "never"}` : null,
    });
  }
  return { states, problems, files: d.files };
}

function lastText(st: RoutineState): string {
  return st.last ? `last run ${st.last.at.slice(0, 10)} ${st.last.outcome}` : "never run";
}

/** One heartbeat item per due routine occurrence (specs/skills/opsbot-core.md, Routines). */
export function routineItems(r: Routines, s: Settings, now: number, cli: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const st of r.states) {
    if (!st.due || !st.key) continue;
    const d = st.def;
    const how =
      d.id === MEMORY_ROUTINE && d.builtin
        ? `Run \`${cli} memory review --begin\`, work the worksheet, then \`${cli} memory review --done --note "…"\``
        : `Instructions: \`${cli} routines view ${d.id}\`. Record it with \`${cli} routines done ${d.id} --notes "…"\``;
    const since = st.dueAt !== null ? `, due since ${humanTime(st.dueAt, s.timezone)}` : "";
    out.push({
      key: st.key,
      at: iso(st.dueAt ?? now),
      conv: "routines",
      kind: "routine",
      from: "schedule",
      routine: d.id,
      text: `due: ${d.title} (${d.schedule}${since}; ${lastText(st)}). ${how}`,
    });
  }
  return out;
}

/** The lines `cycle end` and the pack print: one per due routine, the memory review aside
 * while memory is on (it keeps its own `memory` line). */
export function routineDueLines(r: Routines, s: Settings, cli: string): string[] {
  const lines: string[] = [];
  for (const st of r.states) {
    if (!st.due) continue;
    // the memory review keeps its own `memory` line while memory is on
    if (st.def.id === MEMORY_ROUTINE && s.memory) continue;
    const since = st.dueAt !== null ? ` since ${humanTime(st.dueAt, s.timezone)}` : "";
    lines.push(`${st.def.id} due${since} (${st.def.schedule}; ${lastText(st)}): ${st.def.title} · \`${cli} routines view ${st.def.id}\``);
  }
  return lines;
}

/** For the sleep decision: when each routine that is not due now next becomes due. */
export function routineNextTimes(r: Routines): Array<{ at: string; what: string }> {
  return r.states
    .filter((st) => !st.due && st.next !== null)
    .map((st) => ({ at: iso(st.next!), what: `routine ${st.def.id}: ${st.def.title}` }));
}
