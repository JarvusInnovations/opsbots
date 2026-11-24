/**
 * Begin-hook times and skipping a hook (specs/skills/opsbot-core.md, Hook times and skipping a
 * hook; plans/cycle-hook-times.md).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cli, git, logOf, makeBot, makeExecutable, writeStream, type Bot } from "./helpers";
import { recordHookTimes } from "../src/opsbot-core/hooktimes";

setDefaultTimeout(240_000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const B = "opsbot/log";
/** The script limit in these tests, so 60% of it is 1.8 s. */
const LIMIT = { OPSBOT_TEST_SCRIPT_TIMEOUT_MS: "3000" };
const at = (min: number) => new Date(Date.parse("2026-03-02T15:00:00Z") + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const lockFile = (b: Bot) => join(b.root, ".git", "opsbot-cycle.lock");

/** A bot with two begin scripts: 10-slow sleeps $SLOW_SECS, 20-broken fails when $BROKEN is set. */
function hookBot(): Bot {
  const b = makeBot({ points: ["heartbeat.d"] });
  const dir = join(b.root, "opsbot.d", "cycle.d", "begin");
  mkdirSync(dir, { recursive: true });
  makeExecutable(join(dir, "10-slow"), '#!/usr/bin/env bash\nsleep "${SLOW_SECS:-0}"\n');
  makeExecutable(join(dir, "20-broken"), '#!/usr/bin/env bash\nif [ -n "${BROKEN:-}" ]; then echo "the cache is gone" >&2; exit 3; fi\n');
  git(b.root, "add", "opsbot.d");
  git(b.root, "commit", "-q", "-m", "begin scripts");
  return b;
}

/** The log branch tip's trailers. */
function tipTrailers(root: string): Record<string, string> {
  const r = spawnSync("git", ["-C", root, "log", "-1", "--format=%(trailers:only,unfold)", B], { encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const l of r.stdout.split("\n")) {
    const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function begin(min: number, args: string[] = [], env: Record<string, string> = {}) {
  return cli(bot, ["cycle", "begin", ...args], { now: at(min), env: { ...LIMIT, ...env } });
}

describe("cycle begin --skip-hook", () => {
  test("a name that is not installed is refused before the lock, naming the installed ones", () => {
    bot = hookBot();
    const r = begin(0, ["--skip-hook", "30-nope"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--skip-hook 30-nope: no such script in cycle.d/begin/");
    expect(r.out).toContain("installed: 10-slow, 20-broken");
    expect(existsSync(lockFile(bot))).toBe(false);
  });

  test("a broken script skipped: the cycle runs, says so, and records it; the next cycle runs it again", () => {
    bot = hookBot();
    bot.env.BROKEN = "1";
    const broken = begin(0);
    expect(broken.code).toBe(20);
    expect(broken.out).toContain("cycle.d/begin/20-broken failed, so the check did not run · exit 3: the cache is gone");
    // the failure's line carries the times so far
    expect(Object.keys((logOf(bot).at(-1)!.hooks ?? {}) as object)).toEqual(["10-slow", "20-broken"]);
    expect(cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: at(1) }).code).toBe(0);

    const skipped = begin(10, ["--skip-hook", "20-broken"]);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain("nothing new");
    expect(skipped.out).toContain("· skipped cycle.d/begin/20-broken");
    // a record of its own even though nothing was new: never folded into a quiet run
    expect(tipTrailers(bot.root)["Quiet-Cycles"]).toBeUndefined();
    const rec = logOf(bot).at(-1)!;
    expect(rec).toMatchObject({ outcome: "nothing-new", skipped_hooks: ["20-broken"] });
    expect(Object.keys(rec.hooks as object)).toEqual(["10-slow"]);
    expect(existsSync(lockFile(bot))).toBe(false);

    // one cycle only: without the flag it runs again, and fails again
    expect(begin(20).code).toBe(20);
    expect(cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: at(21) }).code).toBe(0);
  });

  test("repeatable, and said on a cycle that found something", () => {
    bot = hookBot();
    writeStream(bot, [{ key: "chat:c:1", at: at(-1), conv: "c", kind: "group", from: "p", text: "hi" }]);
    const r = begin(0, ["--skip-hook", "20-broken", "--skip-hook", "10-slow"], { BROKEN: "1" });
    expect(r.code).toBe(10);
    expect(r.out).toContain("· skipped cycle.d/begin/20-broken, cycle.d/begin/10-slow");
    const rec = logOf(bot).find((l) => l.outcome === "new")!;
    expect(rec.skipped_hooks).toEqual(["20-broken", "10-slow"]);
    expect(rec.hooks).toBeUndefined();
  });
});

describe("begin-hook times", () => {
  test("each cycle's record carries every script's time; a quiet run carries its newest in Hook-Times", () => {
    bot = hookBot();
    expect(begin(0).code).toBe(0);
    expect(tipTrailers(bot.root)["Hook-Times"]).toMatch(/^10-slow=\d+(\.\d)?, 20-broken=\d+(\.\d)?$/);
    writeStream(bot, [{ key: "chat:c:1", at: at(4), conv: "c", kind: "group", from: "p", text: "hi" }]);
    expect(begin(5).code).toBe(10);
    const rec = logOf(bot).find((l) => l.outcome === "new")!;
    expect(Object.keys(rec.hooks as object)).toEqual(["10-slow", "20-broken"]);
    expect(Object.values(rec.hooks as object).every((s) => typeof s === "number" && s >= 0)).toBe(true);
  });

  test("slow on three cycles in a row is one item naming the script and its times; a recovery starts over", () => {
    bot = hookBot();
    const SLOW = { SLOW_SECS: "2.2" };
    const quietOr = (min: number, a: Record<string, string> | string[] = SLOW) => {
      const r = Array.isArray(a) ? begin(min, a, SLOW) : begin(min, [], a);
      if (r.code === 10) expect(cli(bot, ["cycle", "end", "--records", "0"], { now: at(min + 1) }).code).toBe(0);
      return r;
    };
    expect(quietOr(0).out).not.toContain("hook-times");
    expect(quietOr(10).out).not.toContain("hook-times");
    const third = quietOr(20);
    expect(third.code).toBe(10);
    expect(third.out).toContain("cycle.d/begin/10-slow took");
    expect(third.out).toMatch(/took 2\.\d s, 2\.\d s and 2\.\d s on the last 3 cycles, each over 60% of the 3 s limit/);
    expect(third.out).toContain("cycle begin --skip-hook 10-slow");
    // still slow: the same run, not reported again
    expect(quietOr(30).code).toBe(0);
    // a cycle that does not run it (skipped here; a fast cycle likewise) ends nothing
    expect(quietOr(35, ["--skip-hook", "10-slow"]).code).toBe(0);
    expect(quietOr(38).code).toBe(0);
    // one under 60% ends the run; three more slow ones are a new one
    expect(quietOr(40, {}).code).toBe(0);
    expect(quietOr(50).code).toBe(0);
    expect(quietOr(60).code).toBe(0);
    const again = quietOr(70);
    expect(again.code).toBe(10);
    expect(again.out).toContain("cycle.d/begin/10-slow took");
  });
});

describe("the slow-run rule", () => {
  test("three slow in a row, an untimed cycle between them ending nothing, one item per run", () => {
    bot = makeBot();
    const cmd = (n: string) => `skip ${n}`;
    const rec = (min: number, times: Record<string, number>) => recordHookTimes(bot.root, times, at(min), 300_000, cmd);
    expect(rec(0, { a: 200, b: 1 })).toEqual([]);
    expect(rec(1, { a: 190 })).toEqual([]);
    expect(rec(2, {})).toEqual([]);
    const items = rec(3, { a: 181, b: 2 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: `hook-times:a:${at(0)}`, kind: "hook-times", from: "opsbot-core" });
    expect(items[0]!.text).toContain("cycle.d/begin/a took 200 s, 190 s and 181 s on the last 3 cycles, each over 60% of the 300 s limit");
    // same run: the same key, which the check's seen keys drop
    expect(rec(4, { a: 250 })[0]!.key).toBe(`hook-times:a:${at(0)}`);
    // exactly 60% is not over; the run ends and a new one is keyed by its own start
    expect(rec(5, { a: 180 })).toEqual([]);
    rec(6, { a: 200 });
    rec(7, { a: 200 });
    expect(rec(8, { a: 200 })[0]!.key).toBe(`hook-times:a:${at(6)}`);
  });
});
