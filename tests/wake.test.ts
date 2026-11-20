import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SETTINGS, cli, makeBot, setSettings, writeStream, type Bot } from "./helpers";
import { lastMonitorCall, readEvents, turnEnded } from "../src/opsbot-core/transcript";
import {
  WAKE_BASE_NAME,
  lineCount,
  monitorCommand,
  monitorTimeout,
  readWakeBase,
  scheduleCommand,
  scheduleSeconds,
  scheduleState,
  wakeStates,
} from "../src/opsbot-core/wake";

// Some tests run the CLI several times; a loaded runner needs more than the 5 s default.
setDefaultTimeout(120000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const ev = (o: Record<string, unknown>) => JSON.stringify(o);
const WAKE_FILE = "/tmp/opsbot-test-wake/events.jsonl";
const SETTINGS = { ...BASE_SETTINGS, wake: { files: [WAKE_FILE] } };

function fakeRuntime(b: Bot, state: Record<string, unknown>): string {
  const f = join(b.home, "runtime.json");
  writeFileSync(f, JSON.stringify(state));
  b.env.OPSBOT_RUNTIME_FAKE = f;
  return f;
}
const prompts = (f: string) => readFileSync(`${f}.prompts`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A log whose last turn ended after spawning background work (the shape that fooled the title). */
function endedLog(path: string, opts: { monitor?: boolean; monitorAt?: string; timeout?: number; endedText?: string } = {}) {
  const lines = [
    ev({ type: "user", timestamp: "2026-03-02T14:40:00Z", message: { content: "/loop testbot cycle" } }),
    ev({ type: "assistant", timestamp: "2026-03-02T14:40:05Z", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "classify the inbox" } }] } }),
    ev({ type: "user", timestamp: "2026-03-02T14:40:06Z", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "started" }] } }),
  ];
  if (opts.monitor) {
    lines.push(
      ev({ type: "assistant", timestamp: opts.monitorAt ?? "2026-03-02T14:40:07Z", message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: monitorCommand(WAKE_FILE), description: `testbot wake: new lines in ${WAKE_FILE}`, timeout_ms: opts.timeout ?? 1_800_000 } }] } }),
      ev({ type: "user", timestamp: "2026-03-02T14:40:08Z", message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "Monitor started" }] } }),
    );
  }
  lines.push(
    ev({ type: "assistant", timestamp: "2026-03-02T14:40:09Z", message: { content: [{ type: "tool_use", id: "s1", name: "ScheduleWakeup", input: { delaySeconds: 600 } }] } }),
    ev({ type: "user", timestamp: "2026-03-02T14:40:10Z", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "scheduled" }] } }),
    ev({ type: "system", subtype: "turn_duration", durationMs: 10_000, timestamp: "2026-03-02T14:40:10Z" }),
  );
  if (opts.endedText) lines.push(ev({ type: "user", timestamp: "2026-03-02T14:50:00Z", message: { content: opts.endedText } }));
  writeFileSync(path, lines.join("\n") + "\n");
}

function midTurnLog(path: string) {
  writeFileSync(path, [
    ev({ type: "user", timestamp: "2026-03-02T14:40:00Z", message: { content: "/loop testbot cycle" } }),
    ev({ type: "assistant", timestamp: "2026-03-02T14:40:05Z", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }] } }),
    ev({ type: "user", timestamp: "2026-03-02T14:40:06Z", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "97 pass" }] } }),
    ev({ type: "assistant", timestamp: "2026-03-02T14:41:00Z", message: { content: [{ type: "text", text: "Now the build." }, { type: "tool_use", id: "b2", name: "Bash", input: { command: "bun run build" } }] } }),
  ].join("\n") + "\n");
}

describe("transcript: turn state and monitors", () => {
  test("a turn_duration after the last assistant entry means the turn ended; a pending call means mid-turn", () => {
    bot = makeBot();
    const a = join(bot.root, "a.jsonl");
    endedLog(a);
    expect(turnEnded(readEvents(a))).toEqual({ ended: true, at: "2026-03-02T14:40:10Z" });
    const b = join(bot.root, "b.jsonl");
    midTurnLog(b);
    expect(turnEnded(readEvents(b))).toEqual({ ended: false, since: "2026-03-02T14:41:00Z" });
    expect(turnEnded([])).toEqual({ ended: true, at: null });
  });

  test("readEvents loads only the end of a long log and drops the cut line; an unreadable log is no events", () => {
    const dir = mkdtempSync(join(tmpdir(), "opsbot-tail-"));
    const p = join(dir, "long.jsonl");
    const pad = "x".repeat(300);
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: "user", timestamp: `2026-03-02T14:00:${String(i % 60).padStart(2, "0")}Z`, message: { content: `${i} ${pad}` } }));
    lines.push(JSON.stringify({ type: "assistant", timestamp: "2026-03-02T15:00:00Z", message: { content: [{ type: "text", text: "done" }] } }));
    lines.push(JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: "2026-03-02T15:00:01Z" }));
    writeFileSync(p, lines.join("\n") + "\n");
    const tail = readEvents(p, 2000);
    expect(tail.length).toBeGreaterThan(2);
    expect(tail.length).toBeLessThan(10);
    expect(turnEnded(tail)).toEqual({ ended: true, at: "2026-03-02T15:00:01Z" });
    expect(readEvents(p).length).toBe(202);
    expect(readEvents(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the last Monitor on a file is found with its deadline, and a later ending notice marks it ended", () => {
    bot = makeBot();
    const a = join(bot.root, "a.jsonl");
    endedLog(a, { monitor: true, timeout: 600_000 });
    const m = lastMonitorCall(readEvents(a), WAKE_FILE)!;
    expect(m.timeoutMs).toBe(600_000);
    expect(m.ended).toBe(false);
    expect(lastMonitorCall(readEvents(a), "/elsewhere/events.jsonl")).toBeNull();
    const b = join(bot.root, "b.jsonl");
    endedLog(b, { monitor: true, endedText: `<task-notification>Monitor event: "testbot wake: new lines in ${WAKE_FILE}" exited</task-notification>` });
    expect(lastMonitorCall(readEvents(b), WAKE_FILE)!.ended).toBe(true);
    // armed state: live, expired, ended
    const live = wakeStates(readEvents(a), [WAKE_FILE], Date.parse("2026-03-02T14:45:00Z"));
    expect(live[0]!.armed).toEqual({ at: "2026-03-02T14:40:07Z", until: "2026-03-02T14:50:07Z" });
    expect(wakeStates(readEvents(a), [WAKE_FILE], Date.parse("2026-03-02T14:55:00Z"))[0]!.armed).toBeNull();
    expect(wakeStates(readEvents(b), [WAKE_FILE], Date.parse("2026-03-02T14:45:00Z"))[0]!.armed).toBeNull();
  });

  test("the monitor deadline is the next wake when sooner than the 30-minute cap, never under a minute", () => {
    expect(monitorTimeout(null)).toBe(1_800_000);
    expect(monitorTimeout(600_000)).toBe(600_000);
    expect(monitorTimeout(2_700_000)).toBe(1_800_000);
    expect(monitorTimeout(5_000)).toBe(60_000);
  });
});

describe("nudge with the session log", () => {
  test("prompts a 'working' agent whose log shows the turn ended, and refuses one that is mid-turn", () => {
    bot = makeBot();
    const log = join(bot.root, "session.jsonl");
    endedLog(log);
    const f = fakeRuntime(bot, { status: "working", session_log: log });
    const r = cli(bot, ["nudge", "--now", "--reason", "slack dm"], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("woke testbot for: slack dm");
    expect(r.out).toContain("the session log shows the turn ended at 14:40Z");
    expect(prompts(f)).toEqual(["/loop testbot cycle"]);
    midTurnLog(log);
    const r2 = cli(bot, ["nudge", "--now", "--reason", "slack dm"], { now: "2026-03-02T15:20:00Z" });
    expect(r2.out).toContain("is working (mid-turn since 14:41Z)");
    expect(prompts(f)).toHaveLength(1);
  });

  test("falls back to the pointer cold-start wrote, and stays quiet with no log at all", () => {
    bot = makeBot();
    const log = join(bot.root, "session.jsonl");
    endedLog(log);
    const f = fakeRuntime(bot, { status: "working" });
    expect(cli(bot, ["nudge", "--now"], { now: T0 }).out).toContain("no session log to check");
    cli(bot, ["cold-start", "--write"], { now: T0, input: JSON.stringify({ transcript_path: log, session_id: "abc", source: "startup" }) });
    expect(JSON.parse(readFileSync(join(bot.root, ".git", "opsbot-session"), "utf8")).transcript_path).toBe(log);
    expect(cli(bot, ["nudge", "--now"], { now: "2026-03-02T15:05:00Z" }).out).toContain("woke testbot");
    expect(prompts(f)).toHaveLength(1);
  });
});

describe("the live wake in the pack and the cycle", () => {
  test("cold-start prints the wake section with the exact Monitor call when a file is configured, and not otherwise", () => {
    bot = makeBot({ settings: SETTINGS, points: ["wake.d"] });
    const r = cli(bot, ["cold-start"], { now: T0 });
    expect(r.out).toContain("The live wake (arm it before anything else)");
    expect(r.out).toContain(`state unknown (no session log) on ${WAKE_FILE} · arm now: Monitor({ command: `);
    expect(r.out).toContain(`timeout_ms: 1800000 })`);
    expect(r.out).toContain("never two on one file");
    expect(r.out.indexOf("The live wake")).toBeLessThan(r.out.indexOf("═══ 2. owed"));
    const log = join(bot.root, "session.jsonl");
    endedLog(log, { monitor: true, monitorAt: "2026-03-02T14:55:00Z" });
    const r2 = cli(bot, ["cold-start", "--transcript", log], { now: T0 });
    expect(r2.out).toContain(`armed on ${WAKE_FILE} until 15:25Z (since 14:55Z); nothing to do`);
    const plain = makeBot({ points: ["wake.d"] });
    try {
      expect(cli(plain, ["cold-start"], { now: T0 }).out).not.toContain("live wake");
    } finally {
      plain.cleanup();
    }
  });

  test("cycle begin and end report the wake from the session pointer, with the end's deadline bounded by the next wake", () => {
    bot = makeBot({ settings: SETTINGS });
    const log = join(bot.root, "session.jsonl");
    endedLog(log);
    cli(bot, ["cold-start", "--write"], { now: T0, input: JSON.stringify({ transcript_path: log }) });
    writeStream(bot, [{ key: "k:1", at: T0, conv: "c", kind: "dm", from: "p", text: "x" }]);
    const b = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(b.code).toBe(10);
    expect(b.out).toContain(`not armed on ${WAKE_FILE} · arm now: Monitor({`);
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:01:00Z" });
    expect(e.code).toBe(0);
    expect(e.out).toContain("not armed on");
    // hot cadence: next wake in 180 s, so the deadline is 180 000 ms, not the cap
    expect(e.out).toContain("timeout_ms: 180000 })");
  });

  test("settings validate rejects a bad wake block", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, wake: { files: "not-a-list" } } });
    const r = cli(bot, ["settings", "validate"], { now: T0 });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("wake.files must be an array of file paths");
  });
});

// ------------------------------------------------------------- armed from where the last check read to

/** Run a generated command in bash; resolve with its stdout and how long it took. */
function runShell(cmd: string, limitMs: number): Promise<{ out: string; code: number | null; ms: number }> {
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

/** The monitor command as the kit printed it before counts were recorded: a running session may hold it. */
const OLD_MONITOR = (file: string) =>
  `f=${JSON.stringify(file)}; c() { [ -f "$f" ] && wc -l < "$f" || echo 0; }; n=$(c); ` +
  `while sleep 2; do m=$(c); if [ "$m" -lt "$n" ]; then n=$m; fi; ` +
  `if [ "$m" -gt "$n" ]; then tail -n $((m-n)) "$f" | cut -c1-300; exit 0; fi; done`;
const OLD_SCHEDULE = (file: string, seconds: number) =>
  `end=$(( $(date +%s) + ${seconds} )); c() { [ -f "$1" ] && wc -l < "$1" || echo 0; }; f0='${file}'; n0=$(c "$f0"); ` +
  `while sleep 2; do h=0; m=$(c "$f0"); if [ "$m" -lt "$n0" ]; then n0=$m; fi; if [ "$m" -gt "$n0" ]; then tail -n $((m-n0)) "$f0" | cut -c1-300 | while IFS= read -r l; do printf '%s: %s\\n' 'events.jsonl' "$l"; done; n0=$m; h=1; fi; if [ "$h" = 1 ]; then exit 0; fi; if [ "$(date +%s)" -ge "$end" ]; then echo 'cycle due'; exit 0; fi; done`;

describe("the monitor is armed from where the last check read to", () => {
  const tmpDir = () => mkdtempSync(join(tmpdir(), "opsbot-wake-base-"));

  test("a line appended after the check recorded N lines is printed at once when the poller starts", async () => {
    const dir = tmpDir();
    try {
      const f = join(dir, "events.jsonl");
      writeFileSync(f, "one\ntwo\n");
      const n = lineCount(f);
      expect(n).toBe(2);
      appendFileSync(f, "arrived mid-cycle\n");
      const r = await runShell(monitorCommand(f, n), 10_000);
      expect(r.code).toBe(0);
      expect(r.out).toBe("arrived mid-cycle\n");
      expect(r.ms).toBeLessThan(1_500); // no poll interval first
      const s = await runShell(scheduleCommand([f], 30, [n]), 10_000);
      expect(s.code).toBe(0);
      expect(s.out).toBe("events.jsonl: arrived mid-cycle\n");
      expect(s.ms).toBeLessThan(1_500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("with no recorded count the poller starts at the end of the file and waits, as before", async () => {
    const dir = tmpDir();
    try {
      const f = join(dir, "events.jsonl");
      writeFileSync(f, "one\ntwo\n");
      expect(monitorCommand(f)).toContain("n=$(c);");
      const r = await runShell(monitorCommand(f), 3_000);
      expect(r.code).toBeNull(); // still waiting when killed
      expect(r.out).toBe("");
      const p = runShell(monitorCommand(f, null), 10_000);
      setTimeout(() => appendFileSync(f, "later\n"), 1_000);
      expect((await p).out).toBe("later\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a file shorter than its recorded count (truncated or rotated) is delivered from its start", async () => {
    const dir = tmpDir();
    try {
      const f = join(dir, "events.jsonl");
      writeFileSync(f, "fresh one\nfresh two\n");
      const r = await runShell(monitorCommand(f, 9), 10_000);
      expect(r.out).toBe("fresh one\nfresh two\n");
      const s = await runShell(scheduleCommand([f], 30, [9]), 10_000);
      expect(s.out).toBe("events.jsonl: fresh one\nevents.jsonl: fresh two\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("old-form commands a running session may hold are still recognised", () => {
    bot = makeBot();
    const logWith = (name: string, at: string, input: Record<string, unknown>) => {
      const p = join(bot.root, name);
      writeFileSync(p, [
        ev({ type: "user", timestamp: "2026-03-02T14:40:00Z", message: { content: "/loop testbot cycle" } }),
        ev({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input }] } }),
      ].join("\n") + "\n");
      return readEvents(p);
    };
    const evs = logWith("old-wake.jsonl", "2026-03-02T14:40:07Z", { command: OLD_MONITOR(WAKE_FILE), description: `testbot wake: new lines in ${WAKE_FILE}`, timeout_ms: 600_000 });
    const sched = logWith("old-schedule.jsonl", "2026-03-02T14:40:08Z", { command: OLD_SCHEDULE(WAKE_FILE, 600), description: "testbot schedule", timeout_ms: 660_000 });
    expect(wakeStates(evs, [WAKE_FILE], Date.parse("2026-03-02T14:45:00Z"))[0]!.armed).toEqual({ at: "2026-03-02T14:40:07Z", until: "2026-03-02T14:50:07Z" });
    expect(scheduleSeconds(OLD_SCHEDULE(WAKE_FILE, 600))).toBe(600);
    expect(scheduleState(sched, "testbot", Date.parse("2026-03-02T14:45:00Z"))).toEqual({ at: "2026-03-02T14:40:08Z", until: "2026-03-02T14:50:08Z" });
    // and the new forms carry the same markers
    expect(monitorCommand(WAKE_FILE, 7)).toContain(JSON.stringify(WAKE_FILE));
    expect(scheduleSeconds(scheduleCommand([WAKE_FILE], 600, [7]))).toBe(600);
  });

  test("cycle begin records each wake file's count as its check starts, and every arm call after it starts there", () => {
    bot = makeBot({ settings: SETTINGS });
    const f = join(bot.home, "wake", "events.jsonl");
    mkdirSync(join(bot.home, "wake"), { recursive: true });
    writeFileSync(f, "a\nb\nc\n");
    setSettings(bot, { wake: { files: [f] } });
    // before any check: no record, the call measures at start
    expect(cli(bot, ["cold-start"], { now: T0 }).out).toContain("n=$(c);");
    writeStream(bot, [{ key: "k:1", at: T0, conv: "c", kind: "dm", from: "p", text: "x" }]);
    const b = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(b.code).toBe(10);
    const rec = JSON.parse(readFileSync(join(bot.root, ".git", WAKE_BASE_NAME), "utf8"));
    expect(rec.lines).toEqual({ [f]: 3 });
    expect(readWakeBase(bot.root)).toEqual({ [f]: 3 });
    expect(b.out).toContain("n=3;");
    appendFileSync(f, "d\n"); // lands mid-cycle
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:01:00Z" });
    expect(e.code).toBe(0);
    // the session is awake: it begins again rather than arming a monitor that would fire at once
    expect(e.out).toContain("arrived: 1 on events.jsonl");
    expect(e.out).toContain("next: 0 arrived");
    expect(e.out).not.toContain("Monitor(");
    expect(cli(bot, ["cold-start"], { now: "2026-03-02T15:02:00Z" }).out).toContain("n=3;"); // from the check, not from now
    // the monitor schedule's poller starts from the record too: `wake wait` reads it
    setSettings(bot, { loop: { prompt: "testbot cycle: follow the opsbot-core skill, start with cycle begin", autocompact: "300k", schedule: "monitor" } });
    const s = cli(bot, ["cycle", "begin"], { now: "2026-03-02T15:10:00Z" });
    expect(readWakeBase(bot.root)).toEqual({ [f]: 4 });
    expect(s.out).toContain("wake wait --until");
  });
});
