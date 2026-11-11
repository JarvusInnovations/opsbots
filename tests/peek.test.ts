import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, git, makeBot, makeExecutable, readLines, writeStream, type Bot } from "./helpers";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const T1 = "2026-03-02T15:20:00Z";
const item = (n: number) => ({ key: `chat:c:${n}`, at: T0, conv: "c", kind: "group", from: "p", text: `hi ${n}` });
const read = (b: Bot, f: string) => (existsSync(join(b.root, f)) ? readFileSync(join(b.root, f), "utf8") : null);

/** Everything a peek must leave alone. */
function snapshot(b: Bot) {
  return {
    log: read(b, "logs/cycle.jsonl"),
    seen: read(b, "logs/intake/seen"),
    watermark: read(b, "logs/intake/watermark"),
    status: git(b.root, "status", "--porcelain"),
    head: git(b.root, "rev-parse", "HEAD"),
  };
}

describe("check --peek", () => {
  test("new items: exit 10 with counts per input; nothing recorded; the check that follows reports the same items", () => {
    bot = makeBot();
    cli(bot, ["check"], { now: T0 }); // a watermark and a log line to leave alone
    writeStream(bot, [item(1), item(2)]);
    const before = snapshot(bot);
    const p = cli(bot, ["check", "--peek"], { now: T1 });
    expect(p.code).toBe(10);
    expect(p.out).toContain("new · 2 new · 2 inputs · nothing recorded");
    expect(p.out).toContain("10-file-stream,true,2");
    expect(p.out).toContain("20-quiet-stream,true,0");
    expect(p.out).not.toContain("chat:c:1");
    expect(snapshot(bot)).toEqual(before);
    // twice, still the same
    expect(cli(bot, ["check", "--peek"], { now: T1 }).code).toBe(10);
    expect(snapshot(bot)).toEqual(before);
    const c = cli(bot, ["check"], { now: T1 });
    expect(c.code).toBe(10);
    expect(c.out).toContain("chat:c:1");
    expect(c.out).toContain("chat:c:2");
    // and once seen, the peek finds nothing
    expect(cli(bot, ["check", "--peek"], { now: T1 }).code).toBe(0);
  });

  test("nothing new: exit 0 and no watermark written, even on a first run", () => {
    bot = makeBot();
    const before = snapshot(bot);
    const p = cli(bot, ["check", "--peek"], { now: T0 });
    expect(p.code).toBe(0);
    expect(p.out).toContain("nothing new · 2 inputs · nothing recorded");
    expect(snapshot(bot)).toEqual(before);
    expect(readLines(join(bot.root, "logs/cycle.jsonl"))).toHaveLength(0);
  });

  test("a failing stream: exit 20, named; nothing recorded", () => {
    bot = makeBot();
    writeStream(bot, [item(1)]);
    bot.env.FIXTURE_STREAM_EXIT = "3";
    const before = snapshot(bot);
    const p = cli(bot, ["check", "--peek"], { now: T0 });
    expect(p.code).toBe(20);
    expect(p.out).toContain("degraded · 1 failed · 1 new");
    expect(p.out).toContain("exit 3: the fake stream could not be read");
    expect(snapshot(bot)).toEqual(before);
  });

  test("adapters see OPSBOT_PEEK=1 in a peek and not in a check", () => {
    bot = makeBot();
    const envOut = join(bot.home, "env.txt");
    bot.env.FIXTURE_ENV_OUT = envOut;
    cli(bot, ["check", "--peek"], { now: T0 });
    expect(readFileSync(envOut, "utf8")).toContain("OPSBOT_PEEK=1");
    expect(readFileSync(envOut, "utf8")).toContain("OPSBOT_HOOK=heartbeat");
    cli(bot, ["check"], { now: T0 });
    expect(readFileSync(envOut, "utf8")).not.toContain("OPSBOT_PEEK");
  });

  test("an index lock does not stop a peek (it commits nothing)", () => {
    bot = makeBot();
    writeFileSync(join(bot.root, ".git", "index.lock"), "");
    expect(cli(bot, ["check", "--peek"], { now: T0 }).code).toBe(0);
  });

  test("--peek with --no-commit is a usage error", () => {
    bot = makeBot();
    const r = cli(bot, ["check", "--peek", "--no-commit"], { now: T0 });
    expect(r.code).toBe(2);
  });

  test("an adapter that writes its own state can honor OPSBOT_PEEK", () => {
    bot = makeBot();
    const baseline = join(bot.home, "baseline");
    makeExecutable(
      join(bot.root, "opsbot.d/heartbeat.d/30-baseline"),
      `#!/usr/bin/env bash\n[ -n "\${OPSBOT_PEEK:-}" ] || date +%s >>"${baseline}"\nexit 0\n`,
    );
    cli(bot, ["check", "--peek"], { now: T0 });
    expect(existsSync(baseline)).toBe(false);
  });
});
