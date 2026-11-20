/**
 * `wake backstop`: the listeners' one wake routine, driven directly. The runtime is the
 * file-backed fake (each prompt typed is a line in <file>.prompts), and a 50 ms tick makes a
 * grace of 10 half a second. These are the cases the Slack and WhatsApp listeners' own wake
 * tests covered before the routine moved into the core.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { cli, cliAsync, makeBot, stageLog, type Bot, type Ran } from "./helpers";

setDefaultTimeout(120000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const KEY = "slack:D0EXAMPLE:1700000000.000101:msg";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(runtime: Record<string, unknown> = { status: "idle", pane: "p1" }, env: Record<string, string> = {}): string {
  bot = makeBot();
  const f = join(bot.home, "runtime.json");
  writeFileSync(f, JSON.stringify(runtime));
  Object.assign(bot.env, { OPSBOT_RUNTIME_FAKE: f, OPSBOT_WAKE_TICK_MS: "50" }, env);
  return f;
}
const prompts = (f: string) => (existsSync(`${f}.prompts`) ? readFileSync(`${f}.prompts`, "utf8").split("\n").filter(Boolean) : []);
const run = (grace: number, extra: string[] = []) =>
  cliAsync(bot, ["wake", "backstop", "--key", KEY, "--at", new Date().toISOString(), "--grace", String(grace), "--reason", "slack message", ...extra]);
const line = (r: Ran) => {
  const m = /^backstop: "?(.*?)"?$/m.exec(r.out);
  return m ? m[1]! : `(no line in ${JSON.stringify(r.out)})`;
};
const seen = () => stageLog(bot, { seen: [KEY] });
const future = () => new Date(Date.now() + 60000).toISOString().slice(0, 19) + "Z";
const cycleLine = (at: string, outcome = "new") => stageLog(bot, { cycles: [{ at, outcome }] });
const gitFile = (name: string, body = "{}") => writeFileSync(join(bot.root, ".git", name), body);

describe("wake backstop", () => {
  test("the key seen in the grace: no nudge, one line says the monitor woke it, exit 0", async () => {
    const f = setup();
    seen();
    const r = await run(10);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(line(r)).toBe("woken by monitor");
    expect(prompts(f)).toEqual([]);
  });

  test("a check begun after the event (a newer check line): no nudge; a newer finish line does not count", async () => {
    const f = setup();
    cycleLine("2020-01-01T00:00:00Z", "finished");
    cycleLine(future());
    const r = await run(10);
    expect(line(r)).toBe("woken by monitor");
    expect(prompts(f)).toEqual([]);
    bot.cleanup();

    const g = setup();
    cycleLine("2020-01-01T00:00:00Z");
    cycleLine(future(), "finished");
    const s = await run(4);
    expect(line(s)).toMatch(/^nudged after \d+s$/);
    expect(prompts(g)).toHaveLength(1);
  });

  test("a cycle already running: no nudge while it holds the lock; when it ends unseen, a nudge at once, after the cycle", async () => {
    const f = setup();
    gitFile("opsbot-cycle.lock");
    const p = run(600);
    await sleep(2000); // well past a short grace; the wait for the cycle counts against nothing
    expect(prompts(f)).toEqual([]);
    rmSync(join(bot.root, ".git", "opsbot-cycle.lock"));
    const r = await p;
    expect(line(r)).toBe("nudged after cycle");
    expect(r.err).toContain("a cycle is running: waiting for it to end");
    expect(prompts(f)).toHaveLength(1);
  });

  test("the cycle ends with the key seen, or with a newer check line: no nudge", async () => {
    const f = setup();
    gitFile("opsbot-cycle.lock");
    const p = run(600);
    await sleep(1500);
    seen();
    rmSync(join(bot.root, ".git", "opsbot-cycle.lock"));
    const r = await p;
    expect(line(r)).toBe("woken by monitor");
    expect(r.err).toContain("a cycle is running: waiting for it to end");
    expect(prompts(f)).toEqual([]);
    bot.cleanup();

    const g = setup();
    gitFile("opsbot-cycle.lock");
    const q = run(600);
    await sleep(1500);
    cycleLine(future());
    rmSync(join(bot.root, ".git", "opsbot-cycle.lock"));
    const s = await q;
    expect(line(s)).toBe("woken by monitor");
    expect(prompts(g)).toEqual([]);
  });

  test("the grace expires with neither: it nudges, and says after how long", async () => {
    const f = setup();
    cycleLine("2020-01-01T00:00:00Z", "finished");
    const r = await run(4);
    expect(line(r)).toMatch(/^nudged after \d+s$/);
    expect(prompts(f)).toHaveLength(1);
  });

  test("asleep: no wait, however long the grace", async () => {
    const f = setup();
    gitFile("opsbot-sleep");
    const t = Date.now();
    const r = await run(600);
    expect(line(r)).toBe("asleep: nudged");
    expect(r.err).toContain("asleep: nudging at once");
    expect(prompts(f)).toHaveLength(1);
    expect(Date.now() - t).toBeLessThan(25000);
  });

  test("grace 0 nudges at once", async () => {
    const f = setup();
    const r = await run(0);
    expect(line(r)).toMatch(/^nudged after \d+s$/);
    expect(prompts(f)).toHaveLength(1);
  });

  test("a burst: three at once share one nudge through the nudge's claim; the rest are already woken", async () => {
    const f = setup();
    const rs = await Promise.all([run(0), run(0), run(0)]);
    expect(prompts(f)).toHaveLength(1);
    const lines = rs.map(line).sort();
    expect(lines.filter((l) => l === "already woken")).toHaveLength(2);
    expect(lines.filter((l) => /^nudged after \d+s$/.test(l))).toHaveLength(1);
  });

  test("a cooldown outcome (another wake typed the prompt moments ago) is 'already woken', and ends it", async () => {
    const f = setup();
    gitFile("opsbot-nudge-now", `${Math.floor(Date.now() / 1000)}\nwhatsapp\n`);
    const r = await run(0);
    expect(line(r)).toBe("already woken");
    expect(prompts(f)).toEqual([]);
  });

  test("a refusal (mid-turn) keeps it waiting, noted once, until the key is seen", async () => {
    const f = setup({ status: "working", pane: "p1" });
    const p = run(0);
    await sleep(2500); // a nudge every 10 ticks (500 ms) while it is refused
    seen();
    const r = await p;
    expect(line(r)).toBe("woken by monitor");
    expect(r.err.match(/nudge pending:/g)).toHaveLength(1);
    expect(r.err).toContain("mid-turn");
    expect(prompts(f)).toEqual([]);
  });

  test("the limit (30 minutes; shortened here): it gives up, exit 0", async () => {
    const f = setup({ status: "working", pane: "p1" }, { OPSBOT_WAKE_LIMIT_MS: "1200" });
    const r = await run(0);
    expect(r.code).toBe(0);
    expect(line(r)).toBe("gave up");
    expect(prompts(f)).toEqual([]);
  });

  test("a runtime that cannot be reached is a refusal like any other, never exit 1", async () => {
    setup({ error: { code: "agent_not_found", message: "no agent" } }, { OPSBOT_WAKE_LIMIT_MS: "800" });
    const r = await run(0);
    expect(r.code).toBe(0);
    expect(line(r)).toBe("gave up");
    expect(r.err).toContain("nudge pending: cannot");
  });

  test("usage: a missing key, time or reason, or a bad grace, is exit 2", () => {
    setup();
    const at = new Date().toISOString();
    for (const args of [
      ["--at", at, "--reason", "x"],
      ["--key", KEY, "--reason", "x"],
      ["--key", KEY, "--at", "yesterday", "--reason", "x"],
      ["--key", KEY, "--at", at],
      ["--key", KEY, "--at", at, "--reason", "x", "--grace", "-1"],
      ["--key", KEY, "--at", at, "--reason", "x", "--grace", "1.5"],
    ]) {
      const r = cli(bot, ["wake", "backstop", ...args]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("wake backstop --key");
    }
  });
});
