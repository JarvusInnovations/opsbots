import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SETTINGS, cli, makeBot, writeStream, type Bot } from "./helpers";
import { nextDelay } from "../src/opsbot-core/cadence";
import { validateSettings, withDefaults } from "../src/opsbot-core/settings";
import { lastMonitorCall, readEvents } from "../src/opsbot-core/transcript";
import {
  SCHEDULE_RULES,
  WAKE_RULES,
  scheduleCall,
  scheduleCommand,
  scheduleSeconds,
  scheduleState,
  scheduleTimeoutMs,
} from "../src/opsbot-core/wake";

let bot: Bot;
afterEach(() => bot?.cleanup());

const NIGHT = "2026-03-02T23:00:00Z";
const DAY = "2026-03-02T15:00:00Z";
const WAKE_FILE = "/tmp/opsbot-test-wake/events.jsonl";
const MON_LOOP = { prompt: "testbot cycle: follow the opsbot-core skill, start with cycle begin", autocompact: "300k", schedule: "monitor" };
const MONITOR = { ...BASE_SETTINGS, loop: MON_LOOP, wake: { files: [WAKE_FILE] } };
const ev = (o: Record<string, unknown>) => JSON.stringify(o);

/** A session log whose last act armed the schedule monitor `at`, with `seconds` baked in. */
function scheduleLog(path: string, at: string, seconds: number, endedText?: string) {
  const lines = [
    ev({ type: "user", timestamp: "2026-03-02T22:40:00Z", message: { content: "testbot cycle" } }),
    ev({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: scheduleCommand([WAKE_FILE], seconds), description: "testbot schedule", timeout_ms: scheduleTimeoutMs(seconds) } }] } }),
    ev({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "Monitor started" }] } }),
    ev({ type: "system", subtype: "turn_duration", durationMs: 1000, timestamp: at }),
  ];
  if (endedText) lines.push(ev({ type: "user", timestamp: at, message: { content: endedText } }));
  writeFileSync(path, lines.join("\n") + "\n");
}

/** Run a generated command in bash; resolve with its stdout and how long it took. */
function run(cmd: string, limitMs: number): Promise<{ out: string; code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn("bash", ["-c", cmd]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), limitMs);
    p.on("close", (code) => {
      clearTimeout(kill);
      resolve({ out, code, ms: Date.now() - t0 });
    });
  });
}

describe("loop.schedule self: unchanged", () => {
  test("an explicit self prints byte for byte what an unset schedule prints", () => {
    const outs = [undefined, "self"].map((schedule) => {
      const b = makeBot({ settings: { ...BASE_SETTINGS, loop: { ...BASE_SETTINGS.loop, ...(schedule ? { schedule } : {}) }, wake: { files: [WAKE_FILE] } } });
      try {
        writeStream(b, [{ key: "k:1", at: DAY, conv: "c", kind: "dm", from: "p", text: "x" }]);
        const begin = cli(b, ["cycle", "begin"], { now: DAY });
        const end = cli(b, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:01:00Z" });
        const delay = cli(b, ["next-delay"], { now: NIGHT });
        return [begin.out, end.out, delay.out];
      } finally {
        b.cleanup();
      }
    });
    expect(outs[1]).toEqual(outs[0]!);
    expect(outs[0]![1]).toContain(`wake: new lines in ${WAKE_FILE}`);
    expect(outs[0]![2]).toContain("next: 2700 night");
    const s = withDefaults({ ...BASE_SETTINGS });
    expect(s.loop.schedule).toBe("self");
    expect(s.liveness.nudge_minutes).toBe(50);
    expect(s.liveness.nudge_cooldown_minutes).toBe(50);
  });
});

describe("loop.schedule monitor: the cycle prints one Monitor call", () => {
  test("cycle begin (nothing new, at night) prints the one call with the capped deadline and no ScheduleWakeup text", () => {
    bot = makeBot({ settings: MONITOR });
    const r = cli(bot, ["cycle", "begin"], { now: NIGHT });
    expect(r.code).toBe(0);
    expect(r.out).toContain("next 1740 night (capped at 29 min: a monitor's limit)");
    expect(r.out).toContain("state unknown (no session log) · arm now: Monitor({ command: ");
    expect(r.out).toContain("end=$(( $(date +%s) + 1740 ))");
    expect(r.out).toContain('description: \\"testbot schedule\\"');
    expect(r.out).toContain("timeout_ms: 1800000 })");
    expect(r.out.match(/Monitor\(/g)).toHaveLength(1);
    expect(r.out).not.toContain("ScheduleWakeup");
    expect(r.out).not.toContain("new lines in");
  });

  test("cycle begin holding the checkout prints no call; cycle end prints the one call due at the next wake", () => {
    bot = makeBot({ settings: MONITOR });
    writeStream(bot, [{ key: "k:1", at: NIGHT, conv: "c", kind: "dm", from: "p", text: "x" }]);
    const b = cli(bot, ["cycle", "begin"], { now: NIGHT });
    expect(b.code).toBe(10);
    expect(b.out).not.toContain("Monitor(");
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: "2026-03-02T23:01:00Z" });
    expect(e.code).toBe(0);
    // hot: due in 180 s, timeout 180 + 60 s
    expect(e.out).toContain("next: 180 arrived in the last 15 minutes");
    expect(e.out).toContain("end=$(( $(date +%s) + 180 ))");
    expect(e.out).toContain("timeout_ms: 240000 })");
    expect(e.out.match(/Monitor\(/g)).toHaveLength(1);
    expect(e.out).not.toContain("ScheduleWakeup");
  });

  test("with no wake files the monitor is only the timer", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: MON_LOOP } });
    const r = cli(bot, ["cycle", "begin"], { now: DAY });
    expect(r.code).toBe(0);
    expect(r.out).toContain("arm now: Monitor(");
    expect(scheduleCommand([], 600)).not.toContain("tail");
  });

  test("a refused begin (exit 30) prints the call too, so the session still wakes", () => {
    bot = makeBot({ settings: MONITOR });
    writeFileSync(join(bot.root, ".git", "index.lock"), "");
    const r = cli(bot, ["cycle", "begin"], { now: DAY });
    expect(r.code).toBe(30);
    expect(r.out).toContain("arm now: Monitor(");
  });

  test("the call is exactly the shape the brief names", () => {
    const call = scheduleCall("testbot", [WAKE_FILE], 600);
    expect(call.startsWith("Monitor({ command: ")).toBe(true);
    expect(call).toContain(', description: "testbot schedule", timeout_ms: 660000 })');
    expect(scheduleSeconds(scheduleCommand([WAKE_FILE], 600))).toBe(600);
  });
});

describe("the schedule command, run for real", () => {
  test("exits with `cycle due` at its own deadline when nothing arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opsbot-sched-"));
    try {
      const f = join(dir, "events.jsonl");
      writeFileSync(f, "old line\n");
      const r = await run(scheduleCommand([f], 3), 12_000);
      expect(r.code).toBe(0);
      expect(r.out).toBe("cycle due\n");
      expect(r.ms).toBeGreaterThanOrEqual(2_900);
      expect(r.ms).toBeLessThan(8_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("exits with the new lines, prefixed with the basename and cut to 300 characters, when a wake file grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opsbot-sched-"));
    try {
      const f = join(dir, "events.jsonl");
      const g = join(dir, "other.jsonl"); // not created yet: a missing file counts as empty
      writeFileSync(f, "old line\n");
      const p = run(scheduleCommand([g, f], 30), 20_000);
      setTimeout(() => appendFileSync(f, `new one\n${"y".repeat(400)}\n`), 2_500);
      const r = await p;
      expect(r.code).toBe(0);
      expect(r.out).toBe(`events.jsonl: new one\nevents.jsonl: ${"y".repeat(300)}\n`);
      expect(r.ms).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("next-delay with a monitor schedule", () => {
  const at = (iso: string) => Date.parse(iso);
  test("caps at 1740 and says so; a delay under it is untouched", () => {
    const s = withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP });
    expect(nextDelay(s, [], at(NIGHT))).toEqual({ seconds: 1740, reason: "night (capped at 29 min: a monitor's limit)" });
    expect(nextDelay(s, [], at("2026-03-02T08:00:00Z"))).toEqual({ seconds: 1740, reason: "quiet, otherwise (capped at 29 min: a monitor's limit)" });
    expect(nextDelay(s, [], at(DAY))).toEqual({ seconds: 600, reason: "quiet, working hours" });
    const low = withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP, cadence: { quiet: 1200, night: 1200, cap: 1200 } });
    expect(nextDelay(low, [], at(NIGHT))).toEqual({ seconds: 1200, reason: "night" });
  });
  test("the command prints the capped value", () => {
    bot = makeBot({ settings: MONITOR });
    expect(cli(bot, ["next-delay"], { now: NIGHT }).out.trim()).toBe(`next: "1740 night (capped at 29 min: a monitor's limit)"`);
  });
});

describe("settings with a monitor schedule", () => {
  test("validate refuses a slash-command prompt in monitor mode only, and an unknown schedule", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: { ...MON_LOOP, prompt: "/loop testbot cycle" } } });
    const r = cli(bot, ["settings", "validate"], { now: DAY });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("loop.prompt must not start with a slash command when loop.schedule is monitor");
    expect(validateSettings({ ...BASE_SETTINGS, loop: { prompt: "/loop testbot cycle", schedule: "self" } })).toEqual([]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP })).toEqual([]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: { prompt: "x", schedule: "cron" } })).toEqual(["loop.schedule must be one of self, monitor"]);
  });

  test("the nudge defaults to 35 minutes in monitor mode; explicit values win", () => {
    const m = withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP });
    expect(m.liveness.nudge_minutes).toBe(35);
    expect(m.liveness.nudge_cooldown_minutes).toBe(35);
    const x = withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP, liveness: { nudge_minutes: 50 } });
    expect(x.liveness.nudge_minutes).toBe(50);
    expect(x.liveness.nudge_cooldown_minutes).toBe(35);
  });

  test("a loop quiet for 40 minutes is nudged with the plain prompt in monitor mode, not in self mode", () => {
    for (const [settings, nudged] of [[MONITOR, true], [BASE_SETTINGS, false]] as const) {
      const b = makeBot({ settings });
      try {
        const f = join(b.home, "runtime.json");
        writeFileSync(f, JSON.stringify({ status: "idle" }));
        b.env.OPSBOT_RUNTIME_FAKE = f;
        cli(b, ["check"], { now: DAY });
        const r = cli(b, ["nudge"], { now: "2026-03-02T15:40:00Z" });
        if (nudged) {
          expect(r.out).toContain("nudged testbot");
          expect(readFileSync(`${f}.prompts`, "utf8").trim()).toBe(JSON.stringify(MON_LOOP.prompt));
        } else expect(r.out).toContain("nothing · last cycle");
      } finally {
        b.cleanup();
      }
    }
  });
});

describe("the schedule monitor's state, read from the session log", () => {
  test("armed until its baked deadline; expired, ended or absent is not armed", () => {
    bot = makeBot();
    const p = join(bot.root, "s.jsonl");
    scheduleLog(p, "2026-03-02T22:50:00Z", 600);
    expect(scheduleState(readEvents(p), "testbot", Date.parse(NIGHT))).toBeNull();
    expect(scheduleState(readEvents(p), "testbot", Date.parse("2026-03-02T22:55:00Z"))).toEqual({ at: "2026-03-02T22:50:00Z", until: "2026-03-02T23:00:00Z" });
    expect(scheduleState(readEvents(p), "otherbot", Date.parse("2026-03-02T22:55:00Z"))).toBeNull();
    scheduleLog(p, "2026-03-02T22:50:00Z", 600, `<task-notification>Monitor "testbot schedule": cycle due</task-notification>`);
    expect(scheduleState(readEvents(p), "testbot", Date.parse("2026-03-02T22:55:00Z"))).toBeNull();
  });

  test("cycle end says armed with nothing to do, or stop-and-replace when the armed one is due later", () => {
    bot = makeBot({ settings: MONITOR });
    const p = join(bot.root, "s.jsonl");
    // armed at 22:50 for 29 minutes: due 23:19
    scheduleLog(p, "2026-03-02T22:50:00Z", 1740);
    cli(bot, ["cold-start", "--write"], { now: NIGHT, input: JSON.stringify({ transcript_path: p }) });
    // quiet at night: next due in 1740 s, later than 23:19, so the armed one is enough
    const quiet = cli(bot, ["cycle", "begin"], { now: NIGHT });
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain("armed until 23:19Z (since 22:50Z); nothing to do");
    expect(quiet.out).not.toContain("Monitor(");
    // something arrives: due in 180 s, sooner than 23:19
    writeStream(bot, [{ key: "k:1", at: NIGHT, conv: "c", kind: "dm", from: "p", text: "x" }]);
    expect(cli(bot, ["cycle", "begin"], { now: "2026-03-02T23:01:00Z" }).code).toBe(10);
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: "2026-03-02T23:02:00Z" });
    expect(e.out).toContain("armed until 23:19Z (since 22:50Z), later than the next cycle is due");
    expect(e.out).toContain("stop it with TaskStop, then arm: Monitor(");
  });
});

describe("the pack by schedule", () => {
  test("monitor mode carries the schedule rules, even with no wake files; self mode keeps the live-wake rules", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: MON_LOOP }, points: ["wake.d"] });
    const m = cli(bot, ["cold-start"], { now: DAY }).out;
    expect(m).toContain("The schedule and live wake (arm it before anything else)");
    expect(m).toContain("state unknown (no session log) · run `cycle begin` now");
    for (const rule of SCHEDULE_RULES) expect(m).toContain(rule);
    expect(m).toContain("Never call ScheduleWakeup and never start `/loop`.");
    expect(m).not.toContain(WAKE_RULES[1]!);
    const p = join(bot.root, "s.jsonl");
    scheduleLog(p, "2026-03-02T14:55:00Z", 600);
    expect(cli(bot, ["cold-start", "--transcript", p], { now: DAY }).out).toContain("armed until 15:05Z (since 14:55Z)");
    const self = makeBot({ settings: { ...BASE_SETTINGS, wake: { files: [WAKE_FILE] } }, points: ["wake.d"] });
    try {
      const s = cli(self, ["cold-start"], { now: DAY }).out;
      for (const rule of WAKE_RULES) expect(s).toContain(rule);
      expect(s).not.toContain(SCHEDULE_RULES[3]!);
    } finally {
      self.cleanup();
    }
  });

  test("a monitor whose end is so far only a queued notification (it arrived mid-turn) reads as ended", () => {
    const dir = mkdtempSync(join(tmpdir(), "opsbot-queued-"));
    const log = join(dir, "s.jsonl");
    const call = { type: "assistant", timestamp: "2026-03-02T15:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Monitor", input: { command: "end=$(( $(date +%s) + 1740 )); while sleep 2; do :; done", description: "testbot schedule", timeout_ms: 1800000 } }] } };
    const queued = { type: "queue-operation", operation: "enqueue", timestamp: "2026-03-02T15:05:00Z", content: '<task-notification>\n<summary>Monitor "testbot schedule" stream ended</summary>\n<event>chat.jsonl: {"ts":"1"}</event>\n</task-notification>' };
    writeFileSync(log, [call].map((x) => JSON.stringify(x)).join("\n") + "\n");
    expect(lastMonitorCall(readEvents(log), (m) => m.description === "testbot schedule")!.ended).toBe(false);
    writeFileSync(log, [call, queued].map((x) => JSON.stringify(x)).join("\n") + "\n");
    expect(lastMonitorCall(readEvents(log), (m) => m.description === "testbot schedule")!.ended).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
