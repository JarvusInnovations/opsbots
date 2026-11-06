import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, git, makeBot, readLines, writeStream, type Bot } from "./helpers";
import { gateWordIn } from "../src/opsbot-core/commands/check";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const item = (n: number, extra: Record<string, unknown> = {}) => ({
  key: `chat:conv-a:msg-${n}`,
  at: "2026-03-02T14:58:00Z",
  conv: "conv-a",
  kind: "group",
  from: "person-1",
  text: `message ${n}\nsecond line, whole`,
  ...extra,
});

const log = (b: Bot) => readLines(join(b.root, "logs/cycle.jsonl"));
const wm = (b: Bot) => readFileSync(join(b.root, "logs/intake/watermark"), "utf8").trim();

describe("check exit codes", () => {
  test("0: nothing new — one line, watermark advanced to the run's start, committed", () => {
    bot = makeBot();
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`check: "nothing new · 2 inputs · watermark ${T0}"`);
    expect(wm(bot)).toBe(T0);
    const lines = log(bot);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.outcome).toBe("nothing-new");
    expect(git(bot.root, "log", "-1", "--format=%s").trim()).toBe("chore(cycle): nothing new");
    expect(git(bot.root, "status", "--porcelain", "logs").trim()).toBe("");
  });

  test("10: new — the digest whole, keys recorded as seen at report time, watermark held", () => {
    bot = makeBot();
    cli(bot, ["check"], { now: T0 });
    writeStream(bot, [item(1), item(2, { kind: "dm", text: "please GOAHEAD on #3" })]);
    const r = cli(bot, ["check"], { now: "2026-03-02T15:10:00Z" });
    expect(r.code).toBe(10);
    expect(r.out).toContain('check: "new · 2 new · 2 inputs');
    expect(r.out).toContain("(not advanced)");
    expect(r.out).toContain("kind: GROUP");
    expect(r.out).toContain("kind: DM");
    expect(r.out).toContain("second line, whole");
    expect(r.out).toContain("gate_word: present");
    expect(wm(bot)).toBe(T0);
    const seen = readFileSync(join(bot.root, "logs/intake/seen"), "utf8");
    expect(seen).toBe("chat:conv-a:msg-1\nchat:conv-a:msg-2\n");
    // the same items are not reported twice
    const again = cli(bot, ["check"], { now: "2026-03-02T15:11:00Z" });
    expect(again.code).toBe(0);
  });

  test("20: degraded — the failed input named, what could be read still reported, never 'nothing new'", () => {
    bot = makeBot();
    cli(bot, ["check"], { now: T0 });
    writeStream(bot, [item(7)]);
    bot.env.FIXTURE_STREAM_EXIT = "3";
    const r = cli(bot, ["check"], { now: "2026-03-02T15:10:00Z" });
    expect(r.code).toBe(20);
    expect(r.out).toContain('check: "degraded · 1 failed · 1 new');
    expect(r.out).toContain("10-file-stream");
    expect(r.out).toContain("the fake stream could not be read");
    expect(r.out).toContain("chat:conv-a:msg-7");
    expect(r.out).not.toContain("nothing new");
    expect(wm(bot)).toBe(T0);
    const last = log(bot).at(-1)!;
    expect(last.outcome).toBe("degraded");
  });

  test("20 with nothing new: a failed input with no items is still degraded", () => {
    bot = makeBot();
    bot.env.FIXTURE_STREAM_EXIT = "1";
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(20);
    expect(r.out).not.toContain("nothing new");
    expect(existsSync(join(bot.root, "logs/intake/watermark"))).toBe(false);
  });

  test("20: output that is not a heartbeat item fails that input", () => {
    bot = makeBot();
    const f = join(bot.home, "bad.ndjson");
    writeFileSync(f, "not json\n");
    bot.env.FIXTURE_STREAM = f;
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(20);
    expect(r.out).toContain("not a heartbeat item");
  });

  test("20: no heartbeat scripts at all is degraded, not nothing new", () => {
    bot = makeBot({ points: [] });
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(20);
    expect(r.out).toContain("no heartbeat scripts");
  });

  test("2: cannot run — opsbot.json not committed; nothing written", () => {
    bot = makeBot({ commit: false });
    git(bot.root, "commit", "-q", "--allow-empty", "-m", "empty");
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(2);
    expect(r.out).toContain("opsbot.json is not committed");
    expect(existsSync(join(bot.root, "logs"))).toBe(false);
  });

  test("2: cannot run — no commit at HEAD", () => {
    bot = makeBot({ commit: false });
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(2);
  });
});

describe("check details", () => {
  test("settings are read at HEAD: an uncommitted edit does not run", () => {
    bot = makeBot();
    const p = join(bot.root, "opsbot.json");
    writeFileSync(p, "{ broken");
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(0);
  });

  test("the cycle-log line is byte-compatible: {at,outcome,inputs,new,failed,watermark}", () => {
    bot = makeBot();
    cli(bot, ["check"], { now: T0 });
    const raw = readFileSync(join(bot.root, "logs/cycle.jsonl"), "utf8").trim();
    expect(raw).toBe(
      `{"at":"${T0}","outcome":"nothing-new","inputs":{"10-file-stream":{"ok":true,"new":0},"20-quiet-stream":{"ok":true,"new":0}},"new":0,"failed":[],"watermark":"${T0}"}`,
    );
  });

  test("scripts get the env contract", () => {
    bot = makeBot();
    const envOut = join(bot.home, "env.txt");
    bot.env.FIXTURE_ENV_OUT = envOut;
    cli(bot, ["check"], { now: T0 });
    cli(bot, ["check"], { now: "2026-03-02T16:00:00Z" });
    const env = Object.fromEntries(
      readFileSync(envOut, "utf8")
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(env.OPSBOT_ROOT).toBe(bot.root);
    expect(env.OPSBOT_NAME).toBe("testbot");
    expect(env.OPSBOT_MARK).toBe("🧪");
    expect(env.OPSBOT_HOOK).toBe("heartbeat");
    expect(env.OPSBOT_WATERMARK).toBe(T0);
    expect(env.OPSBOT_SINCE).toBe("2026-03-02T14:30:00Z");
    expect(env.OPSBOT_SEEN).toBe(join(bot.root, "logs/intake/seen"));
    expect(JSON.parse(readFileSync(env.OPSBOT_CONFIG!, "utf8")).name).toBe("testbot");
  });

  test("first run reads 24 hours back", () => {
    bot = makeBot();
    const envOut = join(bot.home, "env.txt");
    bot.env.FIXTURE_ENV_OUT = envOut;
    cli(bot, ["check"], { now: T0 });
    expect(readFileSync(envOut, "utf8")).toContain("OPSBOT_SINCE=2026-03-01T15:00:00Z");
  });

  test("a commit that cannot be made is degraded and nothing claims otherwise", () => {
    bot = makeBot();
    const lock = join(bot.root, ".git", "index.lock");
    writeFileSync(lock, "");
    const r = cli(bot, ["check"], { now: T0 });
    rmSync(lock);
    expect(r.code).toBe(20);
    expect(r.out).toContain("cannot commit");
  });

  test("gate word: whole word, capitals only", () => {
    expect(gateWordIn("ok GOAHEAD now", "GOAHEAD")).toBe(true);
    expect(gateWordIn("GOAHEAD!", "GOAHEAD")).toBe(true);
    expect(gateWordIn("GOAHEADS", "GOAHEAD")).toBe(false);
    expect(gateWordIn("goahead", "GOAHEAD")).toBe(false);
    expect(gateWordIn("xGOAHEAD", "GOAHEAD")).toBe(false);
  });
});
