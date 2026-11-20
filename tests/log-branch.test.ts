/**
 * The loop's log on its own branch (specs/behaviors/log-branch.md, plans/log-branch-core.md):
 * opt-in with `log.branch`, written through gitsheets-axi, never the working tree.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASE_SETTINGS, cli, git, makeBot, makeExecutable, setSettings, writeStream, type Bot } from "./helpers";
import { nextDelay } from "../src/opsbot-core/cadence";
import { decideFast } from "../src/opsbot-core/fast";
import { decideSleep, silenceFrom } from "../src/opsbot-core/sleep";
import { cycleBegunSince, keySeen } from "../src/opsbot-core/backstop";
import { logSummary } from "../src/opsbot-core/commands/coldstart";
import { lastHookFailure } from "../src/opsbot-core/commands/liveness";
import { lastCycleAt, lastCycleTime, outages, readCycleLog, readWatermark } from "../src/opsbot-core/state";
import { withDefaults } from "../src/opsbot-core/settings";

setDefaultTimeout(120_000);

const B = "opsbot/log";
const LOG = { log: { branch: B } };
let bots: Bot[] = [];
afterEach(() => {
  for (const b of bots) b.cleanup();
  bots = [];
});

function bot(opts: { settings?: Record<string, unknown>; points?: string[]; remote?: boolean } = {}): Bot {
  const b = makeBot({ settings: opts.settings ?? { ...BASE_SETTINGS, ...LOG }, points: opts.points });
  bots.push(b);
  if (opts.remote !== false) {
    const remote = join(b.home, "remote.git");
    git(b.home, "init", "-q", "--bare", remote);
    git(b.root, "remote", "add", "origin", remote);
    git(b.root, "push", "-q", "origin", "main");
  }
  return b;
}

const item = (n: number, at: string) => ({ key: `chat:c:${n}`, at, conv: "c", kind: "group", from: "p", text: `hi ${n}` });

function tryGit(root: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  trailers: Record<string, string>;
}

/** The log branch's commits, newest first, along the first parent. */
function logCommits(root: string, ref = B): Commit[] {
  const out = tryGit(root, "log", "--first-parent", "--format=%x1e%H%x1f%P%x1f%s%x1f%(trailers:only,unfold)", ref);
  if (out === null) return [];
  return out
    .split("\x1e")
    .filter((x) => x.trim())
    .map((block) => {
      const [hash = "", parents = "", subject = "", tr = ""] = block.split("\x1f");
      const trailers: Record<string, string> = {};
      for (const l of tr.split("\n")) {
        const m = l.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (m) trailers[m[1]!] = m[2]!;
      }
      return { hash: hash.trim(), parents: parents.trim().split(/\s+/).filter(Boolean), subject, trailers };
    });
}

const head = (b: Bot) => git(b.root, "rev-parse", "HEAD").trim();
const status = (b: Bot) => git(b.root, "status", "--porcelain").trim();

function begin(b: Bot, now: string) {
  return cli(b, ["cycle", "begin"], { now });
}
function end(b: Bot, now: string, records = 1, extra: string[] = []) {
  return cli(b, ["cycle", "end", "--records", String(records), ...extra], { now });
}

describe("settings", () => {
  test("log.branch validates, and is refused as the checked-out branch or without gitsheets-axi 2.15", () => {
    const b = bot({ remote: false });
    expect(cli(b, ["settings", "validate"]).code).toBe(0);
    setSettings(b, { log: { branch: "main" } });
    const same = cli(b, ["settings", "validate"]);
    expect(same.code).toBe(1);
    expect(same.out).toContain("is the branch checked out here");
    setSettings(b, { log: { branch: "bad..name" } });
    expect(cli(b, ["settings", "validate"]).out).toContain("log.branch must be a branch name");
    setSettings(b, { log: { branch: B, ledgers: {} } });
    expect(cli(b, ["settings", "validate"]).out).toContain("unknown key log.ledgers");
    setSettings(b, LOG);
    const old = join(b.home, "old-gitsheets");
    makeExecutable(old, "#!/usr/bin/env bash\necho 2.14.0\n");
    const r = cli(b, ["settings", "validate"], { env: { OPSBOT_GITSHEETS_AXI: old } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("log.branch needs gitsheets-axi 2.15.0 or later (found 2.14.0)");
  });
});

describe("a cycle on the log branch", () => {
  test("a cycle that found something is one log commit; the program branch and working tree are untouched", () => {
    const b = bot();
    const before = head(b);
    writeStream(b, [item(1, "2026-03-02T14:58:00Z")]);
    expect(begin(b, "2026-03-02T15:00:00Z").code).toBe(10);
    // inside the cycle nothing is committed yet: the check rides the cycle's one commit
    expect(logCommits(b.root)).toHaveLength(0);
    const r = end(b, "2026-03-02T15:03:00Z");
    expect(r.code).toBe(0);
    expect(r.out).toContain("finished · 1 records · watermark 2026-03-02T15:00:00Z");
    const commits = logCommits(b.root);
    expect(commits).toHaveLength(2); // the root, then the cycle
    const files = git(b.root, "show", "--name-only", "--format=", commits[0]!.hash).trim().split("\n").sort();
    expect(files.filter((f) => f.startsWith("cycles/"))).toEqual(["cycles/2026/03/02/15/0000-new.toml", "cycles/2026/03/02/15/0300-finished.toml"]);
    expect(files.filter((f) => f.startsWith("seen/"))).toHaveLength(1);
    expect(head(b)).toBe(before);
    expect(status(b)).toBe("");
    expect(existsSync(join(b.root, "logs"))).toBe(false);
    // pushed: the remote has the cycle
    expect(git(b.root, "rev-parse", `refs/remotes/origin/${B}`).trim()).toBe(commits[0]!.hash);
  });

  test("Program, Watermark and Check on every log commit; the second parent only where the program moved", () => {
    const b = bot();
    const p1 = head(b);
    begin(b, "2026-03-02T15:00:00Z");
    begin(b, "2026-03-02T15:10:00Z");
    writeStream(b, [item(1, "2026-03-02T15:15:00Z")]);
    begin(b, "2026-03-02T15:20:00Z");
    end(b, "2026-03-02T15:21:00Z");
    // the program moves
    writeFileSync(join(b.root, "rules.md"), "# Rule card\n\n1. Changed.\n");
    git(b.root, "commit", "-q", "-am", "rules");
    const p2 = head(b);
    writeStream(b, []);
    begin(b, "2026-03-02T15:30:00Z");
    begin(b, "2026-03-02T16:05:00Z");
    const commits = logCommits(b.root).reverse();
    const [root, ...rest] = commits;
    expect(root!.parents).toEqual([]);
    expect(rest).toHaveLength(4);
    for (const c of rest) {
      expect(c.trailers.Program).toMatch(/^[0-9a-f]{40}$/);
      expect(c.trailers.Watermark).toBeDefined();
      expect(c.trailers.Check).toMatch(/^(full|fast)$/);
    }
    expect(rest.map((c) => c.parents.slice(1))).toEqual([[p1], [], [p2], []]);
    expect(rest.map((c) => c.trailers.Program)).toEqual([p1, p1, p2, p2]);
  });

  test.todo("two cycles with the same outcome and counts share one blob (blocked: gitsheets keeps a path's fields in the record, so `at` is in the body)");

  test("ten quiet cycles in an hour are one commit; the hour and a cycle that found something seal it", () => {
    const b = bot();
    for (let m = 0; m < 50; m += 5) expect(begin(b, `2026-03-02T15:${String(m).padStart(2, "0")}:00Z`).code).toBe(0);
    let commits = logCommits(b.root);
    expect(commits).toHaveLength(2);
    const run1 = commits[0]!;
    expect(run1.trailers["Quiet-Cycles"]).toBe("10");
    expect(run1.trailers["Quiet-Since"]).toBe("2026-03-02T15:00:00Z");
    expect(run1.trailers["Quiet-Until"]).toBe("2026-03-02T15:45:00Z");
    expect(run1.trailers.Watermark).toBe("2026-03-02T15:45:00Z");
    // a quiet commit changes no record
    expect(git(b.root, "rev-parse", `${run1.hash}^{tree}`)).toBe(git(b.root, "rev-parse", `${run1.parents[0]}^{tree}`));
    // the open run is not pushed; the push sends the branch up to the newest sealed commit
    expect(git(b.root, "rev-parse", `refs/remotes/origin/${B}`).trim()).toBe(run1.parents[0]!);

    // the hour turns: sealed, and a new run starts on top of it
    begin(b, "2026-03-02T16:01:00Z");
    commits = logCommits(b.root);
    expect(commits).toHaveLength(3);
    expect(commits[1]!.hash).toBe(run1.hash);
    expect(commits[0]!.trailers["Quiet-Cycles"]).toBe("1");
    expect(git(b.root, "rev-parse", `refs/remotes/origin/${B}`).trim()).toBe(run1.hash);

    // a cycle that found something seals the open run
    begin(b, "2026-03-02T16:06:00Z");
    const run2 = logCommits(b.root)[0]!;
    expect(run2.trailers["Quiet-Cycles"]).toBe("2");
    writeStream(b, [item(1, "2026-03-02T16:08:00Z")]);
    begin(b, "2026-03-02T16:10:00Z");
    end(b, "2026-03-02T16:11:00Z");
    writeStream(b, []);
    begin(b, "2026-03-02T16:15:00Z");
    commits = logCommits(b.root);
    expect(commits.map((c) => c.trailers["Quiet-Cycles"] ?? "-")).toEqual(["1", "-", "2", "10", "-"]);
    expect(commits[2]!.hash).toBe(run2.hash);
  });

  test("a pushed quiet commit is never replaced: the next quiet cycle starts a new one", () => {
    const b = bot();
    begin(b, "2026-03-02T15:00:00Z");
    const open = logCommits(b.root)[0]!;
    // someone pushes the open tip (another clone, a person): it is published now
    git(b.root, "push", "-q", "origin", B);
    const r = begin(b, "2026-03-02T15:05:00Z");
    expect(r.code).toBe(0);
    const commits = logCommits(b.root);
    expect(commits[1]!.hash).toBe(open.hash);
    expect(commits[0]!.trailers["Quiet-Cycles"]).toBe("1");
  });

  test("a refused push fails the check and loses nothing", () => {
    const b = bot();
    begin(b, "2026-03-02T15:00:00Z");
    begin(b, "2026-03-02T16:00:00Z");
    // another host writes the same bot's log
    const other = join(b.home, "other");
    git(b.home, "clone", "-q", "-b", "main", join(b.home, "remote.git"), other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.invalid");
    git(other, "checkout", "-q", B);
    git(other, "commit", "-q", "--allow-empty", "-m", "another host");
    git(other, "push", "-q", "origin", B);
    const theirs = git(other, "rev-parse", "HEAD").trim();
    writeStream(b, [item(1, "2026-03-02T16:08:00Z")]);
    expect(begin(b, "2026-03-02T16:10:00Z").code).toBe(10);
    const r = end(b, "2026-03-02T16:11:00Z");
    expect(r.code).toBe(20);
    expect(r.out).toContain("log push refused");
    expect(r.out).toContain(theirs.slice(0, 12));
    // nothing lost: the cycle is on the local branch, the checkout released
    const commits = logCommits(b.root);
    expect(commits[0]!.subject).toContain("finished, 1 records");
    expect(existsSync(join(b.root, ".git", "opsbot-cycle.lock"))).toBe(false);
    // and at cycle begin a refused push is a failed check too, with the checkout held
    writeStream(b, []);
    const q = begin(b, "2026-03-02T17:00:00Z");
    expect(q.code).toBe(20);
    expect(q.out).toContain("log push refused");
    expect(existsSync(join(b.root, ".git", "opsbot-cycle.lock"))).toBe(true);
  });

  test("a cold start in a fresh clone resumes from the newest pushed Watermark and reports nothing twice", () => {
    const b = bot();
    writeStream(b, [item(1, "2026-03-02T14:58:00Z"), item(2, "2026-03-02T14:59:00Z")]);
    expect(begin(b, "2026-03-02T15:00:00Z").code).toBe(10);
    end(b, "2026-03-02T15:02:00Z", 2);
    expect(begin(b, "2026-03-02T15:10:00Z").code).toBe(0); // open quiet run, unpushed
    const clone = join(b.home, "clone");
    git(b.home, "clone", "-q", "-b", "main", join(b.home, "remote.git"), clone);
    git(clone, "config", "user.name", "Test");
    git(clone, "config", "user.email", "test@example.invalid");
    const c: Bot = { root: clone, home: b.home, env: { ...b.env }, cleanup: () => {} };
    const r = cli(c, ["cycle", "begin"], { now: "2026-03-02T15:20:00Z" });
    expect(r.out).toContain("nothing new");
    expect(r.code).toBe(0);
    // it read from the pushed watermark (the cycle's), not the unpushed quiet run's
    const commits = logCommits(clone);
    expect(commits[0]!.trailers.Since).toBe("2026-03-02T14:30:00Z");
    expect(commits[1]!.subject).toContain("finished, 2 records");
  });

  test("a hook that times out is on the log branch before the cycle ends, and the watchdog quotes it", () => {
    const b = bot({ points: ["heartbeat.d", "escalate.d"] });
    begin(b, "2026-03-02T15:00:00Z");
    const dir = join(b.root, "opsbot.d", "cycle.d", "begin");
    mkdirSync(dir, { recursive: true });
    makeExecutable(join(dir, "10-slow"), "#!/usr/bin/env bash\nexec sleep 5\n");
    git(b.root, "add", "opsbot.d");
    git(b.root, "commit", "-q", "-m", "a slow hook");
    const r = cli(b, ["cycle", "begin"], { now: "2026-03-02T15:10:00Z", env: { OPSBOT_TEST_SCRIPT_TIMEOUT_MS: "500" } });
    expect(r.code).toBe(20);
    expect(r.out).toContain("timed out");
    const tip = logCommits(b.root)[0]!;
    expect(tip.subject).toContain("cycle.d/begin/10-slow failed");
    const rec = git(b.root, "show", `${tip.hash}:cycles/2026/03/02/15/1000-degraded.toml`);
    expect(rec).toContain("timed out");
    // the cycle never ends; an hour on, the watchdog says what stopped it
    const w = cli(b, ["watchdog", "--dry-run"], { now: "2026-03-02T16:20:00Z" });
    expect(w.out).toContain("stopped since 2026-03-02T15:10:00Z");
    expect(w.out).toContain("The last cycle to begin stopped at its hook: cycle.d/begin/10-slow at 2026-03-02T15:10:00Z, exit 124: timed out");
  });

  test("an outage recorded outside a cycle rides the next cycle's commit", () => {
    const b = bot();
    begin(b, "2026-03-02T15:00:00Z");
    expect(cli(b, ["outage", "record", "refused", "--started", "2026-03-02T15:05:00Z", "--note", "the plan said no"], { now: "2026-03-02T15:06:00Z" }).code).toBe(0);
    expect(status(b)).toBe("");
    expect(cli(b, ["outage", "list"], { now: "2026-03-02T15:07:00Z" }).out).toContain("refused");
    const r = begin(b, "2026-03-02T15:10:00Z");
    expect(r.code).toBe(0);
    const tip = logCommits(b.root)[0]!;
    // not a quiet commit: it carries a record
    expect(tip.trailers["Quiet-Cycles"]).toBeUndefined();
    const files = git(b.root, "show", "--name-only", "--format=", tip.hash);
    expect(files).toContain("outages/2026/03/02/0600-refused.toml");
    expect(files).toContain("cycles/2026/03/02/15/1000-nothing-new.toml");
    expect(existsSync(join(b.root, ".git", "opsbot-log-pending.json"))).toBe(false);
  });
});

describe("readers give the same answers from the branch as from the files", () => {
  // a recorded run: quiet stretches, arrivals, a degraded input, the hour turning
  const STEPS: Array<{ at: string; items?: Array<Record<string, unknown>>; fail?: boolean; end?: string }> = [
    { at: "2026-03-02T14:00:00Z" },
    { at: "2026-03-02T14:10:00Z" },
    { at: "2026-03-02T14:20:00Z" },
    { at: "2026-03-02T14:30:00Z", items: [item(1, "2026-03-02T14:25:00Z")], end: "2026-03-02T14:34:00Z" },
    { at: "2026-03-02T14:40:00Z" },
    { at: "2026-03-02T14:50:00Z" },
    { at: "2026-03-02T15:00:00Z" },
    { at: "2026-03-02T15:10:00Z", fail: true, end: "2026-03-02T15:11:00Z" },
    { at: "2026-03-02T15:20:00Z" },
    { at: "2026-03-02T15:30:00Z", items: [item(2, "2026-03-02T15:28:00Z"), item(3, "2026-03-02T15:29:00Z")], end: "2026-03-02T15:36:00Z" },
    { at: "2026-03-02T15:45:00Z" },
    { at: "2026-03-02T16:05:00Z" },
    { at: "2026-03-02T16:15:00Z" },
  ];

  function replay(b: Bot) {
    for (const s of STEPS) {
      writeStream(b, s.items ?? []);
      const env: Record<string, string> = s.fail ? { FIXTURE_STREAM_EXIT: "3" } : {};
      const r = cli(b, ["cycle", "begin"], { now: s.at, env });
      if (s.end) cli(b, ["cycle", "end", "--records", String(s.items?.length ?? 0), ...(s.fail ? ["--degraded"] : [])], { now: s.end });
      else expect(r.code).toBe(0);
    }
  }

  test("the watchdog, next-delay, the sleep timer, the cold-start pack, the fast-check window and the wake backstop", () => {
    const sleepy = { ...BASE_SETTINGS, loop: { ...BASE_SETTINGS.loop, prompt: "Run one cycle.", schedule: "monitor" }, sleep: { after_minutes: 30 } };
    const files = bot({ settings: sleepy, remote: false });
    const branch = bot({ settings: { ...sleepy, ...LOG } });
    replay(files);
    replay(branch);
    expect(existsSync(join(files.root, "logs", "cycle.jsonl"))).toBe(true);
    expect(existsSync(join(branch.root, "logs"))).toBe(false);
    const s = withDefaults({ ...sleepy, wake: { files: [join(files.home, "wake.log")] } } as Record<string, unknown>);
    // a fast check: a wake file grew, its inputs named
    const sFast = withDefaults({ ...sleepy, wake: { files: [{ file: "w.log", inputs: ["10-file-stream"] }] } } as Record<string, unknown>);

    for (const nowIso of ["2026-03-02T16:16:00Z", "2026-03-02T16:40:00Z", "2026-03-02T17:30:00Z"]) {
      const now = Date.parse(nowIso);
      const answers = (root: string) => {
        const lines = readCycleLog(root);
        return {
          last: lastCycleAt(lines),
          liveness: lastCycleTime(root),
          watermark: readWatermark(root),
          next: nextDelay(s, lines, now),
          silence: silenceFrom(lines, null, now, lastCycleAt(lines)),
          sleep: decideSleep(root, s, "{}", lines, now, [], "cycle end").sleep,
          fast: decideFast({ s: sFast, forceFull: false, lines, base: { "w.log": 1 }, counts: { "w.log": 2 }, installed: ["10-file-stream", "20-quiet-stream"], watermark: readWatermark(root), now: Date.parse("2026-03-02T16:16:00Z") }),
          pack: logSummary(root, now),
          outages: outages(root),
          hook: lastHookFailure(lines),
          begunSince: [Date.parse("2026-03-02T16:00:00Z"), Date.parse("2026-03-02T16:15:00Z")].map((t) => cycleBegunSince(root, t)),
          seen: ["chat:c:1", "chat:c:3", "chat:c:9"].map((k) => keySeen(root, k)),
        };
      };
      expect(answers(branch.root)).toEqual(answers(files.root));
    }
  });
});
