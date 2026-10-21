import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cli, git, makeBot, readLines, writeStream, type Bot } from "./helpers";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const lockFile = (b: Bot) => join(b.root, ".git", "opsbot-cycle.lock");
const outagesOf = (b: Bot) => readLines(join(b.root, "logs/outages.jsonl"));
const log = (b: Bot) => readLines(join(b.root, "logs/cycle.jsonl"));
const wm = (b: Bot) => readFileSync(join(b.root, "logs/intake/watermark"), "utf8").trim();
const item = (n: number) => ({ key: `chat:c:${n}`, at: T0, conv: "c", kind: "group", from: "p", text: `hi ${n}` });

function deadPid(): string {
  const r = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
  return r.stdout.trim();
}

describe("cycle begin", () => {
  test("nothing new: one line with the next wake; the lock released", () => {
    bot = makeBot({ points: ["heartbeat.d", "cycle.d"] });
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing new · 2 inputs");
    expect(r.out).toContain("not pushed: no remote named origin");
    expect(r.out).toMatch(/next \d+ /);
    expect(existsSync(lockFile(bot))).toBe(false);
  });

  test("new: the digest, exit 10, the lock kept for cycle end", () => {
    bot = makeBot();
    writeStream(bot, [item(1)]);
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(10);
    expect(r.out).toContain("chat:c:1");
    expect(existsSync(lockFile(bot))).toBe(true);
  });

  test("refuses on a live lock (exit 30, wait line)", () => {
    bot = makeBot();
    writeFileSync(lockFile(bot), JSON.stringify({ pid: String(process.pid), session: "other", started: "2026-03-02T14:50:00Z" }));
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(30);
    expect(r.out).toContain("wait · a cycle in session other");
    expect(r.out).toMatch(/next \d+ /);
    expect(log(bot)).toHaveLength(0);
  });

  test("refuses while a rebase is in progress", () => {
    bot = makeBot();
    mkdirSync(join(bot.root, ".git", "rebase-merge"));
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(30);
    expect(r.out).toContain("a rebase is in progress");
  });

  test("refuses while the index is locked", () => {
    bot = makeBot();
    writeFileSync(join(bot.root, ".git", "index.lock"), "");
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(30);
    expect(r.out).toContain("index.lock");
  });

  test("takes over a lock whose process is gone, with an outage recorded", () => {
    bot = makeBot();
    writeFileSync(lockFile(bot), JSON.stringify({ pid: deadPid(), session: "gone", started: "2026-03-02T14:50:00Z" }));
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(0);
    const o = outagesOf(bot);
    expect(o).toHaveLength(1);
    expect(o[0]!.kind).toBe("session-ended");
    expect(o[0]!.started).toBe("2026-03-02T14:50:00Z");
    expect(o[0]!.ended).toBe(T0);
    // the outage line was committed with the cycle
    expect(git(bot.root, "status", "--porcelain").trim()).toBe("");
  });

  test("takes over a lock older than lock_max_minutes", () => {
    bot = makeBot();
    writeFileSync(lockFile(bot), JSON.stringify({ pid: "", session: "old", started: "2026-03-02T13:00:00Z" }));
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(0);
    expect(outagesOf(bot)[0]!.kind).toBe("failed-turn");
  });

  test("takes over its own session's unfinished lock", () => {
    bot = makeBot();
    writeFileSync(lockFile(bot), JSON.stringify({ pid: String(process.pid), session: "me", started: "2026-03-02T14:59:00Z" }));
    const r = cli(bot, ["cycle", "begin"], { now: T0, env: { CLAUDE_CODE_SESSION_ID: "me" } });
    expect(r.code).toBe(0);
    expect(outagesOf(bot)[0]!.note).toContain("this session");
  });

  test("waits on an unreadable-process lock younger than the limit", () => {
    bot = makeBot();
    writeFileSync(lockFile(bot), JSON.stringify({ pid: "", session: "s", started: "2026-03-02T14:55:00Z" }));
    expect(cli(bot, ["cycle", "begin"], { now: T0 }).code).toBe(30);
  });

  test("records a stopped outage when no cycle logged within watchdog_minutes", () => {
    bot = makeBot();
    cli(bot, ["cycle", "begin"], { now: T0 });
    const r = cli(bot, ["cycle", "begin"], { now: "2026-03-02T17:00:00Z" });
    expect(r.code).toBe(0);
    const o = outagesOf(bot);
    expect(o).toHaveLength(1);
    expect(o[0]!.kind).toBe("stopped");
    expect(o[0]!.started).toBe(T0);
  });

  test("a failing cycle.d/begin script aborts the cycle as degraded and keeps the lock", () => {
    bot = makeBot({ points: ["heartbeat.d", "cycle.d"] });
    bot.env.FIXTURE_BEGIN_EXIT = "4";
    const r = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(r.code).toBe(20);
    expect(r.out).toContain("cycle.d/begin/10-sync failed");
    expect(existsSync(lockFile(bot))).toBe(true);
    expect(log(bot).at(-1)!.outcome).toBe("degraded");
    const end = cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: "2026-03-02T15:01:00Z" });
    expect(end.code).toBe(0);
    expect(existsSync(lockFile(bot))).toBe(false);
  });
});

describe("cycle end", () => {
  test("pins the watermark to the check's time, logs finished, commits, releases", () => {
    bot = makeBot({ points: ["heartbeat.d", "cycle.d"] });
    cli(bot, ["cycle", "begin"], { now: "2026-03-02T14:00:00Z" });
    writeStream(bot, [item(1)]);
    expect(cli(bot, ["cycle", "begin"], { now: T0 }).code).toBe(10);
    const r = cli(bot, ["cycle", "end", "--records", "2", "--summary", "answered one"], { now: "2026-03-02T15:07:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`finished · 2 records · watermark ${T0}`);
    expect(r.out).toContain("due: 1 promise to look at");
    expect(r.out).toMatch(/next: "?\d+ /);
    expect(wm(bot)).toBe(T0);
    const last = log(bot).at(-1)!;
    expect(JSON.stringify(last)).toBe(
      `{"at":"2026-03-02T15:07:00Z","outcome":"finished","records":2,"watermark":"${T0}","degraded":false,"summary":"answered one"}`,
    );
    expect(existsSync(lockFile(bot))).toBe(false);
    expect(git(bot.root, "log", "-1", "--format=%s").trim()).toBe("chore(cycle): finished, 2 records");
    expect(git(bot.root, "status", "--porcelain").trim()).toBe("");
  });

  test("refuses a future watermark", () => {
    bot = makeBot();
    writeStream(bot, [item(1)]);
    cli(bot, ["cycle", "begin"], { now: "2026-03-02T16:00:00Z" });
    const r = cli(bot, ["cycle", "end", "--records", "0"], { now: T0 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("later than the clock");
    expect(existsSync(lockFile(bot))).toBe(false);
  });

  test("refuses a backwards move", () => {
    bot = makeBot();
    writeStream(bot, [item(1)]);
    cli(bot, ["cycle", "begin"], { now: T0 });
    writeFileSync(join(bot.root, "logs/intake/watermark"), "2026-03-02T15:30:00Z\n");
    const before = readFileSync(join(bot.root, "logs/cycle.jsonl"), "utf8");
    const r = cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:40:00Z" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("would move backwards");
    expect(readFileSync(join(bot.root, "logs/cycle.jsonl"), "utf8")).toBe(before);
  });

  test("refuses when no check has logged since the lock was taken", () => {
    bot = makeBot();
    cli(bot, ["check"], { now: "2026-03-02T14:00:00Z" });
    writeFileSync(lockFile(bot), JSON.stringify({ pid: String(process.pid), session: "", started: T0 }));
    const r = cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:05:00Z" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no check has logged since this cycle began");
  });

  test("--degraded leaves the watermark alone", () => {
    bot = makeBot();
    cli(bot, ["cycle", "begin"], { now: "2026-03-02T14:00:00Z" });
    bot.env.FIXTURE_STREAM_EXIT = "1";
    expect(cli(bot, ["cycle", "begin"], { now: T0 }).code).toBe(20);
    const r = cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: "2026-03-02T15:02:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("(held: degraded)");
    expect(wm(bot)).toBe("2026-03-02T14:00:00Z");
  });

  test("refuses another session's lock", () => {
    bot = makeBot();
    writeStream(bot, [item(1)]);
    cli(bot, ["cycle", "begin"], { now: T0, env: { CLAUDE_CODE_SESSION_ID: "a" } });
    const r = cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:01:00Z", env: { CLAUDE_CODE_SESSION_ID: "b" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("session a holds the checkout");
    expect(existsSync(lockFile(bot))).toBe(true);
  });

  test("--records is required and must be a whole number", () => {
    bot = makeBot();
    expect(cli(bot, ["cycle", "end"]).code).toBe(2);
    expect(cli(bot, ["cycle", "end", "--records", "two"]).code).toBe(2);
  });
});

describe("state commands", () => {
  test("outage record / end / list", () => {
    bot = makeBot();
    expect(cli(bot, ["outage", "record", "plan-limit", "--note", "usage ran out"], { now: T0 }).code).toBe(0);
    let r = cli(bot, ["outage", "list"]);
    expect(r.out).toContain("1 outages · 1 open");
    expect(r.out).toContain("plan-limit");
    expect(cli(bot, ["outage", "end"], { now: "2026-03-02T16:00:00Z" }).code).toBe(0);
    r = cli(bot, ["outage", "list"]);
    expect(r.out).toContain("1 outages · 0 open");
    expect(cli(bot, ["outage", "end"]).out).toContain("no-op");
    expect(cli(bot, ["outage", "record", "napping"]).code).toBe(2);
  });

  test("outage lines an earlier bot wrote into the cycle log are read too", () => {
    bot = makeBot();
    mkdirSync(join(bot.root, "logs"), { recursive: true });
    writeFileSync(
      join(bot.root, "logs/cycle.jsonl"),
      `{"at":"${T0}","outcome":"outage","kind":"stopped","started":"2026-03-02T13:00:00Z","ended":null,"note":"old"}\n`,
    );
    expect(cli(bot, ["outage", "list"]).out).toContain("1 open");
  });

  test("lock status and release", () => {
    bot = makeBot();
    expect(cli(bot, ["lock", "status"]).out.trim()).toBe("lock: free");
    writeFileSync(lockFile(bot), JSON.stringify({ pid: String(process.pid), session: "x", started: "2026-03-02T14:59:00Z" }));
    const st = cli(bot, ["lock", "status"], { now: T0 });
    expect(st.out).toContain("state: held");
    expect(st.out).toContain("alive: yes");
    expect(cli(bot, ["lock", "release"], { now: T0 }).code).toBe(1);
    expect(cli(bot, ["lock", "release", "--abandon"], { now: T0 }).code).toBe(0);
    expect(existsSync(lockFile(bot))).toBe(false);
  });

  test("log tail", () => {
    bot = makeBot();
    expect(cli(bot, ["log", "tail"]).out).toContain("0 lines");
    for (const t of ["2026-03-02T15:00:00Z", "2026-03-02T15:10:00Z", "2026-03-02T15:20:00Z"]) cli(bot, ["check"], { now: t });
    const r = cli(bot, ["log", "tail", "--n", "2"]);
    expect(r.out).toContain("2 of 3 lines");
    expect(r.out).toContain("2026-03-02T15:20:00Z");
    expect(r.out).not.toContain("2026-03-02T15:00:00Z,");
  });
});
