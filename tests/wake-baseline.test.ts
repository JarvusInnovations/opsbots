/**
 * The wake's baseline is the count taken at `cycle begin` (specs/skills/opsbot-core.md, The live
 * wake and Sleep; plans/wake-baseline.md). A line written to a wake file after the cycle began,
 * but before anything is armed, wakes the session at once on every path that waits on it: the
 * schedule monitor (`wake wait`), the per-file monitor, and the sleep timer.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SETTINGS, ENTRY, cli, makeBot, makeExecutable, setSettings, type Bot } from "./helpers";
import { readWakeBase } from "../src/opsbot-core/wake";

setDefaultTimeout(60000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const MON_LOOP = { prompt: "testbot cycle: follow the opsbot-core skill, start with cycle begin", autocompact: "300k", schedule: "monitor" };

/** Run a command; resolve with its stdout, exit code (null: killed while still waiting) and time. */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; limitMs: number }): Promise<{ out: string; code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("OPSBOT_") && !k.startsWith("CLAUDE")) env[k] = v;
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...env, ...(opts.env ?? {}) } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), opts.limitMs);
    p.on("close", (code) => {
      clearTimeout(kill);
      resolve({ out, code, ms: Date.now() - t0 });
    });
  });
}

const nowS = () => Math.floor(Date.now() / 1000);

/** A bot with one wake file holding two lines. */
function wakeBot(loop?: Record<string, unknown>): string {
  bot = makeBot({ settings: BASE_SETTINGS });
  const dir = join(bot.home, "wake");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "events.jsonl");
  writeFileSync(f, "one\ntwo\n");
  setSettings(bot, loop ? { loop, wake: { files: [f] } } : { wake: { files: [f] } });
  return f;
}

/** The per-file monitor command `cycle begin` printed, exactly as the session would arm it. */
function printedMonitor(out: string): string {
  const line = out.split("\n").find((l) => l.startsWith("wake[1]: "));
  expect(line).toBeDefined();
  const text = JSON.parse(line!.slice("wake[1]: ".length)) as string;
  const m = text.match(/Monitor\(\{ command: (".*?"), description:/);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]!) as string;
}

/** The schedule monitor's `wake wait --until <s>` that `cycle begin` printed, run as the session's Monitor runs it. */
function printedWakeWait(out: string): number {
  const m = out.match(/wake wait --until (\d+)/);
  expect(m).not.toBeNull();
  return Number(m![1]);
}
const wakeWait = (until: number, limitMs: number) => run(process.execPath, [ENTRY, "wake", "wait", "--until", String(until)], { cwd: bot.root, env: bot.env, limitMs });

describe("a line written between cycle begin and arming fires the monitor at once", () => {
  test("the schedule monitor", async () => {
    const f = wakeBot(MON_LOOP);
    const b = cli(bot, ["cycle", "begin"]);
    expect(b.code).toBe(0);
    expect(readWakeBase(bot.root)).toEqual({ [f]: 2 });
    const until = printedWakeWait(b.out);
    appendFileSync(f, "landed before the monitor was armed\n");
    const r = await wakeWait(until, 20_000);
    expect(r.code).toBe(0);
    expect(r.out).toBe("events.jsonl: landed before the monitor was armed\n");
    expect(r.ms).toBeLessThan(10_000); // no deadline wait, no poll interval first beyond a cold start
  });

  test("the per-file monitor", async () => {
    const f = wakeBot();
    const b = cli(bot, ["cycle", "begin"]);
    expect(b.code).toBe(0);
    const cmd = printedMonitor(b.out);
    expect(cmd).toContain("n=2;");
    appendFileSync(f, "landed before the monitor was armed\n");
    const r = await run("bash", ["-c", cmd], { limitMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.out).toBe("landed before the monitor was armed\n");
    expect(r.ms).toBeLessThan(1_500);
  });

  test("a file rotated since cycle begin is delivered from its start: the schedule monitor", async () => {
    const f = wakeBot(MON_LOOP);
    const until = printedWakeWait(cli(bot, ["cycle", "begin"]).out);
    writeFileSync(f, "after rotation\n"); // 1 line, fewer than the 2 recorded
    expect((await wakeWait(until, 20_000)).out).toBe("events.jsonl: after rotation\n");
  });

  test("a file rotated since cycle begin is delivered from its start: the per-file monitor", async () => {
    const f = wakeBot();
    const cmd = printedMonitor(cli(bot, ["cycle", "begin"]).out);
    writeFileSync(f, "rotated\n");
    const r = await run("bash", ["-c", cmd], { limitMs: 10_000 });
    expect(r.out).toBe("rotated\n");
  });

  test("nothing new since cycle begin: the schedule monitor waits for its time", async () => {
    wakeBot(MON_LOOP);
    expect(cli(bot, ["cycle", "begin"]).code).toBe(0);
    const r = await wakeWait(nowS() + 4, 30_000);
    expect(r.out).toBe("cycle due\n");
    expect(r.ms).toBeGreaterThanOrEqual(2_500);
  });

  test("nothing new since cycle begin: the per-file monitor does not fire", async () => {
    wakeBot();
    const cmd = printedMonitor(cli(bot, ["cycle", "begin"]).out);
    const p = await run("bash", ["-c", cmd], { limitMs: 3_000 });
    expect(p.code).toBeNull(); // still waiting when killed
    expect(p.out).toBe("");
  });
});

describe("a line written while a quiet cycle begin's check runs wakes the sleep it decides", () => {
  const T0 = "2026-03-02T15:00:00Z";
  const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  test("the sleep's wake counts are the ones the check started from, and the timer wakes on the line", () => {
    bot = makeBot({ settings: BASE_SETTINGS, points: ["heartbeat.d", "escalate.d"] });
    const f = join(bot.home, "events.jsonl");
    writeFileSync(f, "old\n");
    setSettings(bot, { loop: MON_LOOP, wake: { files: [f] }, sleep: {} });
    const rt = join(bot.home, "runtime.json");
    writeFileSync(rt, JSON.stringify({ status: "idle" }));
    bot.env.OPSBOT_RUNTIME_FAKE = rt;
    cli(bot, ["check"], { now: T0 });
    expect(cli(bot, ["cycle", "begin"], { now: at(30) }).out).not.toContain("sleep now");
    // an input that, while the check runs, sees the wake file written: a probe failing mid-check
    makeExecutable(join(bot.root, "opsbot.d", "heartbeat.d", "30-lands-mid-check"), `#!/usr/bin/env bash\n[ -n "\${LAND:-}" ] && echo '{"event":"probe failed"}' >> ${JSON.stringify(f)}\nexit 0\n`);
    bot.env.LAND = "1";
    const r = cli(bot, ["cycle", "begin"], { now: at(61) });
    delete bot.env.LAND;
    expect(r.code).toBe(0);
    expect(r.out).toContain("sleep now");
    const st = JSON.parse(readFileSync(join(bot.root, ".git", "opsbot-sleep"), "utf8"));
    expect(readFileSync(f, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(st.wake_lines).toEqual({ [f]: 1 }); // the count as the check started, not after it
    const t = cli(bot, ["sleep", "tick"], { now: at(62) });
    expect(t.out).toContain("a new line in events.jsonl");
    expect(existsSync(`${rt}.prompts`) ? readFileSync(`${rt}.prompts`, "utf8") : "").not.toContain("/compact");
  });

  test("a quiet sleep with nothing new written still sleeps and is not woken", () => {
    bot = makeBot({ settings: BASE_SETTINGS, points: ["heartbeat.d", "escalate.d"] });
    const f = join(bot.home, "events.jsonl");
    writeFileSync(f, "old\n");
    setSettings(bot, { loop: MON_LOOP, wake: { files: [f] }, sleep: {} });
    const rt = join(bot.home, "runtime.json");
    writeFileSync(rt, JSON.stringify({ status: "idle" }));
    bot.env.OPSBOT_RUNTIME_FAKE = rt;
    cli(bot, ["check"], { now: T0 });
    cli(bot, ["cycle", "begin"], { now: at(30) });
    expect(cli(bot, ["cycle", "begin"], { now: at(61) }).out).toContain("sleep now");
    expect(JSON.parse(readFileSync(join(bot.root, ".git", "opsbot-sleep"), "utf8")).wake_lines).toEqual({ [f]: 1 });
    const t = cli(bot, ["sleep", "tick"], { now: at(62) });
    expect(t.out).not.toContain("woke");
    expect(readFileSync(`${rt}.prompts`, "utf8")).toContain("/compact");
  });
});
