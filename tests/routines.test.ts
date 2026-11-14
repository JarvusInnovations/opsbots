import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SETTINGS, cli, git, makeBot, readLines, setSettings, writeStream, type Bot } from "./helpers";
import { parseRecord, serializeRecord, FrontmatterError } from "../src/opsbot-core/frontmatter";
import { computeState, parseDefinition, type Definition, type Run } from "../src/opsbot-core/routine-store";
import { dueTimes } from "../src/opsbot-core/sleep";
import { validateSettings, withDefaults } from "../src/opsbot-core/settings";

let bot: Bot;
afterEach(() => bot?.cleanup());

// Spawning several CLI processes per test: give each test room on a slow runner.
const SLOW = 60_000;
const DAY = 86_400_000;
const H = 3_600_000;
const T = (s: string) => Date.parse(s);

function def(over: Partial<Definition>): Definition {
  return {
    id: "weekly-backup-check",
    title: "Check the backups",
    file: "routines/weekly-backup-check.md",
    builtin: false,
    intervalDays: 7,
    schedule: "weekly",
    at: null,
    days: null,
    since: null,
    active: true,
    owner: null,
    hands_to: null,
    body: "",
    ...over,
  };
}

function run(at: string, routine = "weekly-backup-check", outcome = "done"): Run {
  return { id: `${routine}-${at}`, routine, at, atMs: T(at), outcome, by: null, checked: [], handed_to: null, notes: "", file: "x" };
}

describe("the due computation", () => {
  test("every cadence: due once its interval has passed since the newest run, keyed by that run", () => {
    const cases: Array<[string, number]> = [["daily", 1], ["weekly", 7], ["monthly", 30], ["quarterly", 91], ["yearly", 365], ["every 10d", 10]];
    for (const [cadence, days] of cases) {
      const d = def({ intervalDays: parseDefinition("routines/x-y.md", `+++\nid = "x-y"\ntitle = "t"\ncadence = "${cadence}"\n+++\n`).def!.intervalDays, schedule: cadence });
      expect(d.intervalDays).toBe(days);
      const last = "2026-01-01T10:00:00Z";
      const runs = [run("2025-12-01T10:00:00Z"), run(last)];
      const before = computeState(d, runs, T(last) + days * DAY - 60_000, "UTC");
      expect(before.due).toBe(false);
      expect(before.next).toBe(T(last) + days * DAY);
      expect(before.key).toBeNull();
      const at = computeState(d, runs, T(last) + days * DAY, "UTC");
      expect(at.due).toBe(true);
      expect(at.key).toBe(`routine:weekly-backup-check:after:${last}`);
      expect(at.last?.at).toBe(last);
    }
    // `every = "Nd"` is the same interval
    expect(parseDefinition("routines/x-y.md", `+++\nid = "x-y"\ntitle = "t"\nevery = "10d"\n+++\n`).def!.intervalDays).toBe(10);
  });

  test("since: counted from local midnight in the bot's zone; with neither since nor a run, due at once; inactive never", () => {
    const d = def({ since: "2026-03-02" });
    // local midnight in New York is 05:00Z in winter: due a week later
    expect(computeState(d, [], T("2026-03-09T04:59:00Z"), "America/New_York").due).toBe(false);
    const due = computeState(d, [], T("2026-03-09T05:00:00Z"), "America/New_York");
    expect(due.due).toBe(true);
    expect(due.key).toBe("routine:weekly-backup-check:after:since:2026-03-02");
    const never = computeState(def({}), [], T("2026-03-09T05:00:00Z"), "UTC");
    expect(never.due).toBe(true);
    expect(never.dueAt).toBeNull();
    expect(never.key).toBe("routine:weekly-backup-check:after:never");
    const off = computeState(def({ active: false }), [], T("2027-01-01T00:00:00Z"), "UTC");
    expect(off.due).toBe(false);
    expect(off.next).toBeNull();
    // another routine's runs do not count
    expect(computeState(def({}), [run("2026-03-08T00:00:00Z", "other-routine")], T("2026-03-09T00:00:00Z"), "UTC").due).toBe(true);
  });

  test("a preferred-time slot in the bot's zone, across a daylight-saving change in each direction", () => {
    const tz = "America/New_York";
    const d = def({ id: "morning-summary", intervalDays: null, at: "08:30", days: [1, 2, 3, 4, 5], since: "2026-03-02", schedule: "08:30 Mon/Tue/Wed/Thu/Fri" });
    // Monday March 2 (EST, UTC-5): the slot is 13:30Z
    const early = computeState(d, [], T("2026-03-02T13:20:00Z"), tz);
    expect(early.due).toBe(false);
    expect(early.next).toBe(T("2026-03-02T13:30:00Z"));
    const late = computeState(d, [], T("2026-03-02T13:40:00Z"), tz);
    expect(late.due).toBe(true);
    expect(late.key).toBe("routine:morning-summary:slot:2026-03-02T13:30:00Z");
    // a run after the slot satisfies it until the next weekday slot
    const runs = [run("2026-03-02T13:45:00Z", "morning-summary")];
    const after = computeState(d, runs, T("2026-03-02T20:00:00Z"), tz);
    expect(after.due).toBe(false);
    expect(after.next).toBe(T("2026-03-03T13:30:00Z"));
    // a run before the slot does not
    expect(computeState(d, [run("2026-03-03T13:00:00Z", "morning-summary")], T("2026-03-03T14:00:00Z"), tz).due).toBe(true);
    // Saturday has no slot; Friday's run holds; Monday March 9 is after the change to EDT (UTC-4): 12:30Z
    const fri = [run("2026-03-06T13:35:00Z", "morning-summary")];
    const sat = computeState(d, fri, T("2026-03-07T15:00:00Z"), tz);
    expect(sat.due).toBe(false);
    expect(sat.next).toBe(T("2026-03-09T12:30:00Z"));
    expect(computeState(d, fri, T("2026-03-09T12:40:00Z"), tz).key).toBe("routine:morning-summary:slot:2026-03-09T12:30:00Z");
    // the autumn change: Friday October 30 is EDT (12:30Z), Monday November 2 is EST (13:30Z)
    const oct = [run("2026-10-30T12:35:00Z", "morning-summary")];
    expect(computeState(d, oct, T("2026-11-01T12:00:00Z"), tz).next).toBe(T("2026-11-02T13:30:00Z"));
    expect(computeState(d, oct, T("2026-11-02T13:00:00Z"), tz).due).toBe(false);
    expect(computeState(d, oct, T("2026-11-02T13:31:00Z"), tz).due).toBe(true);
    // a slot before `since` is not due
    expect(computeState(def({ ...d, since: "2026-03-03" }), [], T("2026-03-02T20:00:00Z"), tz).due).toBe(false);
    expect(computeState(def({ ...d, since: "2026-03-03" }), [], T("2026-03-02T20:00:00Z"), tz).next).toBe(T("2026-03-03T13:30:00Z"));
  });
});

describe("the file formats", () => {
  test("frontmatter round-trips deterministically: sorted keys, quoted strings, one-line arrays", () => {
    const text = serializeRecord({ title: 'A "quoted" title', id: "a-b", days: [1, 2, 3], active: true, checked: [] }, "# A\n\nbody line\n");
    expect(text).toBe('+++\nactive = true\nchecked = []\ndays = [1, 2, 3]\nid = "a-b"\ntitle = "A \\"quoted\\" title"\n+++\n\n# A\n\nbody line\n');
    const back = parseRecord(text);
    expect(back.data).toEqual({ title: 'A "quoted" title', id: "a-b", days: [1, 2, 3], active: true, checked: [] });
    expect(back.body).toBe("# A\n\nbody line");
    expect(serializeRecord(back.data, back.body)).toBe(text);
    // the shapes a gitsheets record may hold: literal strings, bare dates, multi-line arrays, comments
    const g = parseRecord("+++\n# a comment\nat = 2026-11-13T13:39:07Z\nlist = [\n  'one',\n  \"two\",\n]\nn = 3\n+++\nbody\n");
    expect(g.data).toEqual({ at: "2026-11-13T13:39:07Z", list: ["one", "two"], n: 3 });
    for (const bad of ["---\nid: x\n---\n", "no frontmatter", "+++\nid = \"x\"\n", "+++\n[table]\n+++\n", "+++\nid = x\n+++\n", "+++\na = 1\na = 2\n+++\n"]) {
      expect(() => parseRecord(bad)).toThrow(FrontmatterError);
    }
  });

  test("validation names every problem", () => {
    const probs = (name: string, fm: string) => parseDefinition(`routines/${name}.md`, `+++\n${fm}\n+++\n\nbody\n`).problems.join("; ");
    expect(probs("ok-one", 'id = "ok-one"\ntitle = "t"\ncadence = "weekly"')).toBe("");
    expect(probs("ok-two", 'id = "ok-two"\ntitle = "t"\nat = "08:30"\ndays = [1, 2, 3, 4, 5, 6, 7]\nsince = "2026-01-01"\nactive = false')).toBe("");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\ncadence = "fortnightly"')).toContain("cadence");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\ncadence = "weekly"\nevery = "3d"')).toContain("not both");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\ncadence = "weekly"\nat = "08:00"\ndays = [1]')).toContain("an interval (cadence or every) or a slot");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"')).toContain("no schedule");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\nat = "08:00"')).toContain("a slot needs days");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\nat = "25:00"\ndays = [1]')).toContain("at ");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\nat = "08:00"\ndays = [0, 8]')).toContain("days must be");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\nevery = "ten"')).toContain("every");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\ncadence = "weekly"\nsince = "soon"')).toContain("since");
    expect(probs("x-y", 'id = "x-z"\ntitle = "t"\ncadence = "weekly"')).toContain("not the file's name");
    expect(probs("x-y", 'id = "x-y"\ntitle = "t"\ncadence = "weekly"\nstatus = "active"')).toContain("unknown key status");
    expect(probs("x-y", 'title = "t"\ncadence = "weekly"')).toContain("missing required key id");
    expect(parseDefinition("routines/x-y.md", "no frontmatter\n").problems[0]).toContain("routines/x-y.md: no frontmatter");
  });

  test("settings: routines.{dir, runs_dir} with defaults, refused outside the repo", () => {
    const base = { name: "x", mark: "m", loop: { prompt: "p" }, runtime: { agent: "x" } };
    expect(withDefaults(base).routines).toEqual({ dir: "routines", runs_dir: "records/routine-runs" });
    expect(withDefaults({ ...base, routines: { dir: "./ops/routines/", runs_dir: "log/runs" } }).routines).toEqual({ dir: "ops/routines", runs_dir: "log/runs" });
    expect(validateSettings({ ...base, routines: { dir: "../x" } }).join()).toContain("routines.dir");
    expect(validateSettings({ ...base, routines: { runs_dir: ".git/runs" } }).join()).toContain("routines.runs_dir");
    expect(validateSettings({ ...base, routines: { other: 1 } }).join()).toContain("unknown key routines.other");
  });
});

// ------------------------------------------------------------ against a bot

function routineFile(b: Bot, id: string, fm: string, body = "Do the thing.\n", commit = true): void {
  mkdirSync(join(b.root, "routines"), { recursive: true });
  writeFileSync(join(b.root, "routines", `${id}.md`), `+++\nid = "${id}"\ntitle = "${id} title"\n${fm}\n+++\n\n# ${id} title\n\n${body}`);
  if (commit) {
    git(b.root, "add", "routines");
    git(b.root, "commit", "-q", "-m", `routine ${id}`);
  }
}

const NO_MEMORY = { ...BASE_SETTINGS, memory: false };

describe("routines done, history and validate", () => {
  test("done writes one run record, clears due, and history shows the gaps", () => {
    bot = makeBot({ settings: NO_MEMORY });
    routineFile(bot, "weekly-backup-check", 'cadence = "weekly"\nsince = "2026-01-05"', "Check every nightly job.\n\n- each night accounted for\n");
    const now = "2026-03-02T15:00:00Z";
    expect(cli(bot, ["routines"], { now }).out).toContain("weekly-backup-check,weekly-backup-check title,weekly");
    expect(cli(bot, ["routines", "view", "weekly-backup-check"], { now }).out).toContain("Check every nightly job.");
    // two runs backdated, with a missed stretch between
    expect(cli(bot, ["routines", "done", "weekly-backup-check", "--notes", "all seven nights fine", "--at", "2026-01-12T09:00:00Z"], { now }).code).toBe(0);
    const r = cli(bot, ["routines", "done", "weekly-backup-check", "--notes", "two nights failed", "--outcome", "partial", "--checked", "jobs listed", "--checked", "newest backup, opened", "--handed-to", "the operator", "--at", "2026-02-16T09:00:00Z"], { now });
    expect(r.code).toBe(0);
    expect(r.out).toContain("records/routine-runs/2026/02/weekly-backup-check-2026-02-16-0900.md");
    const file = join(bot.root, "records", "routine-runs", "2026", "02", "weekly-backup-check-2026-02-16-0900.md");
    expect(readFileSync(file, "utf8")).toBe(
      '+++\nat = "2026-02-16T09:00:00Z"\nby = "testbot"\nchecked = ["jobs listed", "newest backup, opened"]\nhanded_to = "the operator"\nid = "weekly-backup-check-2026-02-16-0900"\noutcome = "partial"\nroutine = "weekly-backup-check"\ntitle = "weekly-backup-check title: partial 2026-02-16"\n+++\n\n# weekly-backup-check title: partial 2026-02-16\n\ntwo nights failed\n',
    );
    // still due (the newest run is over a week old); a run now clears it
    expect(cli(bot, ["routines", "due"], { now }).out).toContain("weekly-backup-check");
    const d = cli(bot, ["routines", "done", "weekly-backup-check", "--notes", "fine"], { now });
    expect(d.out).toContain("due again Mon Mar 9");
    expect(cli(bot, ["routines", "due"], { now }).out).toContain("nothing due · 1 routine · next weekly-backup-check");
    // a second run in the same minute never overwrites
    expect(cli(bot, ["routines", "done", "weekly-backup-check", "--notes", "again"], { now }).out).toContain("weekly-backup-check-2026-03-02-1500-2");
    const h = cli(bot, ["routines", "history", "weekly-backup-check"], { now });
    expect(h.code).toBe(0);
    expect(h.out).toContain("4 runs");
    expect(h.out).toContain('"2026-01-12T09:00:00Z",done,7,"","",all seven nights fine');
    expect(h.out).toContain('"2026-02-16T09:00:00Z",partial,35,missed stretch,the operator,two nights failed');
    expect(h.out).toContain('"2026-03-02T15:00:00Z",done,14,missed stretch,"",fine');
    expect(h.out).toContain("not due");
  }, SLOW);

  test("done refuses what it cannot record; validate and settings validate name broken definitions", () => {
    bot = makeBot({ settings: NO_MEMORY });
    routineFile(bot, "paused-one", 'cadence = "daily"\nactive = false');
    const now = "2026-03-02T15:00:00Z";
    expect(cli(bot, ["routines", "done", "paused-one"], { now }).code).toBe(2);
    expect(cli(bot, ["routines", "done", "paused-one", "--notes", "x", "--outcome", "maybe"], { now }).code).toBe(2);
    expect(cli(bot, ["routines", "done", "paused-one", "--notes", "x"], { now }).out).toContain("inactive");
    expect(cli(bot, ["routines", "done", "nope", "--notes", "x"], { now }).out).toContain("no routine nope");
    routineFile(bot, "later-one", 'cadence = "daily"');
    expect(cli(bot, ["routines", "done", "later-one", "--notes", "x", "--at", "2026-03-03T15:00:00Z"], { now }).out).toContain("later than the clock");
    expect(existsSync(join(bot.root, "records"))).toBe(false);

    expect(cli(bot, ["routines", "validate"], { now }).code).toBe(0);
    // broken in the working tree: validate names it; settings validate too; HEAD is still fine
    writeFileSync(join(bot.root, "routines", "broken-one.md"), "+++\nid = \"broken-one\"\ntitle = \"b\"\nat = \"08:00\"\n+++\n");
    writeFileSync(join(bot.root, "routines", "README.md"), "Not a routine.\n");
    const v = cli(bot, ["routines", "validate"], { now });
    expect(v.code).toBe(1);
    expect(v.out).toContain("routines/broken-one.md: a slot needs days");
    expect(v.out).not.toContain("README");
    expect(cli(bot, ["settings", "validate"], { now }).out).toContain("broken-one.md");
    expect(cli(bot, ["routines", "validate", "--head"], { now }).code).toBe(0);
    expect(cli(bot, ["settings", "validate", "--head"], { now }).code).toBe(0);
    // committed, it fails the check's routines input by name: degraded, never skipped
    git(bot.root, "add", "routines");
    git(bot.root, "commit", "-q", "-m", "broken");
    const c = cli(bot, ["check"], { now });
    expect(c.code).toBe(20);
    expect(c.out).toContain("routines");
    expect(c.out).toContain("a slot needs days");
  }, SLOW);
});

describe("a due routine surfaces once per occurrence", () => {
  test("one cycle item, a cycle end line, a peek, the pack and the sleep decision's due times", () => {
    bot = makeBot({ settings: NO_MEMORY });
    routineFile(bot, "morning-summary", 'at = "08:30"\ndays = [1, 2, 3, 4, 5]\nsince = "2026-03-02"');
    setSettings(bot, { timezone: "America/New_York" });
    writeStream(bot, []);
    // before the slot: nothing due, and the slot is the next due time
    let now = "2026-03-02T13:00:00Z";
    expect(cli(bot, ["check", "--peek"], { now }).code).toBe(0);
    const s = withDefaults(JSON.parse(readFileSync(join(bot.root, "opsbot.json"), "utf8")));
    expect(dueTimes(bot.root, s, "{}", T(now)).due).toEqual([{ at: "2026-03-02T13:30:00Z", what: "routine morning-summary: morning-summary title" }]);
    // after it: a peek sees it without recording it
    now = "2026-03-02T13:40:00Z";
    const peek = cli(bot, ["check", "--peek"], { now });
    expect(peek.code).toBe(10);
    expect(peek.out).toMatch(/routines,true,1/);
    // the cycle reports it once
    const begin = cli(bot, ["cycle", "begin"], { now });
    expect(begin.code).toBe(10);
    expect(begin.out.match(/routine:morning-summary:slot:2026-03-02T13:30:00Z/g)?.length).toBe(1);
    const end = cli(bot, ["cycle", "end", "--records", "0"], { now });
    expect(end.code).toBe(0);
    expect(end.out).toContain("routines[1]");
    expect(end.out).toContain("morning-summary due since Mon Mar 2, 8:30 AM EST");
    const pack = cli(bot, ["cold-start"], { now }).out;
    expect(pack).toContain("Routines (the kit's; updates with the skill)");
    expect(pack).toContain("routines due: 1");
    // the next cycle does not report it again; it is still listed at the close until a run
    now = "2026-03-02T14:10:00Z";
    expect(cli(bot, ["cycle", "begin"], { now }).code).toBe(0);
    expect(cli(bot, ["check", "--peek"], { now }).code).toBe(0);
    // a run clears it; the run is committed by the next check, and the next slot is the due time
    expect(cli(bot, ["routines", "done", "morning-summary", "--notes", "sent"], { now }).code).toBe(0);
    expect(cli(bot, ["check"], { now }).code).toBe(0);
    expect(git(bot.root, "show", "--name-only", "--format=", "HEAD")).toContain("records/routine-runs/2026/03/morning-summary-2026-03-02-1410.md");
    expect(git(bot.root, "status", "--porcelain")).toBe("");
    expect(dueTimes(bot.root, s, "{}", T(now)).due[0]!.at).toBe("2026-03-03T13:30:00Z");
    // the next slot is a new occurrence: one new item
    now = "2026-03-03T13:35:00Z";
    const next = cli(bot, ["check"], { now });
    expect(next.code).toBe(10);
    expect(next.out).toContain("routine:morning-summary:slot:2026-03-03T13:30:00Z");
  }, SLOW);

  test("an uncommitted definition changes nothing: definitions are read at HEAD", () => {
    bot = makeBot({ settings: NO_MEMORY });
    routineFile(bot, "daily-check", 'cadence = "daily"', "Do it.\n", false);
    const r = cli(bot, ["check", "--peek"], { now: "2026-03-02T15:00:00Z" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("routines");
    expect(cli(bot, ["routines", "due"], { now: "2026-03-02T15:00:00Z" }).out).toContain("nothing due · 0 routines");
  }, SLOW);

  test("a bot without routines reads as before: no routines input, field or pack section", () => {
    bot = makeBot();
    writeStream(bot, [{ key: "chat:c:1", at: "2026-03-02T14:59:00Z", conv: "c", kind: "dm", from: "p", text: "hi" }]);
    const now = "2026-03-02T15:00:00Z";
    const begin = cli(bot, ["cycle", "begin"], { now });
    expect(begin.code).toBe(10);
    expect(begin.out).toContain("new · 1 new · 2 inputs");
    expect(begin.out).not.toContain("routine:");
    expect(begin.out).not.toContain(",routines,");
    const end = cli(bot, ["cycle", "end", "--records", "1"], { now });
    expect(end.out).not.toContain("routines[");
    expect(end.out).not.toContain("memory:");
    const pack = cli(bot, ["cold-start"], { now }).out;
    expect(pack).not.toContain("Routines");
    expect(pack).not.toContain("routines due");
    const log = readLines(join(bot.root, "logs", "cycle.jsonl"));
    expect(Object.keys(log[0]!.inputs as object)).toEqual(["10-file-stream", "20-quiet-stream"]);
    expect(dueTimes(bot.root, withDefaults(BASE_SETTINGS), "{}", T(now))).toEqual({ due: [], problem: null });
  }, SLOW);
});

// ------------------------------------------------------------ the built-in memory review

/** A clock `days` from the real now: memory files carry real file and commit times. */
const after = (days: number) => new Date(Math.ceil((Date.now() + days * DAY) / 1000) * 1000 + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function mem(b: Bot, name: string, body: string): void {
  mkdirSync(join(b.root, "memory"), { recursive: true });
  writeFileSync(join(b.root, "memory", name), body);
}

describe("memory-review, the first built-in routine", () => {
  test("exists while memory is on, is one check item when due, and memory review --done records a run", () => {
    bot = makeBot();
    // no memory files: listed, never due, no item
    expect(cli(bot, ["routines", "due", "--all"], { now: after(30) }).out).toContain("memory-review,every 7d (memory.review_days),ok,never");
    mem(bot, "a.md", "a fact\n");
    let now = after(1);
    expect(cli(bot, ["routines", "due"], { now }).out).toContain("nothing due");
    now = after(9);
    const c = cli(bot, ["check"], { now });
    expect(c.code).toBe(10);
    expect(c.out.match(/routine:memory-review:after:never/g)?.length).toBe(1);
    expect(c.out).toContain("memory review --begin");
    expect(cli(bot, ["check"], { now }).code).toBe(0);
    expect(cli(bot, ["routines", "view", "memory-review"], { now }).out).toContain("built-in (the kit's)");
    expect(cli(bot, ["memory", "review", "--begin"], { now }).code).toBe(0);
    const done = cli(bot, ["memory", "review", "--done", "--note", "kept the one fact"], { now });
    expect(done.code).toBe(0);
    expect(done.out).toContain("a run of the memory-review routine");
    const h = cli(bot, ["routines", "history", "memory-review"], { now });
    expect(h.out).toContain("1 run");
    expect(h.out).toContain("kept the one fact");
    expect(cli(bot, ["memory", "status"], { now }).out).toContain("not due: next review in 7 days");
    expect(cli(bot, ["routines", "due"], { now }).out).toContain("nothing due");
    // the cycle-log line is still written, and the run record rides the next commit
    expect(readLines(join(bot.root, "logs", "cycle.jsonl")).pop()!.outcome).toBe("memory-review");
    expect(cli(bot, ["check"], { now }).code).toBe(0);
    expect(git(bot.root, "show", "--name-only", "--format=", "HEAD")).toContain("records/routine-runs/");
    // due again a week later, a new occurrence keyed by the run
    const again = cli(bot, ["check"], { now: after(16) });
    expect(again.code).toBe(10);
    expect(again.out).toMatch(/routine:memory-review:after:20\d\d-/);
  }, SLOW);

  test("a cycle-log review line from before the routine counts as a run", () => {
    bot = makeBot();
    mem(bot, "a.md", "a\n");
    mkdirSync(join(bot.root, "logs"), { recursive: true });
    writeFileSync(join(bot.root, "logs", "cycle.jsonl"), `${JSON.stringify({ at: after(8), outcome: "memory-review", files: 1, kept: 1, updated: 0, removed: 0, added: 0, note: "old review" })}\n`);
    expect(cli(bot, ["memory", "status"], { now: after(9) }).out).toContain("not due: next review in");
    expect(cli(bot, ["routines", "history", "memory-review"], { now: after(9) }).out).toContain("old review");
  }, SLOW);

  test("routines/memory-review.md overrides the built-in; with memory: false the built-in does not exist", () => {
    bot = makeBot();
    mem(bot, "a.md", "a\n");
    routineFile(bot, "memory-review", 'cadence = "daily"', "Our own review steps.\n");
    const now = after(2);
    const st = cli(bot, ["memory", "status"], { now });
    expect(st.out).toContain("due: never reviewed (daily)");
    expect(cli(bot, ["routines", "view", "memory-review"], { now }).out).toContain("Our own review steps.");
    expect(cli(bot, ["routines", "due", "--all"], { now }).out).toContain("routines/memory-review.md");
    // its due line is the memory line, said once
    writeStream(bot, [{ key: "chat:c:1", at: "2026-03-02T14:59:00Z", conv: "c", kind: "dm", from: "p", text: "hi" }]);
    expect(cli(bot, ["cycle", "begin"], { now }).code).toBe(10);
    const end = cli(bot, ["cycle", "end", "--records", "0"], { now }).out;
    expect(end.match(/memory review due/g)?.length).toBe(1);
    expect(end).not.toContain("routines[");

    setSettings(bot, { memory: false });
    git(bot.root, "rm", "-q", "routines/memory-review.md");
    git(bot.root, "commit", "-q", "-m", "drop the override");
    const off = cli(bot, ["routines", "due", "--all"], { now }).out;
    expect(off).not.toContain("memory-review");
    expect(cli(bot, ["routines", "view", "memory-review"], { now }).out).toContain("no routine memory-review");
    expect(cli(bot, ["check", "--peek"], { now }).out).not.toContain("routines");
  }, SLOW);
});
