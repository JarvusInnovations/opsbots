/**
 * A fast cycle (specs/skills/opsbot-core.md, A fast cycle; plans/fast-wake.md): the core's own
 * poller (`wake wait`) and the short arm call, a wake that checks only the inputs its file names,
 * and `cycle end` that reports what arrived while the cycle worked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SETTINGS, ENTRY, SHIM, cli, logOf, makeBot, makeExecutable, outagesOf, setSettings, watermarkOf, writeStream, type Bot } from "./helpers";
import { readEvents } from "../src/opsbot-core/transcript";
import { validateSettings, withDefaults } from "../src/opsbot-core/settings";
import { WAKE_BASE_NAME, lineCount, scheduleCommand, scheduleState, scheduleTimeoutMs, wakeWaitUntil } from "../src/opsbot-core/wake";

setDefaultTimeout(120000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const epoch = (t: string) => Date.parse(t) / 1000;
const MON_LOOP = { prompt: "testbot cycle: follow the opsbot-core skill, start with cycle begin", autocompact: "300k", schedule: "monitor" };
const ev = (o: Record<string, unknown>) => JSON.stringify(o);

/** Run a command; resolve with its stdout, exit code and how long it took. */
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

/** `wake wait --until <epoch>` in the bot's checkout, as the session's Monitor runs it. */
const wakeWait = (b: Bot, until: number, limitMs: number) => run(process.execPath, [ENTRY, "wake", "wait", "--until", String(until)], { cwd: b.root, env: b.env, limitMs });
const nowS = () => Math.floor(Date.now() / 1000);

/** The base record the last check would have written. */
function recordBase(b: Bot, lines: Record<string, number>) {
  writeFileSync(join(b.root, ".git", WAKE_BASE_NAME), `${JSON.stringify({ at: T0, lines })}\n`);
}

describe("wake wait: the poller in the core", () => {
  function waitBot(): { f: string; g: string } {
    bot = makeBot();
    const dir = join(bot.home, "wake");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "events.jsonl");
    const g = join(dir, "other.jsonl"); // not created yet: a missing file counts as empty
    setSettings(bot, { loop: MON_LOOP, wake: { files: [g, { file: f, inputs: ["10-file-stream"] }] } });
    return { f, g };
  }

  test("delivers a line appended after the recorded count at once, prefixed and cut to 300 characters; its output is the old poller's", async () => {
    const { f, g } = waitBot();
    writeFileSync(f, "one\ntwo\n");
    recordBase(bot, { [f]: 2, [g]: 0 });
    appendFileSync(f, `arrived mid-cycle\n${"y".repeat(400)}\n`);
    const r = await wakeWait(bot, nowS() + 30, 20_000);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`events.jsonl: arrived mid-cycle\nevents.jsonl: ${"y".repeat(300)}\n`);
    expect(r.ms).toBeLessThan(10_000); // no poll interval first (a cold `node` start on a loaded machine is most of it)
    const old = await run("bash", ["-c", scheduleCommand([g, f], 30, [0, 2])], { limitMs: 20_000 });
    expect(r.out).toBe(old.out);
  });

  test("waits otherwise, and delivers what arrives; at most 20 lines per file, the newest", async () => {
    const { f, g } = waitBot();
    writeFileSync(f, "old line\n");
    recordBase(bot, { [f]: 1, [g]: 0 });
    const p = wakeWait(bot, nowS() + 60, 40_000);
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    setTimeout(() => appendFileSync(f, lines.join("\n") + "\n"), 3_000);
    const r = await p;
    expect(r.code).toBe(0);
    expect(r.out).toBe(lines.slice(5).map((l) => `events.jsonl: ${l}\n`).join(""));
    expect(r.ms).toBeGreaterThanOrEqual(2_900);
    // the old poller, from the same count, prints the same
    writeFileSync(f, "old line\n");
    const q = run("bash", ["-c", scheduleCommand([g, f], 60, [0, 1])], { limitMs: 40_000 });
    setTimeout(() => appendFileSync(f, lines.join("\n") + "\n"), 3_000);
    expect((await q).out).toBe(r.out);
  });

  test("prints `cycle due` at its time when nothing arrives", async () => {
    const { f, g } = waitBot();
    writeFileSync(f, "old line\n");
    recordBase(bot, { [f]: 1, [g]: 0 });
    const r = await wakeWait(bot, nowS() + 4, 30_000);
    expect(r.code).toBe(0);
    expect(r.out).toBe("cycle due\n");
    expect(r.ms).toBeGreaterThanOrEqual(2_500);
  });

  test("a file shorter than its recorded count is delivered from its start; no record starts at the file's end", async () => {
    const { f, g } = waitBot();
    writeFileSync(f, "fresh one\nfresh two\n");
    recordBase(bot, { [f]: 9, [g]: 0 });
    expect((await wakeWait(bot, nowS() + 30, 20_000)).out).toBe("events.jsonl: fresh one\nevents.jsonl: fresh two\n");
    rmSync(join(bot.root, ".git", WAKE_BASE_NAME));
    const r = await wakeWait(bot, nowS() + 4, 30_000);
    expect(r.out).toBe("cycle due\n"); // the two lines were there before it started
  });

  test("refuses a time more than 1800 seconds ahead, and a bad --until (exit 2)", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: MON_LOOP } });
    const far = cli(bot, ["wake", "wait", "--until", String(epoch(T0) + 1801)], { now: T0 });
    expect(far.code).toBe(2);
    expect(far.out).toContain("1801 seconds ahead");
    expect(cli(bot, ["wake", "wait", "--until", "soon"], { now: T0 }).code).toBe(2);
    expect(cli(bot, ["wake", "wait"], { now: T0 }).code).toBe(2);
    expect(cli(bot, ["wake", "nap"], { now: T0 }).code).toBe(2);
    // a time already past: `cycle due` at once
    const past = cli(bot, ["wake", "wait", "--until", String(epoch(T0) - 5)], { now: T0 });
    expect(past.code).toBe(0);
    expect(past.out).toBe("cycle due\n");
  });
});

describe("the arm call is the short form; every form is read from the session log", () => {
  test("cycle begin, cycle end and a refused begin print `<core> wake wait --until <epoch>`", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: MON_LOOP, wake: { files: [join(tmpdir(), "opsbot-fast-none.jsonl")] } } });
    const b = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(b.code).toBe(0);
    // working hours, quiet: due in 600 s
    const call = `Monitor({ command: \\"${SHIM} wake wait --until ${epoch(T0) + 600}\\", description: \\"testbot schedule\\", timeout_ms: 660000 })`;
    expect(b.out).toContain(call);
    expect(b.out).not.toContain("end=$((");
    writeFileSync(join(bot.root, ".git", "index.lock"), "");
    const w = cli(bot, ["cycle", "begin"], { now: at(1) });
    expect(w.code).toBe(30);
    expect(w.out).toContain(`${SHIM} wake wait --until ${epoch(at(1)) + 600}`);
  });

  test("a session log holding either earlier shell form, or the new one, reads as armed until the right time", () => {
    bot = makeBot();
    const WF = "/tmp/opsbot-test-wake/events.jsonl";
    const FIRST = `end=$(( $(date +%s) + 600 )); c() { [ -f "$1" ] && wc -l < "$1" || echo 0; }; f0='${WF}'; n0=$(c "$f0"); while sleep 2; do h=0; m=$(c "$f0"); if [ "$m" -gt "$n0" ]; then tail -n $((m-n0)) "$f0" | cut -c1-300; n0=$m; h=1; fi; if [ "$h" = 1 ]; then exit 0; fi; if [ "$(date +%s)" -ge "$end" ]; then echo 'cycle due'; exit 0; fi; done`;
    const forms: Array<[string, string]> = [
      ["first shell form", FIRST],
      ["second shell form (from recorded counts)", scheduleCommand([WF], 600, [7])],
      ["wake wait", `${SHIM} wake wait --until ${epoch("2026-03-02T14:50:08Z")}`],
    ];
    for (const [name, command] of forms) {
      const p = join(bot.root, `${name.replace(/\W+/g, "-")}.jsonl`);
      writeFileSync(p, [
        ev({ type: "user", timestamp: "2026-03-02T14:40:00Z", message: { content: "testbot cycle" } }),
        ev({ type: "assistant", timestamp: "2026-03-02T14:40:08Z", message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command, description: "testbot schedule", timeout_ms: scheduleTimeoutMs(600) } }] } }),
      ].join("\n") + "\n");
      const evs = readEvents(p);
      expect([name, scheduleState(evs, "testbot", Date.parse("2026-03-02T14:45:00Z"))]).toEqual([name, { at: "2026-03-02T14:40:08Z", until: "2026-03-02T14:50:08Z" }]);
      expect([name, scheduleState(evs, "testbot", Date.parse("2026-03-02T14:50:09Z"))]).toEqual([name, null]);
    }
    expect(wakeWaitUntil(`${SHIM} wake wait --until 1772463008`)).toBe(1772463008);
    expect(wakeWaitUntil(FIRST)).toBeNull();
  });
});

// ------------------------------------------------------------------------------ the fast check

/**
 * A bot with two inputs: `30-chat` reads the chat stream its wake file announces, `40-mail` a
 * windowed stream (it prints only the items at or after OPSBOT_SINCE, as a real input does). Each
 * logs that it ran, with the OPSBOT_SINCE it was given. Two `cycle.d/begin/` scripts log too:
 * `10-sync` and `20-quick.fast`.
 */
function fastBot(extra: Record<string, unknown> = {}) {
  const b = makeBot({ points: [] });
  const d = (p: string) => join(b.home, p);
  const wake = d("chat-wake.jsonl");
  writeFileSync(d("chat.ndjson"), "");
  writeFileSync(d("mail.ndjson"), "");
  mkdirSync(join(b.root, "opsbot.d", "heartbeat.d"), { recursive: true });
  mkdirSync(join(b.root, "opsbot.d", "cycle.d", "begin"), { recursive: true });
  makeExecutable(join(b.root, "opsbot.d", "heartbeat.d", "30-chat"), `#!/usr/bin/env bash\necho "30-chat $OPSBOT_SINCE" >> "${d("ran.log")}"\ncat "${d("chat.ndjson")}"\n[ -e "${d("chat-fail")}" ] && { echo "chat down" >&2; exit 3; }\nexit 0\n`);
  makeExecutable(join(b.root, "opsbot.d", "heartbeat.d", "40-mail"), `#!/usr/bin/env bash\necho "40-mail $OPSBOT_SINCE" >> "${d("ran.log")}"\nwhile IFS= read -r l; do [ -z "$l" ] && continue; a=$(printf '%s' "$l" | sed 's/.*"at":"\\([^"]*\\)".*/\\1/'); [[ "$a" > "$OPSBOT_SINCE" || "$a" == "$OPSBOT_SINCE" ]] && printf '%s\\n' "$l"; done < "${d("mail.ndjson")}"\nexit 0\n`);
  makeExecutable(join(b.root, "opsbot.d", "cycle.d", "begin", "10-sync"), `#!/usr/bin/env bash\necho "10-sync" >> "${d("begin.log")}"\n`);
  makeExecutable(join(b.root, "opsbot.d", "cycle.d", "begin", "20-quick.fast"), `#!/usr/bin/env bash\necho "20-quick.fast" >> "${d("begin.log")}"\n`);
  setSettings(b, { loop: MON_LOOP, wake: { files: [{ file: wake, inputs: ["30-chat"] }] }, ...extra }, false);
  const { execSync } = require("node:child_process");
  execSync("git add -A && git commit -q -m fast", { cwd: b.root });
  const read = (p: string) => (existsSync(d(p)) ? readFileSync(d(p), "utf8").trim().split("\n").filter(Boolean) : []);
  let n = 0;
  return {
    b,
    wake,
    /** A chat message: on the stream, and a line in the wake file. */
    chat(when: string) {
      n++;
      appendFileSync(d("chat.ndjson"), JSON.stringify({ key: `chat:c:${n}`, at: when, conv: "c", kind: "dm", from: "p", text: `chat ${n}` }) + "\n");
      appendFileSync(wake, JSON.stringify({ n }) + "\n");
      return `chat:c:${n}`;
    },
    /** A mail: on its stream only, nothing in a wake file. */
    mail(when: string) {
      n++;
      appendFileSync(d("mail.ndjson"), JSON.stringify({ key: `mail:${n}`, at: when, conv: "inbox", kind: "mail", from: "q", text: `mail ${n}` }) + "\n");
      return `mail:${n}`;
    },
    ran: () => read("ran.log").map((l) => l.split(" ")[0]),
    since: () => read("ran.log").map((l) => l.split(" ")[1]),
    begun: () => read("begin.log"),
    reset() {
      rmSync(d("ran.log"), { force: true });
      rmSync(d("begin.log"), { force: true });
    },
    fail: (on: boolean) => (on ? writeFileSync(d("chat-fail"), "") : rmSync(d("chat-fail"), { force: true })),
    log: () => logOf(b),
    lastCheck() {
      const ls = this.log().filter((l) => ["new", "nothing-new", "degraded"].includes(String(l.outcome)));
      return ls[ls.length - 1]!;
    },
    watermark: () => watermarkOf(b),
  };
}

const keysIn = (out: string) => [...out.matchAll(/(chat:c:\d+|mail:\d+)/g)].map((m) => m[1]);

describe("a fast check", () => {
  test("runs only the named inputs with the last full check's window, leaves the watermark, logs `fast`; the next full check reports nothing twice and misses nothing", () => {
    const f = fastBot();
    bot = f.b;
    // a full check to start from: no counts were recorded before it
    const first = cli(bot, ["cycle", "begin"], { now: T0 });
    expect(first.code).toBe(0);
    // a quiet check is a quiet commit: its line says the kind (the Check trailer), not the reason
    expect(f.lastCheck().check).toBe("full");
    expect(f.ran()).toEqual(["30-chat", "40-mail"]);
    expect(f.begun()).toEqual(["10-sync", "20-quick.fast"]);
    const fullSince = f.since()[0];
    expect(f.watermark()).toBe(T0);

    // a chat message wakes it; a mail arrives too, which nothing announces
    f.reset();
    const c1 = f.chat(at(1));
    const m1 = f.mail(at(1));
    const b1 = cli(bot, ["cycle", "begin"], { now: at(2) });
    expect(b1.code).toBe(10);
    expect(f.ran()).toEqual(["30-chat"]);
    expect(f.since()).toEqual([fullSince!]); // the last full check's OPSBOT_SINCE
    expect(f.begun()).toEqual(["20-quick.fast"]);
    expect(keysIn(b1.out)).toEqual([c1]);
    expect(b1.out).toContain('fast: "30-chat; full check due 15:10Z"');
    const line = f.lastCheck();
    expect(line.fast).toBe(true);
    expect(line.check).toBe("fast");
    expect(Object.keys(line.inputs as object)).toEqual(["30-chat"]);
    expect(cli(bot, ["cycle", "end", "--records", "1"], { now: at(3) }).code).toBe(0);
    expect(f.watermark()).toBe(T0); // only a full check moves it

    // another fast cycle, with nothing new from the chat after all (a line for an item seen)
    f.reset();
    appendFileSync(f.wake, "{}\n");
    const b2 = cli(bot, ["cycle", "begin"], { now: at(5) });
    expect(b2.code).toBe(0);
    expect(b2.out).toContain("(held: fast check)");
    expect(f.ran()).toEqual(["30-chat"]);
    expect(f.lastCheck().fast).toBe(true);
    expect(f.watermark()).toBe(T0);

    // a third: a new chat message, the first not reported again
    const c2 = f.chat(at(6));
    const b3 = cli(bot, ["cycle", "begin"], { now: at(7) });
    expect(keysIn(b3.out)).toEqual([c2]);
    expect(cli(bot, ["cycle", "end", "--records", "1"], { now: at(7) }).code).toBe(0);
    expect(f.watermark()).toBe(T0);

    // the quiet deadline: a full check, which finds the mail once and no chat message again
    f.reset();
    const full = cli(bot, ["cycle", "begin"], { now: at(9) });
    expect(full.code).toBe(10);
    expect(f.lastCheck().check).toBe("full: no new wake-file lines (cycle due)");
    expect(f.lastCheck().fast).toBeUndefined();
    expect(f.ran()).toEqual(["30-chat", "40-mail"]);
    expect(f.begun()).toEqual(["10-sync", "20-quick.fast"]);
    expect(keysIn(full.out)).toEqual([m1]);
    expect(full.out).not.toContain("fast:");
    expect(cli(bot, ["cycle", "end", "--records", "1"], { now: at(10) }).code).toBe(0);
    expect(f.watermark()).toBe(at(9));
    // and the next full check finds nothing at all
    const again = cli(bot, ["cycle", "begin", "--full"], { now: at(12) });
    expect(again.code).toBe(0);
    expect(f.lastCheck().check).toBe("full");
  });

  test("each condition that forces a full check does", () => {
    const f = fastBot();
    bot = f.b;
    const reason = () => String(f.lastCheck().check);
    const cycle = (now: string, ...flags: string[]) => {
      const r = cli(bot, ["cycle", "begin", ...flags], { now });
      if (r.code !== 0 && r.code !== 30) cli(bot, ["cycle", "end", "--records", "0", ...(r.code === 20 ? ["--degraded"] : [])], { now });
      return r;
    };
    cycle(T0);
    // a wake from the file: fast
    f.chat(at(1));
    cycle(at(1));
    expect(reason()).toBe("fast");
    // --full
    f.chat(at(2));
    cycle(at(2), "--full");
    expect(reason()).toBe("full: --full");
    // a quiet deadline: a quiet check, whose line keeps the kind and not the reason
    cycle(at(3));
    expect(reason()).toBe("full");
    // a run of fast cycles does not postpone the full check past check.full_minutes
    for (const m of [5, 8, 11]) {
      f.chat(at(m));
      cycle(at(m));
      expect([m, reason()]).toEqual([m, "fast"]);
    }
    f.chat(at(13));
    cycle(at(13));
    expect(reason()).toBe("full: the last full check was 10 min ago");
    // a failed input: that check is degraded, and the next is full
    f.fail(true);
    f.chat(at(14));
    expect(cycle(at(14)).code).toBe(20);
    expect(reason()).toBe("fast");
    f.fail(false);
    f.chat(at(15));
    cycle(at(15));
    expect(reason()).toBe("full: the last check failed an input");
    // a file that names no inputs
    setSettings(bot, { wake: { files: [f.wake] } });
    f.chat(at(16));
    cycle(at(16));
    expect(reason()).toBe("full: chat-wake.jsonl names no inputs");
    // check.full_minutes: 0
    setSettings(bot, { wake: { files: [{ file: f.wake, inputs: ["30-chat"] }] }, check: { full_minutes: 0 } });
    f.chat(at(17));
    cycle(at(17));
    expect(reason()).toBe("full: check.full_minutes is 0");
  });

  test("the watchdog, the outage record and next-delay count a fast cycle as a cycle", () => {
    const f = fastBot({ check: { full_minutes: 60 } });
    bot = f.b;
    cli(bot, ["cycle", "begin"], { now: T0 });
    f.chat(at(40));
    expect(cli(bot, ["cycle", "begin"], { now: at(40) }).code).toBe(10);
    expect(f.lastCheck().fast).toBe(true);
    expect(cli(bot, ["cycle", "end", "--records", "1"], { now: at(41) }).code).toBe(0);
    // 70 minutes after the full check, 30 after the fast one: alive
    const w = cli(bot, ["watchdog", "--dry-run"], { now: at(70) });
    expect(w.out).toContain(`alive · last cycle ${at(41)}`);
    // the fast cycle's arrival keeps the cadence hot
    expect(cli(bot, ["next-delay"], { now: at(45) }).out).toContain("180 arrived in the last 15 minutes");
    // a begin 50 minutes after the fast cycle records no stop
    f.chat(at(91));
    cli(bot, ["cycle", "begin"], { now: at(91) });
    expect(outagesOf(bot)).toEqual([]);
  });
});

describe("cycle end reports what arrived while the cycle worked", () => {
  test("`arrived` and `next 0 arrived` with no `wake` field when a wake file grew since the check; the usual fields otherwise", () => {
    const f = fastBot();
    bot = f.b;
    cli(bot, ["cycle", "begin"], { now: T0 });
    f.chat(at(1));
    expect(cli(bot, ["cycle", "begin"], { now: at(1) }).code).toBe(10);
    f.chat(at(2));
    f.chat(at(2));
    const e = cli(bot, ["cycle", "end", "--records", "1"], { now: at(2) });
    expect(e.code).toBe(0);
    expect(e.out).toContain("arrived: 2 on chat-wake.jsonl");
    expect(e.out).toContain("next: 0 arrived");
    expect(e.out).not.toMatch(/^wake/m);
    expect(e.out).not.toContain("Monitor(");
    // the session begins again at once: a fast check finds both
    const again = cli(bot, ["cycle", "begin"], { now: at(2) });
    expect(again.code).toBe(10);
    expect(keysIn(again.out)).toEqual(["chat:c:2", "chat:c:3"]);
    const quiet = cli(bot, ["cycle", "end", "--records", "2"], { now: at(3) });
    expect(quiet.out).not.toContain("arrived:");
    expect(quiet.out).toContain("next: 180 arrived in the last 15 minutes");
    expect(quiet.out).toContain("arm now: Monitor(");
  });

  test("a cycle whose begin failed before its check does not loop on old arrivals", () => {
    const f = fastBot();
    bot = f.b;
    cli(bot, ["cycle", "begin"], { now: T0 });
    f.chat(at(1));
    makeExecutable(join(bot.root, "opsbot.d", "cycle.d", "begin", "20-quick.fast"), "#!/usr/bin/env bash\nexit 4\n");
    expect(cli(bot, ["cycle", "begin"], { now: at(1) }).code).toBe(20);
    const e = cli(bot, ["cycle", "end", "--records", "0", "--degraded"], { now: at(2) });
    expect(e.out).not.toContain("arrived:");
    expect(e.out).toContain("arm now: Monitor(");
  });

  test("with `sleep` deciding to go down in the same cycle end, an arrival wins", () => {
    for (const grows of [false, true]) {
      const b = makeBot();
      try {
        const wf = join(b.home, "events.jsonl");
        writeFileSync(wf, "");
        setSettings(b, { loop: MON_LOOP, wake: { files: [wf] }, sleep: {} });
        cli(b, ["check"], { now: T0 });
        writeStream(b, [{ key: "chat:c:1", at: at(63), conv: "c", kind: "group", from: "p", text: "hi" }]);
        expect(cli(b, ["cycle", "begin"], { now: at(63) }).code).toBe(10);
        if (grows) appendFileSync(wf, "{}\n");
        const late = cli(b, ["cycle", "end", "--records", "1"], { now: at(124) });
        expect(late.code).toBe(0);
        if (grows) {
          expect(late.out).toContain("arrived: 1 on events.jsonl");
          expect(late.out).not.toContain("sleep");
          expect(existsSync(join(b.root, ".git", "opsbot-sleep"))).toBe(false);
        } else {
          expect(late.out).toContain("sleep");
          expect(existsSync(join(b.root, ".git", "opsbot-sleep"))).toBe(true);
        }
      } finally {
        b.cleanup();
      }
    }
  });
});

describe("wake.files entries", () => {
  test("a string or {file, inputs}; anything else is named", () => {
    const base = { ...BASE_SETTINGS };
    expect(validateSettings({ ...base, wake: { files: ["/a", { file: "/b", inputs: ["20-slack-events"] }, { file: "/c" }] } })).toEqual([]);
    expect(validateSettings({ ...base, wake: { files: [{ inputs: ["x"] }] } })).toEqual(["wake.files[].file must be a non-empty file path"]);
    expect(validateSettings({ ...base, wake: { files: [{ file: "/b", inputs: "x" }] } })[0]).toContain("must be an array of heartbeat.d script names");
    expect(validateSettings({ ...base, wake: { files: [{ file: "/b", input: ["x"] }] } })).toEqual(["unknown key wake.files[].input"]);
    expect(validateSettings({ ...base, wake: { files: [3] } })[0]).toContain("strings) or {file, inputs} objects");
    expect(validateSettings({ ...base, check: { full_minutes: -1 } })[0]).toContain("check.full_minutes");
    const s = withDefaults({ ...base, wake: { files: ["/a", { file: "/b", inputs: ["20-slack-events"] }] } });
    expect(s.wake.files).toEqual(["/a", "/b"]);
    expect(s.wake.entries).toEqual([{ file: "/a", inputs: null }, { file: "/b", inputs: ["20-slack-events"] }]);
    expect(s.check.full_minutes).toBe(10);
    expect(withDefaults({ ...base, check: { full_minutes: 0 } }).check.full_minutes).toBe(0);
  });

  test("the sleep timer and the per-file monitors read the object form", () => {
    bot = makeBot();
    const wf = join(bot.home, "events.jsonl");
    writeFileSync(wf, "a\n");
    setSettings(bot, { wake: { files: [{ file: wf, inputs: ["10-file-stream"] }] } });
    const pack = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(pack).toContain(`new lines in ${wf}`);
    expect(lineCount(wf)).toBe(1);
  });
});
