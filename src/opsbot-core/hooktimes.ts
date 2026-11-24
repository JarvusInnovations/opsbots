/**
 * Begin-hook times (specs/skills/opsbot-core.md, Hook times and skipping a hook).
 *
 * `cycle begin` times each `cycle.d/begin/` script it runs. The last three times of each, and when
 * its current run over 60% of the script limit began, are kept in the git directory:
 *
 *   .git/opsbot-hook-times.json   {<name>: {times: [{at, s}, …3], slow_since: <ISO> | null}}
 *
 * A script whose last three times each passed 60% of the limit is one heartbeat item, keyed by
 * when that run began, so a run is reported once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gitPath } from "./repo.js";

export const HOOK_TIMES = "opsbot-hook-times.json";
/** The share of the script limit past which a time counts as slow. */
export const SLOW_SHARE = 0.6;
/** How many slow cycles in a row make an item. */
export const SLOW_RUN = 3;

interface Entry {
  times: Array<{ at: string; s: number }>;
  slow_since: string | null;
}

export type HookItem = {
  key: string;
  at: string;
  conv: string;
  kind: string;
  from: string;
  text: string;
};

/** Seconds to one decimal. */
export const seconds = (ms: number): number => Math.round(ms / 100) / 10;

function read(root: string): Record<string, Entry> {
  try {
    const v = JSON.parse(readFileSync(gitPath(root, HOOK_TIMES), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

/** The `Hook-Times` trailer's value: `<name>=<seconds>, …` in run order. */
export function hookTimesTrailer(times: Record<string, number>): string {
  return Object.entries(times)
    .map(([n, s]) => `${n}=${s}`)
    .join(", ");
}

/**
 * Records this cycle's times and returns the items for scripts slow on the last three cycles in
 * a row. A script not timed this cycle (skipped, or not run by a fast cycle) is left as it was.
 */
export function recordHookTimes(root: string, times: Record<string, number>, at: string, limitMs: number, skipCommand: (name: string) => string): HookItem[] {
  if (Object.keys(times).length === 0) return [];
  const state = read(root);
  const limit = seconds(limitMs);
  const over = (s: number) => s * 1000 > limitMs * SLOW_SHARE;
  const items: HookItem[] = [];
  for (const [name, s] of Object.entries(times)) {
    const e: Entry = state[name] ?? { times: [], slow_since: null };
    e.times = [...(e.times ?? []), { at, s }].slice(-SLOW_RUN);
    e.slow_since = over(s) ? (e.slow_since ?? at) : null;
    state[name] = e;
    if (e.slow_since && e.times.length === SLOW_RUN && e.times.every((t) => over(t.s))) {
      const list = e.times.map((t) => `${t.s} s`);
      items.push({
        key: `hook-times:${name}:${e.slow_since}`,
        at,
        conv: "cycle.d/begin",
        kind: "hook-times",
        from: "opsbot-core",
        text: `cycle.d/begin/${name} took ${list.slice(0, -1).join(", ")} and ${list.at(-1)} on the last ${SLOW_RUN} cycles, each over ${Math.round(SLOW_SHARE * 100)}% of the ${limit} s limit for one script; past the limit it stops the cycle. Make it faster, or run ${skipCommand(name)} while it is fixed`,
      });
    }
  }
  writeFileSync(gitPath(root, HOOK_TIMES), `${JSON.stringify(state)}\n`);
  return items;
}
