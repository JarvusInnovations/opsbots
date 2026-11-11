import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SETTINGS, cli, git, makeBot, makeExecutable, readLines, setSettings, writeStream, type Bot } from "./helpers";
import { validateSettings, withDefaults } from "../src/opsbot-core/settings";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const MON_LOOP = { prompt: "testbot cycle: follow the opsbot-core skill, start with cycle begin", autocompact: "300k", schedule: "monitor" };
const stateFile = (b: Bot) => join(b.root, ".git", "opsbot-sleep");
const state = (b: Bot) => JSON.parse(readFileSync(stateFile(b), "utf8"));
const log = (b: Bot) => readLines(join(b.root, "logs/cycle.jsonl"));
const outagesOf = (b: Bot) => readLines(join(b.root, "logs/outages.jsonl"));
const item = (n: number, when = T0) => ({ key: `chat:c:${n}`, at: when, conv: "c", kind: "group", from: "p", text: `hi ${n}` });

/** A bot with a monitor schedule, one wake file, and `sleep` set (the defaults unless given). */
function sleepyBot(sleep: Record<string, unknown> = {}, points?: string[]): Bot {
  const b = makeBot(points ? { points } : {});
  const wakeFile = join(b.home, "events.jsonl");
  setSettings(b, { loop: MON_LOOP, wake: { files: [wakeFile] }, sleep });
  return b;
}
const wakeFileOf = (b: Bot) => join(b.home, "events.jsonl");

function fakeRuntime(b: Bot, st: Record<string, unknown>): string {
  const f = join(b.home, "runtime.json");
  writeFileSync(f, JSON.stringify(st));
  b.env.OPSBOT_RUNTIME_FAKE = f;
  return f;
}
const prompts = (f: string): string[] => (existsSync(`${f}.prompts`) ? readFileSync(`${f}.prompts`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A due.d script that prints the given lines. */
function dueScript(b: Bot, lines: string[]): void {
  mkdirSync(join(b.root, "opsbot.d", "due.d"), { recursive: true });
  makeExecutable(join(b.root, "opsbot.d", "due.d", "10-promises"), `#!/usr/bin/env bash\n${lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n")}\n`);
}

/** Put the bot to sleep: a first quiet check at T0, then a quiet `cycle begin` past after_minutes. */
function putToSleep(b: Bot, when = at(61)) {
  cli(b, ["check"], { now: T0 });
  // a quiet cycle in between, as the schedule would run one, so no stretch reads as a stop
  expect(cli(b, ["cycle", "begin"], { now: at(30) }).out).not.toContain("sleep now");
  const r = cli(b, ["cycle", "begin"], { now: when });
  expect(r.code).toBe(0);
  expect(existsSync(stateFile(b))).toBe(true);
  return r;
}

describe("settings: sleep", () => {
  test("defaults 60/10/480/true; absent is null", () => {
    expect(withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: {} }).sleep).toEqual({ after_minutes: 60, probe_minutes: 10, max_minutes: 480, compact: true });
    expect(withDefaults({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: { after_minutes: 45, compact: false } }).sleep).toEqual({ after_minutes: 45, probe_minutes: 10, max_minutes: 480, compact: false });
    expect(withDefaults({ ...BASE_SETTINGS }).sleep).toBeNull();
  });

  test("refused unless loop.schedule is monitor; unknown keys, bad values and a probe over an hour refused", () => {
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: {} })).toEqual([]);
    expect(validateSettings({ ...BASE_SETTINGS, sleep: {} })[0]).toContain("sleep requires loop.schedule to be monitor");
    expect(validateSettings({ ...BASE_SETTINGS, loop: { ...MON_LOOP, schedule: "self" }, sleep: {} })[0]).toContain("sleep requires loop.schedule to be monitor");
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: { nap: 1 } })).toEqual(["unknown key sleep.nap"]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: { after_minutes: 0 } })).toEqual(["sleep.after_minutes must be a positive whole number"]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: { compact: "yes" } })).toEqual(["sleep.compact must be true or false"]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: { probe_minutes: 90 } })).toEqual(["sleep.probe_minutes must be 60 or less"]);
    expect(validateSettings({ ...BASE_SETTINGS, loop: MON_LOOP, sleep: [] })).toEqual(["sleep must be an object"]);
  });
});

describe("the sleep decision", () => {
  test("quiet for after_minutes: cycle begin writes the state, logs and commits `sleep`, and prints `sleep` with no `wake` field", () => {
    bot = sleepyBot();
    cli(bot, ["check"], { now: T0 });
    const early = cli(bot, ["cycle", "begin"], { now: at(30) });
    expect(early.code).toBe(0);
    expect(early.out).toContain("arm now: Monitor(");
    expect(early.out).not.toContain("sleep now");
    expect(existsSync(stateFile(bot))).toBe(false);

    const r = cli(bot, ["cycle", "begin"], { now: at(61) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("sleep[4]:");
    expect(r.out).toContain("sleep now: quiet since 15:00Z (61 min)");
    expect(r.out).toContain("end your turn now");
    expect(r.out).toContain("by 00:01Z at the latest (480 minutes asleep)");
    expect(r.out).not.toContain("wake:");
    expect(r.out).not.toContain("Monitor(");
    const st = state(bot);
    expect(st).toMatchObject({ decided_at: at(61), by: "cycle begin", quiet_since: T0, due: null, began: null, woken: null, compacted: false });
    expect(st.wake_lines).toEqual({ [wakeFileOf(bot)]: 0 });
    expect(log(bot).at(-1)).toMatchObject({ at: at(61), outcome: "sleep", by: "cycle begin", quiet_since: T0, due: null });
    expect(git(bot.root, "status", "--porcelain", "logs")).toBe("");
    expect(git(bot.root, "log", "-1", "--format=%s")).toContain("chore(cycle): sleep");
  });

  test("a promise due within after_minutes keeps it awake; one due later becomes the wake time", () => {
    bot = sleepyBot();
    dueScript(bot, [`${at(61 + 30)} reply to the vendor`]);
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["cycle", "begin"], { now: at(61) });
    expect(r.out).not.toContain("sleep now");
    expect(r.out).toContain("arm now: Monitor(");
    expect(existsSync(stateFile(bot))).toBe(false);

    dueScript(bot, [`${at(61 + 200)} reply to the vendor`, `${at(61 + 300)} send the report`]);
    const s = cli(bot, ["cycle", "begin"], { now: at(62) });
    expect(s.out).toContain("by 19:21Z at the latest (due: reply to the vendor)");
    expect(state(bot)).toMatchObject({ due: at(261), due_what: "reply to the vendor" });
  });

  test("a failing due.d script, or a line with no time, keeps it awake", () => {
    bot = sleepyBot();
    dueScript(bot, ["tomorrow, probably"]);
    cli(bot, ["check"], { now: T0 });
    expect(cli(bot, ["cycle", "begin"], { now: at(61) }).out).not.toContain("sleep now");
    makeExecutable(join(bot.root, "opsbot.d", "due.d", "10-promises"), "#!/usr/bin/env bash\nexit 4\n");
    expect(cli(bot, ["cycle", "begin"], { now: at(62) }).out).not.toContain("sleep now");
    expect(existsSync(stateFile(bot))).toBe(false);
  });

  test("a cycle that found something does not sleep; a cycle end long after the last arrival does, in place of `wake`", () => {
    bot = sleepyBot();
    cli(bot, ["check"], { now: T0 });
    writeStream(bot, [item(1, at(50))]);
    expect(cli(bot, ["cycle", "begin"], { now: at(61) }).code).toBe(10);
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: at(62) });
    expect(e.code).toBe(0);
    expect(e.out).not.toContain("sleep now");
    expect(e.out).toContain("arm now: Monitor(");

    // the next item arrives at 15:00 + 63; its cycle runs long, past after_minutes
    writeStream(bot, [item(2, at(63))]);
    expect(cli(bot, ["cycle", "begin"], { now: at(63) }).code).toBe(10);
    const late = cli(bot, ["cycle", "end", "--records", "1"], { now: at(124) });
    expect(late.code).toBe(0);
    expect(late.out).toContain("next:");
    expect(late.out).toContain("sleep now: quiet since 16:03Z (61 min)");
    expect(late.out).not.toContain("Monitor(");
    expect(state(bot).by).toBe("cycle end");
    const tail = log(bot).slice(-2);
    expect(tail.map((l) => l.outcome)).toEqual(["finished", "sleep"]);
    expect(git(bot.root, "status", "--porcelain", "logs")).toBe("");
  });

  test("a degraded last check keeps it awake", () => {
    bot = sleepyBot();
    cli(bot, ["check"], { now: T0 });
    bot.env.FIXTURE_STREAM_EXIT = "3";
    expect(cli(bot, ["cycle", "begin"], { now: at(61) }).code).toBe(20);
    delete bot.env.FIXTURE_STREAM_EXIT;
    cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: at(62) });
    expect(existsSync(stateFile(bot))).toBe(false);
  });

  test("the operator's recent message keeps it awake; the loop prompt does not count as the operator", () => {
    bot = sleepyBot();
    const t = join(bot.home, "session.jsonl");
    const user = (when: string, text: string) => JSON.stringify({ type: "user", timestamp: when, message: { content: text } });
    writeFileSync(t, `${user(at(40), "please watch the invoices")}\n${user(at(55), MON_LOOP.prompt)}\n`);
    cli(bot, ["cold-start", "--write"], { now: at(56), input: JSON.stringify({ transcript_path: t }) });
    cli(bot, ["check"], { now: T0 });
    expect(cli(bot, ["cycle", "begin"], { now: at(61) }).out).not.toContain("sleep now");
    // 60 minutes after the operator's message (the loop prompt at :55 is not theirs)
    expect(cli(bot, ["cycle", "begin"], { now: at(100) }).out).toContain("sleep now: quiet since 15:40Z (60 min)");
  });

  test("sleep absent: nothing changes at the same quiet moment", () => {
    bot = makeBot();
    setSettings(bot, { loop: MON_LOOP, wake: { files: [join(bot.home, "events.jsonl")] } });
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["cycle", "begin"], { now: at(200) });
    expect(r.out).toContain("arm now: Monitor(");
    expect(r.out).not.toContain("sleep now");
    expect(existsSync(stateFile(bot))).toBe(false);
    expect(log(bot).some((l) => l.outcome === "sleep" || l.outcome === "wake")).toBe(false);
    // a stale state file left behind with sleep unset is not obeyed
    writeFileSync(stateFile(bot), JSON.stringify({ decided_at: at(200), by: "cycle begin", quiet_since: T0, began: at(201), woken: null }));
    const f = fakeRuntime(bot, { status: "idle" });
    expect(cli(bot, ["nudge"], { now: at(260) }).out).toContain("nudged testbot");
    expect(prompts(f)).toHaveLength(1);
  });
});

describe("asleep: the nudge and the watchdog stand down", () => {
  test("nudge does nothing, watchdog reports no outage, nudge --now wakes, and cycle begin logs the wake", () => {
    bot = sleepyBot({}, ["heartbeat.d", "escalate.d"]);
    const f = fakeRuntime(bot, { status: "idle" });
    bot.env.FIXTURE_SINK = join(bot.home, "sink.txt");
    putToSleep(bot);
    // three hours of silence
    const n = cli(bot, ["nudge"], { now: at(240) });
    expect(n.out).toContain("nothing · going down since 16:01Z");
    const w = cli(bot, ["watchdog"], { now: at(240) });
    expect(w.code).toBe(0);
    expect(w.out).toContain("asleep · ");
    expect(outagesOf(bot)).toHaveLength(0);
    expect(existsSync(join(bot.home, "sink.txt"))).toBe(false);
    expect(prompts(f)).toHaveLength(0);

    // a listener's nudge --now wakes, even inside its cooldown from before the sleep
    writeFileSync(join(bot.root, ".git", "opsbot-nudge-now"), `${Math.floor(Date.parse(at(235)) / 1000)}\n\n`);
    const now = cli(bot, ["nudge", "--now", "--reason", "a DM"], { now: at(241) });
    expect(now.out).toContain("woke testbot for: a DM");
    expect(prompts(f)).toEqual([MON_LOOP.prompt]);
    expect(state(bot).woken).toMatchObject({ at: at(241), reason: "nudge --now: a DM", sent: true });
    // woken once, the cooldown holds again
    expect(cli(bot, ["nudge", "--now"], { now: at(242) }).out).toContain("woke 1 min ago");

    const b = cli(bot, ["cycle", "begin"], { now: at(243) });
    expect(b.code).toBe(0);
    // the old sleep is over; the cycle found nothing, so a new one is decided at once
    expect(state(bot)).toMatchObject({ decided_at: at(243), woken: null });
    const wake = log(bot).find((l) => l.outcome === "wake")!;
    expect(wake).toMatchObject({ outcome: "wake", reason: "nudge --now: a DM", latency_s: 120, slept_from: at(61), woken_at: at(241) });
    // the sleep was intended silence: no stopped outage
    expect(outagesOf(bot)).toHaveLength(0);
  });

  test("a wake left unanswered past watchdog_minutes is a stopped outage at the next cycle begin", () => {
    bot = sleepyBot();
    const f = fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    cli(bot, ["nudge", "--now"], { now: at(200) });
    expect(prompts(f)).toHaveLength(1);
    cli(bot, ["cycle", "begin"], { now: at(275) });
    const o = outagesOf(bot);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ kind: "stopped", started: at(200) });
    expect(String(o[0]!.note)).toContain("woken at");
  });

  test("the 48-hour summary does not count a sleep as the longest gap, and says it slept", () => {
    bot = sleepyBot({}, ["heartbeat.d", "wake.d"]);
    fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    cli(bot, ["nudge", "--now"], { now: at(400) });
    writeStream(bot, [item(1, at(399))]);
    expect(cli(bot, ["cycle", "begin"], { now: at(401) }).code).toBe(10);
    expect(cli(bot, ["cycle", "end", "--records", "1"], { now: at(402) }).out).not.toContain("sleep now");
    const pack = cli(bot, ["cold-start"], { now: at(403) }).out;
    expect(pack).toContain("longest gap 31 min, from 2026-03-02T15:30:00Z");
    expect(pack).toContain("slept 1 time, 339 min in all");
    const tail = cli(bot, ["log", "tail"], { now: at(403) }).out;
    expect(tail).toContain("quiet since 2026-03-02T15:00:00Z");
    expect(tail).toContain("nudge --now · 60 s after the event");
  });
});


describe("sleep tick, against a stub runtime", () => {
  const PROMPT = MON_LOOP.prompt;
  const assistant = (when: string) => JSON.stringify({ type: "assistant", timestamp: when, message: { content: [{ type: "text", text: "working" }] } });
  const turnDone = (when: string) => JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000, timestamp: when });

  test("going down: types /compact once, only when idle; asleep with nothing new it types nothing", () => {
    bot = sleepyBot();
    const sessionLog = join(bot.home, "session.jsonl");
    writeFileSync(sessionLog, `${assistant(at(61))}\n`);
    const f = fakeRuntime(bot, { status: "working", session_log: sessionLog });
    putToSleep(bot);
    const busy = cli(bot, ["sleep", "tick"], { now: at(65) });
    expect(busy.code).toBe(0);
    expect(busy.out).toContain("going down · waiting: testbot is working (mid-turn since 16:01Z)");
    expect(prompts(f)).toHaveLength(0);

    // the title still spins, but the session log shows the turn ended: idle
    writeFileSync(sessionLog, `${assistant(at(61))}\n${turnDone(at(62))}\n`);
    const dry = cli(bot, ["sleep", "tick", "--dry-run"], { now: at(70) });
    expect(dry.out).toContain("would type /compact into testbot");
    expect(prompts(f)).toHaveLength(0);
    expect(state(bot).began).toBeNull();

    const down = cli(bot, ["sleep", "tick"], { now: at(71) });
    expect(down.out).toContain("asleep · typed /compact into testbot");
    expect(prompts(f)).toEqual(["/compact"]);
    expect(state(bot)).toMatchObject({ began: at(71), compacted: true });

    writeFileSync(f, JSON.stringify({ status: "idle" }));
    const quiet = cli(bot, ["sleep", "tick"], { now: at(81) });
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain("asleep since 16:11Z, next look 16:31Z, wake by 00:01Z");
    expect(prompts(f)).toEqual(["/compact"]);
    expect(state(bot).looked_at).toBe(at(81));
    expect(cli(bot, [], { now: at(82) }).out).toContain("sleep: \"asleep since 16:11Z, next look 16:31Z");
  });

  test("sleep.compact false: the sleep begins without a compaction", () => {
    bot = sleepyBot({ compact: false });
    const f = fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    expect(cli(bot, ["sleep", "tick"], { now: at(62) }).out).toContain("began without compacting");
    expect(prompts(f)).toHaveLength(0);
    expect(state(bot)).toMatchObject({ began: at(62), compacted: false });
  });

  /** Asleep (compacted at :62), with the stub idle; returns the stub's file. */
  function asleep(sleep: Record<string, unknown> = {}): string {
    bot = sleepyBot(sleep, ["heartbeat.d", "escalate.d"]);
    const f = fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    cli(bot, ["sleep", "tick"], { now: at(62) });
    expect(prompts(f)).toEqual(["/compact"]);
    return f;
  }

  test("wakes on a new line in a wake file; --dry-run types nothing", () => {
    const f = asleep();
    appendFileSync(wakeFileOf(bot), '{"event":"dm"}\n');
    const dry = cli(bot, ["sleep", "tick", "--dry-run"], { now: at(72) });
    expect(dry.out).toContain("would wake testbot");
    expect(dry.out).toContain("a new line in events.jsonl");
    expect(prompts(f)).toEqual(["/compact"]);
    expect(state(bot).woken).toBeNull();
    const r = cli(bot, ["sleep", "tick"], { now: at(72) });
    expect(r.out).toContain("woke testbot for: a new line in events.jsonl");
    expect(prompts(f)).toEqual(["/compact", `${PROMPT} (woken: a new line in events.jsonl)`]);
    expect(state(bot).woken).toMatchObject({ at: at(72), reason: "a new line in events.jsonl", sent: true });
    // woken: the next tick waits for cycle begin and types nothing more
    expect(cli(bot, ["sleep", "tick"], { now: at(82) }).out).toContain("waiting for cycle begin (10 min)");
    expect(prompts(f)).toHaveLength(2);
  });

  test("wakes on a peek that exits 10, and cycle begin logs the latency from the item", () => {
    const f = asleep();
    writeStream(bot, [item(1, at(70))]);
    const r = cli(bot, ["sleep", "tick"], { now: at(72) });
    expect(r.out).toContain("woke testbot for: a peek found 1 new (10-file-stream)");
    expect(prompts(f).at(-1)).toBe(`${PROMPT} (woken: a peek found 1 new (10-file-stream))`);
    // the peek recorded nothing: the cycle sees the item
    const b = cli(bot, ["cycle", "begin"], { now: at(73) });
    expect(b.code).toBe(10);
    expect(b.out).toContain("chat:c:1");
    expect(log(bot).find((l) => l.outcome === "wake")).toMatchObject({ reason: "a peek found 1 new (10-file-stream)", latency_s: 180, slept_from: at(62), woken_at: at(72) });
  });

  test("wakes on a peek that exits 20", () => {
    const f = asleep();
    bot.env.FIXTURE_STREAM_EXIT = "3";
    expect(cli(bot, ["sleep", "tick"], { now: at(72) }).out).toContain("woke testbot for: a peek found a stream failing (10-file-stream)");
    expect(prompts(f)).toHaveLength(2);
  });

  test("wakes at the due time", () => {
    bot = sleepyBot({}, ["heartbeat.d"]);
    dueScript(bot, [`${at(200)} the weekly report`]);
    const f = fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    cli(bot, ["sleep", "tick"], { now: at(62) });
    expect(cli(bot, ["sleep", "tick"], { now: at(190) }).out).toContain("asleep since");
    expect(cli(bot, ["sleep", "tick"], { now: at(201) }).out).toContain("woke testbot for: due: the weekly report");
    expect(prompts(f)).toEqual(["/compact", `${PROMPT} (woken: due: the weekly report)`]);
  });

  test("wakes at max_minutes", () => {
    const f = asleep({ max_minutes: 120 });
    expect(cli(bot, ["sleep", "tick"], { now: at(180) }).out).toContain("asleep since");
    expect(cli(bot, ["sleep", "tick"], { now: at(181) }).out).toContain("woke testbot for: 120 minutes asleep");
    expect(prompts(f)).toHaveLength(2);
  });

  test("the operator writing while it goes down is a wake, not a compaction", () => {
    bot = sleepyBot();
    const sessionLog = join(bot.home, "session.jsonl");
    writeFileSync(sessionLog, "");
    cli(bot, ["cold-start", "--write"], { now: T0, input: JSON.stringify({ transcript_path: sessionLog }) });
    const f = fakeRuntime(bot, { status: "idle" });
    putToSleep(bot);
    appendFileSync(sessionLog, `${JSON.stringify({ type: "user", timestamp: at(63), message: { content: "are you there?" } })}\n${assistant(at(63))}\n${turnDone(at(64))}\n`);
    expect(cli(bot, ["sleep", "tick"], { now: at(65) }).out).toContain("woke testbot for: the operator wrote to the session");
    expect(prompts(f)).toEqual([`${PROMPT} (woken: the operator wrote to the session)`]);
  });

  test("does nothing while awake, and with sleep unset", () => {
    bot = sleepyBot();
    const f = fakeRuntime(bot, { status: "idle" });
    expect(cli(bot, ["sleep", "tick"], { now: T0 }).out).toContain("awake (no-op)");
    const plain = makeBot();
    try {
      expect(cli(plain, ["sleep", "tick"], { now: T0 }).out).toContain("sleep is not set in opsbot.json (no-op)");
    } finally {
      plain.cleanup();
    }
    expect(prompts(f)).toHaveLength(0);
  });

  test("a wake with no cycle begin inside watchdog_minutes is told to the operator once and recorded", () => {
    const f = asleep();
    const sink = join(bot.home, "sink.txt");
    bot.env.FIXTURE_SINK = sink;
    appendFileSync(wakeFileOf(bot), "{}\n");
    cli(bot, ["sleep", "tick"], { now: at(72) });
    expect(cli(bot, ["sleep", "tick"], { now: at(131) }).out).toContain("waiting for cycle begin (59 min)");
    expect(existsSync(sink)).toBe(false);
    const dry = cli(bot, ["sleep", "tick", "--dry-run"], { now: at(132) });
    expect(dry.out).toContain("would tell the operator");
    expect(existsSync(sink)).toBe(false);
    const told = cli(bot, ["sleep", "tick"], { now: at(132) });
    expect(told.code).toBe(0);
    expect(told.out).toContain("the operator told · outage recorded");
    const msg = readFileSync(sink, "utf8");
    expect(msg).toContain("🧪 testbot was asleep and was woken at Mon Mar 2, 4:12 PM UTC for: a new line in events.jsonl");
    expect(msg).toContain("The runtime says the session is idle.");
    expect(outagesOf(bot)).toEqual([expect.objectContaining({ kind: "stopped", started: at(72) })]);
    // once
    expect(cli(bot, ["sleep", "tick"], { now: at(142) }).out).toContain("the operator already told");
    expect(readFileSync(sink, "utf8").split("---").length - 1).toBe(1);
    expect(prompts(f)).toHaveLength(2);
    // the session answers at last: no second outage, and the watchdog closes the first
    writeStream(bot, [item(1, at(150))]);
    expect(cli(bot, ["cycle", "begin"], { now: at(150) }).code).toBe(10);
    expect(outagesOf(bot)).toHaveLength(1);
    cli(bot, ["cycle", "end", "--records", "1"], { now: at(151) });
    expect(cli(bot, ["watchdog"], { now: at(155) }).out).toContain(`outage from ${at(72)} ended ${at(150)}`);
  });

  test("a session that cannot be reached is recorded as woken unsent, retried, and told after watchdog_minutes", () => {
    const f = asleep();
    bot.env.FIXTURE_SINK = join(bot.home, "sink.txt");
    writeFileSync(f, JSON.stringify({ error: { code: "agent_not_found", message: "gone" } }));
    appendFileSync(wakeFileOf(bot), "{}\n");
    const r = cli(bot, ["sleep", "tick"], { now: at(72) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no agent named testbot");
    expect(state(bot).woken).toMatchObject({ at: at(72), sent: false });
    expect(cli(bot, ["sleep", "tick"], { now: at(82) }).code).toBe(1);
    expect(state(bot).woken.at).toBe(at(72));
    const told = cli(bot, ["sleep", "tick"], { now: at(133) });
    expect(told.out).toContain("the operator told");
    const msg = readFileSync(join(bot.home, "sink.txt"), "utf8");
    expect(msg).toContain("The runtime has no agent named testbot");
    expect(msg).toContain("The wake could not be typed into the session.");
  });
});

describe("infra and home with sleep", () => {
  test("the sleep timer is rendered only when sleep is set, at probe_minutes; status and home show the state", () => {
    bot = makeBot();
    const calls = join(bot.home, "systemctl.log");
    makeExecutable(join(bot.home, "systemctl"), `#!/usr/bin/env bash\necho "$*" >>"${calls}"\n[ "$2" = is-active ] && echo active\nexit 0\n`);
    bot.env.OPSBOT_SYSTEMCTL = join(bot.home, "systemctl");
    expect(cli(bot, ["infra", "install", "--dry-run"]).out).not.toContain("opsbot-testbot-sleep");
    expect(cli(bot, ["infra", "status"]).out).not.toContain("sleep:");
    expect(cli(bot, []).out).not.toContain("sleep:");

    setSettings(bot, { loop: MON_LOOP, wake: { files: [join(bot.home, "events.jsonl")] }, sleep: { probe_minutes: 7 } });
    const dry = cli(bot, ["infra", "install", "--dry-run"]).out;
    expect(dry).toContain("opsbot-testbot-sleep.timer");
    expect(dry).toContain("OnUnitActiveSec=7min");
    expect(dry).toMatch(/ExecStart=\S+opsbot-core sleep tick/);
    expect(cli(bot, ["infra", "install"]).code).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("opsbot-testbot-sleep.timer");
    const st = cli(bot, ["infra", "status"]);
    expect(st.out).toContain("all 6 units current");
    expect(st.out).toContain("sleep: awake");
    expect(cli(bot, []).out).toContain("sleep: awake");
    putToSleep(bot);
    expect(cli(bot, ["infra", "status"], { now: at(62) }).out).toContain("sleep: \"going down since 16:01Z");
  });
});

describe("the pack with sleep", () => {
  test("carries the sleep rules only with sleep set, and the sleep state while asleep", () => {
    bot = sleepyBot({}, ["heartbeat.d", "wake.d"]);
    const awake = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(awake).toContain("prints a `sleep` field in place of `wake`, arm no monitor and end your turn");
    expect(awake).toContain("(woken: <reason>)");
    putToSleep(bot);
    const pack = cli(bot, ["cold-start"], { now: at(62) }).out;
    expect(pack).toContain("going down since 16:01Z");
    expect(pack).toContain("arm nothing now: when the loop prompt arrives, run `cycle begin`");
    expect(pack).not.toContain("run `cycle begin` now; it prints the one Monitor call");
    const plain = makeBot({ settings: { ...BASE_SETTINGS, loop: MON_LOOP }, points: ["wake.d"] });
    try {
      expect(cli(plain, ["cold-start"], { now: T0 }).out).not.toContain("woken:");
    } finally {
      plain.cleanup();
    }
  });

  test("the dispatcher's mode section says what a sleep field means", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: { ...MON_LOOP, mode: "dispatcher" } }, points: ["wake.d"] });
    const pack = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(pack).toContain("**Sleep.** When `opsbot.json` sets `sleep`");
  });
});
