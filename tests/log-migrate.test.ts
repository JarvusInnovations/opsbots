/**
 * Moving a bot from the log files to the log branch (plans/log-branch-migrate.md): `log migrate`,
 * one writer at a time, and the settings the files needed. The fixture is a bot as the release
 * before this one leaves it: the kit's cycle log (with an older bot's outage line, a torn line and
 * lines its last cycle never committed), seen keys, watermark, outages, two post logs, three
 * action ledgers (one with lines nothing can parse), a baseline, two routine runs, a tracked probe
 * log no setting names, and a config file a hook reads.
 */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASE_SETTINGS, cli, git, logOf, makeBot, makeExecutable, writeStream, type Bot } from "./helpers";
import { branchLastCycleAt, branchSeen, branchWatermark, forgetLogBranch, sheetRecords, type Rec, type Sheet } from "../src/opsbot-core/log";

// every cycle writes through gitsheets-axi (the log branch): a test of several takes seconds
setDefaultTimeout(120_000);

const B = "opsbot/log";
const PREP = "opsbot/log-migrate";
let bots: Bot[] = [];
afterEach(() => {
  for (const b of bots) b.cleanup();
  bots = [];
});

const T = "2026-03-02T15:00:00Z";
const LISTED = [
  "logs/cycle.jsonl",
  "logs/intake/seen",
  "logs/intake/watermark",
  "logs/actions/labels.jsonl",
  "logs/actions/sent.jsonl",
  "logs/actions/rows.jsonl",
  "state/probe-baseline.json",
  "logs/slack-posts.jsonl",
  "logs/whatsapp-posts.jsonl",
];

const check = (at: string, outcome: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ at, outcome, inputs: { "10-file-stream": { ok: true, new: outcome === "new" ? 1 : 0 } }, new: outcome === "new" ? 1 : 0, failed: [], watermark: "2026-03-01T09:00:00Z", check: "full", since: "2026-03-01T08:30:00Z", ...extra });

/** The files, as the release before this one wrote them. Committed in two commits, with lines the
 * last cycle never committed. */
const CYCLE_COMMITTED = [
  check("2026-03-01T09:00:00Z", "nothing-new"),
  check("2026-03-01T09:10:00Z", "new"),
  JSON.stringify({ at: "2026-03-01T09:12:00Z", outcome: "finished", records: 1, watermark: "2026-03-01T09:10:00Z", degraded: false }),
  // an older bot wrote its outages into the cycle log
  JSON.stringify({ at: "2026-03-01T10:00:00Z", outcome: "outage", kind: "stopped", started: "2026-03-01T09:12:00Z", ended: "2026-03-01T10:00:00Z", note: "no cycle" }),
  JSON.stringify({ at: "2026-03-01T10:05:00Z", outcome: "sleep", by: "cycle end", quiet_since: "2026-03-01T09:12:00Z", due: "2026-03-01T13:00:00Z" }),
  JSON.stringify({ at: "2026-03-01T11:00:00Z", outcome: "wake", reason: "a line", latency_s: 3, slept_from: "2026-03-01T10:05:00Z" }),
  JSON.stringify({ at: "2026-03-01T11:30:00Z", outcome: "memory-review", kept: 4, updated: 1, removed: 0, added: 1 }),
  // the same second and outcome as the line after it, with other content: one path, two records
  JSON.stringify({ at: "2026-03-01T12:00:00Z", outcome: "finished", records: 2, watermark: "2026-03-01T11:55:00Z", degraded: false }),
  JSON.stringify({ at: "2026-03-01T12:00:00Z", outcome: "finished", records: 3, watermark: "2026-03-01T11:55:00Z", degraded: false }),
  '{"at":"2026-03-01T12:30:00Z","outcome":"fini',
];
const CYCLE_UNCOMMITTED = [check("2026-03-02T09:00:00Z", "new"), check("2026-03-02T09:10:00Z", "nothing-new")];
const SEEN = ["chat:c:1", "chat:c:2", "mail:m:9", "slack:C1:1700000000.000100"];
const OUTAGES = [
  JSON.stringify({ at: "2026-03-01T14:00:00Z", outcome: "outage", kind: "plan-limit", started: "2026-03-01T13:00:00Z", ended: null, note: "usage ran out" }),
  JSON.stringify({ at: "2026-03-01T15:00:00Z", outcome: "outage-end", started: "2026-03-01T13:00:00Z", ended: "2026-03-01T15:00:00Z" }),
];
const LABELS = ["t1", "t2", "t3"].map((t, i) => JSON.stringify({ at: `2026-03-01T09:0${i}:00Z`, thread: t, label: "needs-reply" }));
const SENT = [JSON.stringify({ at: "2026-03-01T09:30:00Z", to: "a@example.invalid", subject: "hello" }), JSON.stringify({ to: "b@example.invalid", subject: "no time of its own" })];
const ROWS = [JSON.stringify({ at: "2026-03-01T10:00:00Z", row: 4 }), "row 5 written by hand", "[1,2,3]", JSON.stringify({ at: "2026-03-01T10:05:00Z", row: 6, hash: "mine" })];
const SLACK = [
  JSON.stringify({ at: "2026-03-01T09:13:00Z", conv: "C1", posted: true, ts: "1.1" }),
  JSON.stringify({ at: "2026-03-01T09:14:00Z", conv: "C1", posted: false, blocked: "screen" }),
];
const WA = [JSON.stringify({ at: "2026-03-01T09:20:00Z", chat: "g1", posted: true, id: "ABCDEF0123456789" }), JSON.stringify({ at: "2026-03-01T09:21:00Z", chat: "g1", posted: "unknown", id: "ABCDEF0123456780" })];
const RUN = (id: string, at: string) => `+++\nid = "${id}"\nroutine = "weekly-check"\nat = "${at}"\noutcome = "done"\nby = "bot"\nchecked = ["backups"]\ntitle = "Weekly check: done ${at.slice(0, 10)}"\n+++\n# Weekly check: done ${at.slice(0, 10)}\n\nAll fine.\n`;

function write(b: Bot, rel: string, lines: string[] | string): void {
  const p = join(b.root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, Array.isArray(lines) ? lines.map((l) => `${l}\n`).join("") : lines);
}

function oldBot(opts: { cycle?: string[]; remote?: boolean } = {}): Bot {
  const b = makeBot({
    settings: { ...BASE_SETTINGS, commit_paths: LISTED, repo_sync: "never-pull", routines: { runs_dir: "records/routine-runs" }, streams: { slack: { lookback_minutes: 30 } } },
    points: ["heartbeat.d"],
  });
  bots.push(b);
  const cycle = opts.cycle ?? CYCLE_COMMITTED;
  write(b, "logs/cycle.jsonl", cycle.slice(0, 3));
  write(b, "logs/intake/seen", SEEN.slice(0, 2));
  write(b, ".gitignore", "logs/probe.log.tmp\n!logs/cycle.jsonl\nnode_modules/\n");
  git(b.root, "add", "-A");
  git(b.root, "commit", "-q", "-m", "chore(cycle): first");
  write(b, "logs/cycle.jsonl", cycle);
  write(b, "logs/intake/seen", SEEN);
  write(b, "logs/intake/watermark", "2026-03-01T09:00:00Z\n");
  write(b, "logs/outages.jsonl", OUTAGES);
  write(b, "logs/actions/labels.jsonl", LABELS);
  write(b, "logs/actions/sent.jsonl", SENT);
  write(b, "logs/actions/rows.jsonl", ROWS);
  write(b, "state/probe-baseline.json", JSON.stringify({ count: 12, seen_at: "2026-03-01T09:00:00Z" }, null, 2));
  write(b, "logs/slack-posts.jsonl", SLACK);
  write(b, "logs/whatsapp-posts.jsonl", WA);
  write(b, "records/routine-runs/2026/02/weekly-check-2026-02-22-0900.md", RUN("weekly-check-2026-02-22-0900", "2026-02-22T09:00:00Z"));
  write(b, "records/routine-runs/2026/03/weekly-check-2026-03-01-0900.md", RUN("weekly-check-2026-03-01-0900", "2026-03-01T09:00:00Z"));
  write(b, "logs/probe.log", ["probe ok", "probe ok", "probe slow"]);
  write(b, "data/peers.json", JSON.stringify({ peers: ["other-bot"] }));
  makeExecutable(join(b.root, "opsbot.d/heartbeat.d/30-peers"), "#!/usr/bin/env bash\n# reads data/peers.json for the peers' names\nexit 0\n");
  git(b.root, "add", "-A");
  git(b.root, "commit", "-q", "-m", "chore(cycle): finished, 1 records");
  // the last cycle's lines, never committed
  write(b, "logs/cycle.jsonl", [...cycle, ...(opts.cycle ? [] : CYCLE_UNCOMMITTED)]);
  write(b, "logs/probe.log", ["probe ok", "probe ok", "probe slow", "probe ok"]);
  if (opts.remote) {
    const remote = join(b.home, "remote.git");
    git(b.home, "init", "-q", "--bare", remote);
    git(b.root, "remote", "add", "origin", remote);
    git(b.root, "push", "-q", "origin", "main");
  }
  return b;
}

const ASSIGN = ["--assign", "logs/probe.log=ignore", "--assign", "data/peers.json=keep"];
const tryGit = (b: Bot, ...args: string[]) => {
  const r = spawnSync("git", ["-C", b.root, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const nonEmpty = (rel: string, b: Bot) => readFileSync(join(b.root, rel), "utf8").split("\n").filter((l) => l.trim()).length;

/** What the working tree and the program branch are, to show nothing changed. */
function snapshot(b: Bot): string {
  const files = ["opsbot.json", ".gitignore", "logs/cycle.jsonl", "logs/intake/seen", "logs/probe.log", "logs/actions/rows.jsonl"].map((f) => readFileSync(join(b.root, f), "utf8"));
  return JSON.stringify([git(b.root, "rev-parse", "HEAD"), git(b.root, "status", "--porcelain"), git(b.root, "branch", "--list"), files]);
}

function records(b: Bot, sheet: Sheet): Rec[] {
  forgetLogBranch();
  return sheetRecords(b.root, B, sheet);
}

describe("log migrate", () => {
  test("a tracked log no setting names, and a file a hook names, stop it until assigned; the dry run lists them and writes nothing", () => {
    const b = oldBot();
    const before = snapshot(b);
    const dry = cli(b, ["log", "migrate", "--dry-run"], { now: T });
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("dry run · stopped · nothing written · 2 files to assign");
    expect(dry.out).toContain("logs/probe.log");
    expect(dry.out).toContain("tracked under logs/, named by no setting");
    expect(dry.out).toContain("data/peers.json");
    expect(dry.out).toContain("named by the hook opsbot.d/heartbeat.d/30-peers");
    expect(dry.out).toContain("--assign logs/probe.log=ignore");
    const real = cli(b, ["log", "migrate"], { now: T });
    expect(real.code).toBe(1);
    expect(real.out).toContain("stopped · nothing written");
    expect(tryGit(b, "rev-parse", "--verify", "-q", B)).toBeNull();
    expect(tryGit(b, "rev-parse", "--verify", "-q", PREP)).toBeNull();
    expect(snapshot(b)).toBe(before);
    // an assignment must name a file the migration found
    expect(cli(b, ["log", "migrate", "--dry-run", ...ASSIGN, "--assign", "README.md=ignore"], { now: T }).code).toBe(2);
    // keep is only for a file a hook names outside logs/
    expect(cli(b, ["log", "migrate", "--dry-run", "--assign", "logs/probe.log=keep", "--assign", "data/peers.json=keep"], { now: T }).code).toBe(2);
  });

  test("the dry run's counts match the files' lines; the real run puts every line on the branch or in unparsed, and changes nothing on the current branch", () => {
    const b = oldBot();
    const before = snapshot(b);
    const head = git(b.root, "rev-parse", "HEAD").trim();
    const dry = cli(b, ["log", "migrate", "--dry-run", ...ASSIGN], { now: T });
    expect(dry.code).toBe(0);
    const fileLines: Record<string, number> = {
      "logs/cycle.jsonl": CYCLE_COMMITTED.length + CYCLE_UNCOMMITTED.length,
      "logs/outages.jsonl": OUTAGES.length,
      "logs/intake/seen": SEEN.length,
      "logs/intake/watermark": 1,
      "logs/actions/labels.jsonl": LABELS.length,
      "logs/actions/sent.jsonl": SENT.length,
      "logs/actions/rows.jsonl": ROWS.length,
      "state/probe-baseline.json": 1,
      "logs/slack-posts.jsonl": SLACK.length,
      "logs/whatsapp-posts.jsonl": WA.length,
    };
    for (const [f, n] of Object.entries(fileLines)) if (!f.endsWith(".json")) expect(nonEmpty(f, b)).toBe(n);
    // each file's row: its lines, and where they go, summing to its lines
    for (const [f, n] of Object.entries(fileLines)) {
      const row = dry.out.split("\n").find((l) => l.includes(`${f},`));
      expect(row).toBeDefined();
      expect(row).toContain(`${f},${n},`);
      const to = row!.slice(row!.indexOf(`${f},${n},`) + `${f},${n},`.length).replace(/^"|"$/g, "");
      expect(to.split(", ").reduce((s, part) => s + Number(part.split(" ").pop()), 0)).toBe(n);
    }
    expect(dry.out).toContain("dry run · 35 lines from 12 files would go to opsbot/log");
    expect(snapshot(b)).toBe(before);
    expect(tryGit(b, "rev-parse", "--verify", "-q", B)).toBeNull();

    const r = cli(b, ["log", "migrate", ...ASSIGN], { now: T });
    expect(r.code).toBe(0);
    expect(r.out).toContain("done · 35 lines from 12 files on opsbot/log");
    expect(r.out).toContain(`prepared ${PREP}`);
    expect(r.out).toContain("nothing changed on main");
    // nothing changed on the current branch or in the working tree
    expect(snapshot(b).replace(/\* main\\n {2}opsbot\/log\\n {2}opsbot\/log-migrate/, "* main")).toBe(before);
    expect(git(b.root, "rev-parse", "HEAD").trim()).toBe(head);

    // every line is a record, or a record of ledger unparsed
    const cycles = records(b, "cycles");
    const outs = records(b, "outages");
    const ledgers = records(b, "ledgers");
    const unparsed = ledgers.filter((x) => x.ledger === "unparsed");
    const posts = records(b, "posts");
    expect(cycles).toHaveLength(CYCLE_COMMITTED.length + CYCLE_UNCOMMITTED.length - 3); // the outage, the collision, the torn line
    expect(outs.map((o) => `${o.kind}-${o.edge}`).sort()).toEqual(["plan-limit-end", "plan-limit-start", "stopped-start"]);
    expect(records(b, "seen").map((x) => x.key).sort()).toEqual([...SEEN].sort());
    expect(ledgers.filter((x) => x.ledger === "labels")).toHaveLength(3);
    expect(ledgers.filter((x) => x.ledger === "sent")).toHaveLength(2);
    expect(ledgers.filter((x) => x.ledger === "rows").map((x) => x.row)).toEqual([4]);
    expect(posts.filter((x) => x.channel === "slack")).toHaveLength(2);
    expect(posts.filter((x) => x.channel === "whatsapp")).toHaveLength(2);
    expect(records(b, "state")).toEqual([{ name: "probe-baseline", at: expect.any(String), value: { count: 12, seen_at: "2026-03-01T09:00:00Z" } }]);
    expect(records(b, "routines").map((x) => x.id).sort()).toEqual(["weekly-check-2026-02-22-0900", "weekly-check-2026-03-01-0900"]);
    // five lines could not be placed: kept whole, with where they came from and why
    expect(unparsed.map((u) => `${u.file}:${u.line}`).sort()).toEqual(["logs/actions/rows.jsonl:2", "logs/actions/rows.jsonl:3", "logs/actions/rows.jsonl:4", "logs/cycle.jsonl:10", "logs/cycle.jsonl:9"]);
    expect(unparsed.find((u) => u.line === 2)!.text).toBe("row 5 written by hand");
    expect(unparsed.find((u) => u.file === "logs/cycle.jsonl" && u.line === 9)!.reason).toContain("the same cycles path");
    // the sum: every line of every file
    const placed = cycles.length + outs.length + records(b, "seen").length + 1 + ledgers.length + posts.length + records(b, "state").length + records(b, "routines").length;
    expect(placed).toBe(Object.values(fileLines).reduce((a, n) => a + n, 0) + 2);
    // a line keeps its own time; one without takes the time its line was committed
    expect(ledgers.find((x) => x.ledger === "sent" && x.to === "b@example.invalid")!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // the readers see the migrated log as it was (read from the branch: HEAD is not migrated yet)
    expect(branchWatermark(b.root, B)).toBe("2026-03-01T09:00:00Z");
    expect([...branchSeen(b.root, B)].sort()).toEqual([...SEEN].sort());
    expect(branchLastCycleAt(b.root, B)).toBe("2026-03-02T09:10:00Z");

    // the prepared commit: HEAD plus one commit
    expect(git(b.root, "rev-parse", `${PREP}^`).trim()).toBe(head);
    const removed = git(b.root, "diff", "--name-status", "HEAD", PREP).trim().split("\n").sort();
    expect(removed).toContain("D\tlogs/cycle.jsonl");
    expect(removed).toContain("D\tlogs/probe.log");
    expect(removed).toContain("D\tstate/probe-baseline.json");
    expect(removed).toContain("D\trecords/routine-runs/2026/03/weekly-check-2026-03-01-0900.md");
    expect(removed).toContain("M\topsbot.json");
    expect(removed).toContain("M\t.gitignore");
    expect(removed.join("\n")).not.toContain("data/peers.json");
    const settings = JSON.parse(git(b.root, "show", `${PREP}:opsbot.json`));
    expect(settings.commit_paths).toBeUndefined();
    expect(settings.routines).toBeUndefined();
    expect(settings.repo_sync).toBe("never");
    expect(settings.log).toEqual({ branch: B, ledgers: { labels: [], rows: [], sent: [] }, state: { "probe-baseline": [] } });
    const ignore = git(b.root, "show", `${PREP}:.gitignore`);
    expect(ignore).not.toContain("!logs/cycle.jsonl");
    expect(ignore).toContain("/logs/probe.log");
    expect(ignore).toContain("node_modules/");
    // what to do next, step by step
    expect(r.out).toContain(`git push origin ${B} ${PREP}`);
    expect(r.out).toContain(`gh pr create --base main --head ${PREP}`);
    expect(r.out).toContain("git pull --ff-only");
    expect(existsSync(join(b.root, ".git", "opsbot-migrate", "logs", "probe.log"))).toBe(true);

    // run again: nothing is written twice
    const tip = git(b.root, "rev-parse", B).trim();
    expect(cli(b, ["log", "migrate", ...ASSIGN], { now: T }).code).toBe(0);
    expect(git(b.root, "rev-parse", B).trim()).toBe(tip);
  });

  test("until the removal commit is in the checkout nothing writes the log, to either place; after it, a full cycle leaves the program branch clean", () => {
    const b = oldBot({ remote: true });
    const before = snapshot(b);
    // before the migration: refused, naming the command
    for (const args of [["cycle", "begin"], ["check"], ["outage", "record", "stopped"], ["watchdog"]]) {
      const r = cli(b, args, { now: T });
      expect(r.code).toBe(2);
      expect(r.out).toContain("log migrate");
    }
    expect(cli(b, ["log", "append", "labels"], { now: T, input: '{"thread":"t9"}' }).code).toBe(2);
    expect(cli(b, ["settings", "validate"]).out).toContain("log migrate");
    expect(snapshot(b)).toBe(before);
    expect(tryGit(b, "rev-parse", "--verify", "-q", B)).toBeNull();
    expect(existsSync(join(b.root, ".git", "opsbot-cycle.lock"))).toBe(false);

    // prepared, not merged: still refused, now naming the branch to merge
    expect(cli(b, ["log", "migrate", ...ASSIGN], { now: T }).code).toBe(0);
    const tip = git(b.root, "rev-parse", B).trim();
    const refused = cli(b, ["cycle", "begin"], { now: T });
    expect(refused.code).toBe(2);
    expect(refused.out).toContain(PREP);
    expect(git(b.root, "rev-parse", B).trim()).toBe(tip);
    expect(snapshot(b).replace(/\* main\\n {2}opsbot\/log\\n {2}opsbot\/log-migrate/, "* main")).toBe(before);

    // merged and pulled, as the command says
    const discard = refused.out; // the refusal named the branch; the migrate output names the files
    expect(discard).toContain("log migrate");
    git(b.root, "checkout", "-q", "HEAD", "--", "logs", "state", "records");
    git(b.root, "merge", "-q", "--ff-only", PREP);
    expect(git(b.root, "status", "--porcelain").trim()).toBe("");
    // a full cycle: an item, a ledger record, a baseline and a post
    writeStream(b, [{ key: "chat:c:1", at: T, conv: "c", kind: "group", from: "p", text: "already seen before the move" }, { key: "chat:c:7", at: T, conv: "c", kind: "group", from: "p", text: "new" }]);
    const begin = cli(b, ["cycle", "begin"], { now: T });
    expect(begin.code).toBe(10);
    expect(begin.out).toContain("chat:c:7");
    expect(begin.out).not.toContain("already seen before the move");
    expect(cli(b, ["log", "append", "labels"], { now: T, input: JSON.stringify({ thread: "t9", label: "done" }) }).out).toContain("staged");
    expect(cli(b, ["log", "state", "set", "probe-baseline"], { now: T, input: JSON.stringify({ count: 13 }) }).out).toContain("staged");
    expect(cli(b, ["log", "append", "posts/slack"], { now: T, input: JSON.stringify({ conv: "C1", posted: true, ts: "2.2" }) }).out).toContain("staged");
    const end = cli(b, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:05:00Z" });
    expect(end.code).toBe(0);
    expect(end.out).not.toContain("not pushed");
    expect(git(b.root, "status", "--porcelain").trim()).toBe("");
    expect(git(b.root, "log", "-1", "--format=%s").trim()).toContain("the loop's log moves to opsbot/log");
    expect(records(b, "ledgers").filter((x) => x.ledger === "labels")).toHaveLength(4);
    expect(records(b, "state")[0]!.value).toEqual({ count: 13 });
    expect(logOf(b).at(-1)!.outcome).toBe("finished");
    // the log went up with the cycle
    expect(git(b.root, "rev-parse", B).trim()).toBe(git(b.home, "--git-dir", join(b.home, "remote.git"), "rev-parse", B).trim());
  });

  test("a bot several releases behind is refused with the release to update to first", () => {
    // its cycle lines carry no `check`: a release before the shapes this one reads
    const old = CYCLE_COMMITTED.map((l) => l.replace(/,"check":"full","since":"[^"]+"/, ""));
    const b = oldBot({ cycle: old });
    const before = snapshot(b);
    for (const args of [["log", "migrate", "--dry-run", ...ASSIGN], ["log", "migrate", ...ASSIGN]]) {
      const r = cli(b, args, { now: T });
      expect(r.code).toBe(2);
      expect(r.out).toContain("v0.16.0");
      expect(r.out).toContain("npx skills add JarvusInnovations/opsbots#v0.16.0");
    }
    expect(snapshot(b)).toBe(before);
    expect(tryGit(b, "rev-parse", "--verify", "-q", B)).toBeNull();
  });

  test("settings validate on a config with the old file list fails and names the command; a new bot needs no migration", () => {
    const b = makeBot({ settings: { ...BASE_SETTINGS, commit_paths: ["logs/x.jsonl"] } });
    bots.push(b);
    const r = cli(b, ["settings", "validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("log migrate");
    const fresh = makeBot();
    bots.push(fresh);
    expect(cli(fresh, ["log", "migrate", "--dry-run"]).out).toContain("nothing to migrate");
    expect(cli(fresh, ["cycle", "begin"], { now: T }).code).toBe(0);
    expect(tryGit(fresh, "rev-parse", "--verify", "-q", B)).not.toBeNull();
  });
});

describe("repo_sync: cycle begin follows the remote", () => {
  /** A bot on the log branch with a remote, and a person's clone of it. */
  function synced(settings: Record<string, unknown> = {}): { b: Bot; person: string; remote: string } {
    const b = makeBot({ settings: { ...BASE_SETTINGS, ...settings } });
    bots.push(b);
    const remote = join(b.home, "remote.git");
    git(b.home, "init", "-q", "--bare", remote);
    git(b.root, "remote", "add", "origin", remote);
    git(b.root, "push", "-q", "-u", "origin", "main");
    const person = join(b.home, "person");
    git(b.home, "clone", "-q", "-b", "main", remote, person);
    for (const [k, v] of [["user.name", "P"], ["user.email", "p@example.invalid"], ["commit.gpgsign", "false"]]) git(person, "config", k!, v!);
    return { b, person, remote };
  }
  const push = (person: string, file: string, text: string) => {
    writeFileSync(join(person, file), text);
    git(person, "add", file);
    git(person, "commit", "-q", "-m", `a person's ${file}`);
    git(person, "push", "-q", "origin", "main");
    return git(person, "rev-parse", "HEAD").trim();
  };

  test("a clean checkout that is behind is fast-forwarded, and the cycle runs on the new program", () => {
    const { b, person } = synced();
    const theirs = push(person, "notes.md", "a person's note\n");
    const r = cli(b, ["cycle", "begin"], { now: T });
    expect(r.code).toBe(0);
    expect(git(b.root, "rev-parse", "HEAD").trim()).toBe(theirs);
    expect(readFileSync(join(b.root, "notes.md"), "utf8")).toBe("a person's note\n");
    expect(r.out).not.toContain("not pulled");
  });

  test("a diverged checkout is one item naming both commits, said once per remote head, and the cycle goes on", () => {
    const { b, person } = synced();
    write(b, "local.md", "the bot's own commit, not pushed\n");
    git(b.root, "add", "local.md");
    git(b.root, "commit", "-q", "-m", "local");
    const mine = git(b.root, "rev-parse", "HEAD").trim();
    const theirs = push(person, "notes.md", "x\n");
    const r = cli(b, ["cycle", "begin"], { now: T });
    expect(r.code).toBe(10);
    expect(r.out).toContain(`repo-sync:${theirs}`);
    expect(r.out).toContain(`${mine.slice(0, 12)} here and ${theirs.slice(0, 12)} on origin`);
    expect(r.out).toContain("diverged");
    // the streams were read as usual: theirs and the core's repo-sync input
    expect(r.out).toContain("1 new · 3 inputs");
    expect(git(b.root, "rev-parse", "HEAD").trim()).toBe(mine);
    expect(cli(b, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:01:00Z" }).code).toBe(0);
    // the same remote head: not said again
    expect(cli(b, ["cycle", "begin"], { now: "2026-03-02T15:20:00Z" }).code).toBe(0);
    // the remote moved: said again, once
    const next = push(person, "more.md", "y\n");
    const again = cli(b, ["cycle", "begin"], { now: "2026-03-02T15:40:00Z" });
    expect(again.code).toBe(10);
    expect(again.out).toContain(`repo-sync:${next}`);
  });

  test("a dirty checkout that is behind is reported once and left as it is; repo_sync: never leaves the checkout alone", () => {
    const { b, person } = synced();
    writeFileSync(join(b.root, "rules.md"), "an edit not committed\n");
    const head = git(b.root, "rev-parse", "HEAD").trim();
    const theirs = push(person, "notes.md", "x\n");
    const r = cli(b, ["cycle", "begin"], { now: T });
    expect(r.code).toBe(10);
    expect(r.out).toContain(`repo-sync:${theirs}`);
    expect(r.out).toContain("uncommitted changes (rules.md)");
    expect(git(b.root, "rev-parse", "HEAD").trim()).toBe(head);
    expect(readFileSync(join(b.root, "rules.md"), "utf8")).toBe("an edit not committed\n");

    const n = synced({ repo_sync: "never" });
    const before = git(n.b.root, "rev-parse", "HEAD").trim();
    push(n.person, "notes.md", "x\n");
    expect(cli(n.b, ["cycle", "begin"], { now: T }).code).toBe(0);
    expect(git(n.b.root, "rev-parse", "HEAD").trim()).toBe(before);
  });
});
