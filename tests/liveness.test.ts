import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, makeBot, readLines, type Bot } from "./helpers";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const outagesOf = (b: Bot) => readLines(join(b.root, "logs/outages.jsonl"));

function fakeRuntime(b: Bot, state: Record<string, unknown>): string {
  const f = join(b.home, "runtime.json");
  writeFileSync(f, JSON.stringify(state));
  b.env.OPSBOT_RUNTIME_FAKE = f;
  return f;
}
const prompts = (f: string) => (existsSync(`${f}.prompts`) ? readFileSync(`${f}.prompts`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe("watchdog", () => {
  test("quiet while cycles run", () => {
    bot = makeBot({ points: ["heartbeat.d", "escalate.d"] });
    fakeRuntime(bot, { status: "idle" });
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["watchdog"], { now: "2026-03-02T15:30:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("alive · last cycle");
  });

  test("escalates once per outage through escalate.d, records it, and records its end", () => {
    bot = makeBot({ points: ["heartbeat.d", "escalate.d"] });
    fakeRuntime(bot, { error: { code: "agent_not_found", message: "no agent" } });
    const sink = join(bot.home, "sink.txt");
    bot.env.FIXTURE_SINK = sink;
    cli(bot, ["check"], { now: T0 });

    const r = cli(bot, ["watchdog"], { now: "2026-03-02T16:10:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("the operator told · outage recorded");
    const msg = readFileSync(sink, "utf8");
    expect(msg).toContain("🧪 testbot has logged no cycle since Mon Mar 2, 3:00 PM UTC");
    expect(msg).toContain("no agent named testbot");
    expect(outagesOf(bot)).toHaveLength(1);
    expect(outagesOf(bot)[0]!.kind).toBe("stopped");

    // once per outage
    const again = cli(bot, ["watchdog"], { now: "2026-03-02T16:20:00Z" });
    expect(again.out).toContain("already told");
    expect(readFileSync(sink, "utf8").split("---").length - 1).toBe(1);

    // cycles resume: the end is recorded
    cli(bot, ["check"], { now: "2026-03-02T16:30:00Z" });
    const alive = cli(bot, ["watchdog"], { now: "2026-03-02T16:35:00Z" });
    expect(alive.out).toContain("ended 2026-03-02T16:30:00Z");
    expect(outagesOf(bot).at(-1)!.outcome).toBe("outage-end");
  });

  test("with no escalation script it says it cannot tell the operator (exit 1) and will retry", () => {
    bot = makeBot();
    fakeRuntime(bot, { status: "idle" });
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["watchdog"], { now: "2026-03-02T16:10:00Z" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no script in opsbot.d/escalate.d/");
    expect(existsSync(join(bot.root, ".git", "opsbot-watchdog"))).toBe(false);
  });

  test("when every escalation script fails, nothing is kept and it exits 1", () => {
    bot = makeBot({ points: ["heartbeat.d", "escalate.d"] });
    fakeRuntime(bot, { status: "idle" });
    bot.env.FIXTURE_ESCALATE_EXIT = "5";
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["watchdog"], { now: "2026-03-02T16:10:00Z" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("every escalation script failed");
    expect(outagesOf(bot)).toHaveLength(0);
  });

  test("--dry-run changes nothing", () => {
    bot = makeBot({ points: ["heartbeat.d", "escalate.d"] });
    fakeRuntime(bot, { status: "idle" });
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["watchdog", "--dry-run"], { now: "2026-03-02T16:10:00Z" });
    expect(r.out).toContain("would tell the operator");
    expect(outagesOf(bot)).toHaveLength(0);
  });
});

describe("nudge", () => {
  test("prompts the idle agent with loop.prompt verbatim once quiet past nudge_minutes", () => {
    bot = makeBot();
    const f = fakeRuntime(bot, { status: "idle", pane: "w1:p1" });
    cli(bot, ["check"], { now: T0 });
    expect(cli(bot, ["nudge"], { now: "2026-03-02T15:20:00Z" }).out).toContain("nothing · last cycle");
    const r = cli(bot, ["nudge"], { now: "2026-03-02T15:55:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("nudged testbot");
    expect(prompts(f)).toEqual(["/loop testbot cycle"]);
    // cooldown
    expect(cli(bot, ["nudge"], { now: "2026-03-02T16:05:00Z" }).out).toContain("nudged 10 min ago");
    expect(prompts(f)).toHaveLength(1);
  });

  test("does nothing while the agent is working or blocked, or a live lock is held", () => {
    bot = makeBot();
    const f = fakeRuntime(bot, { status: "working" });
    expect(cli(bot, ["nudge"], { now: T0 }).out).toContain("is working");
    writeFileSync(f, JSON.stringify({ status: "blocked" }));
    expect(cli(bot, ["nudge"], { now: T0 }).out).toContain("blocked at a dialog");
    writeFileSync(f, JSON.stringify({ status: "idle" }));
    writeFileSync(join(bot.root, ".git", "opsbot-cycle.lock"), JSON.stringify({ pid: String(process.pid), session: "s", started: "2026-03-02T14:59:00Z" }));
    expect(cli(bot, ["nudge"], { now: T0 }).out).toContain("a cycle holds the checkout");
    expect(prompts(f)).toHaveLength(0);
  });

  test("--now skips the quiet test but keeps its own cooldown", () => {
    bot = makeBot();
    const f = fakeRuntime(bot, { status: "idle" });
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["nudge", "--now", "--reason", "a probe failed"], { now: "2026-03-02T15:01:00Z" });
    expect(r.out).toContain("woke testbot for: a probe failed");
    expect(cli(bot, ["nudge", "--now"], { now: "2026-03-02T15:05:00Z" }).out).toContain("woke 4 min ago");
    expect(prompts(f)).toHaveLength(1);
  });

  test("a missing agent is 'cannot', exit 1", () => {
    bot = makeBot();
    fakeRuntime(bot, { error: { code: "agent_not_found", message: "x" } });
    const r = cli(bot, ["nudge"], { now: T0 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no agent named testbot");
  });

  test("a prompt that may have landed counts against the cooldown; a refused one does not", () => {
    bot = makeBot();
    const f = fakeRuntime(bot, { status: "idle", prompt_error: { code: "agent_blocked", message: "dialog" } });
    expect(cli(bot, ["nudge"], { now: T0 }).code).toBe(1);
    expect(existsSync(join(bot.root, ".git", "opsbot-nudge"))).toBe(false);
    writeFileSync(f, JSON.stringify({ status: "idle", prompt_error: { code: "timeout", message: "slow" } }));
    expect(cli(bot, ["nudge"], { now: T0 }).code).toBe(1);
    expect(existsSync(join(bot.root, ".git", "opsbot-nudge"))).toBe(true);
  });
});
