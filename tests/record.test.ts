/**
 * The console and the record (specs/skills/opsbot-core.md, The console, and the record): the two
 * pack sections, `record.recall` on its three surfaces, `record status`, `settings validate`,
 * and the sheet templates. gitsheets-axi is a stand-in named by OPSBOT_GITSHEETS_AXI: it reads
 * rows from $STUB_DIR/<sheet>.json, applies the comparison clauses, writes the --json-out file and
 * logs its argv, so a test can see that only `query` ever ran.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, cli, git, makeBot, makeExecutable, readLines, setSettings, writeStream, type Bot } from "./helpers";
import { WAKE_BUDGET } from "../src/opsbot-core/commands/coldstart";
import { filterClauses, recordProblems } from "../src/opsbot-core/record";
import { referenceProblems, validateSettings, withDefaults } from "../src/opsbot-core/settings";

setDefaultTimeout(30000);

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const PACK = join(REPO, "skills", "opsbot-core", "references", "pack");
const TEMPLATES = join(REPO, "skills", "opsbot-core", "templates", "sheets");

const STUB = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "query") { console.log("error: the stand-in only queries"); process.exit(2); }
const sheet = args[1];
if (process.env.STUB_FAIL) { console.log('error: "' + process.env.STUB_FAIL + '"'); console.log("code: UNKNOWN"); process.exit(1); }
const src = path.join(process.env.STUB_DIR, sheet + ".json");
if (!fs.existsSync(src)) { console.log("error: sheet config not found at .gitsheets/" + sheet + ".toml"); process.exit(1); }
let rows = JSON.parse(fs.readFileSync(src, "utf8"));
let out = null;
for (let i = 2; i < args.length; i++) {
  if (args[i] === "--filter") {
    const m = args[++i].match(/^([A-Za-z_][\\w.-]*)(!=|<=|>=|=|<|>)(.*)$/);
    if (!m) { console.log('error: "Could not parse --filter"'); process.exit(2); }
    const [, k, op, v] = m;
    const cmp = (x) => { const a = String(x[k] ?? ""); return op === "=" ? a === v : op === "!=" ? a !== v : op === "<=" ? a <= v : op === ">=" ? a >= v : op === "<" ? a < v : a > v; };
    rows = rows.filter(cmp);
  } else if (args[i].startsWith("--json-out=")) out = args[i].slice("--json-out=".length);
}
console.log("count: " + rows.length);
if (out) fs.writeFileSync(out, JSON.stringify(rows));
`;

interface Stub { dir: string; log: string; tmp: string }

/** The stand-in, the two template sheets committed under .gitsheets/, and their rows. */
function withRecord(b: Bot, rows: Record<string, Array<Record<string, unknown>>>, recall: unknown[]): Stub {
  const dir = join(b.home, "stub");
  const tmp = join(b.home, "tmp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  makeExecutable(join(dir, "gitsheets-axi"), STUB);
  for (const [sheet, r] of Object.entries(rows)) writeFileSync(join(dir, `${sheet}.json`), JSON.stringify(r));
  mkdirSync(join(b.root, ".gitsheets"), { recursive: true });
  for (const f of ["work.toml", "promises.toml"]) copyFileSync(join(TEMPLATES, f), join(b.root, ".gitsheets", f));
  git(b.root, "add", ".gitsheets");
  git(b.root, "commit", "-q", "-m", "sheets");
  setSettings(b, { record: { recall } });
  const log = join(b.home, "stub.log");
  Object.assign(b.env, { OPSBOT_GITSHEETS_AXI: join(dir, "gitsheets-axi"), STUB_DIR: dir, STUB_LOG: log, TMPDIR: tmp });
  return { dir, log, tmp };
}

const WORK = { sheet: "work", filter: "status=open", at: "cold-start", title: "In progress" };
const DUE = { sheet: "promises", filter: ["status=open", "due<=today"], at: "cycle-end", title: "Due" };
const THEIRS = { sheet: "promises", filter: "status=open", at: "item", title: "Promised to them" };

const work = (n: number, status = "open") =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, title: `task ${i}`, status, next: `step ${i}`, waiting_on: "", updated: "2026-03-01" }));
const promise = (id: string, due: string, match: string, status = "open") => ({ id, to: "a person", what: `promise ${id}`, due, status, match });

/** What the repo holds: HEAD and the working tree's status. */
const snapshot = (b: Bot) => ({ head: git(b.root, "rev-parse", "HEAD").trim(), status: git(b.root, "status", "--porcelain") });

describe("the pack sections", () => {
  /** The spec's quoted block for one pack file, without the quote markers. */
  const fromSpec = (file: string) => {
    const lines = readFileSync(join(REPO, "specs", "skills", "opsbot-core.md"), "utf8").split("\n");
    let i = lines.findIndex((l) => l.startsWith(`**\`references/pack/${file}\`**`));
    expect(i).toBeGreaterThan(0);
    while (!lines[i]!.startsWith(">")) i++;
    const out: string[] = [];
    for (; i < lines.length && lines[i]!.startsWith(">"); i++) out.push(lines[i]!.replace(/^> ?/, ""));
    return `${out.join("\n")}\n`;
  };

  test("12-console.md and 14-record.md carry the spec's text verbatim under a one-line comment header", () => {
    for (const f of ["12-console.md", "14-record.md"]) {
      const text = readFileSync(join(PACK, f), "utf8");
      const [header, ...rest] = text.split("\n");
      expect(header).toMatch(/^<!-- .* -->$/);
      expect(rest.join("\n")).toBe(fromSpec(f));
    }
  });

  test("they sort after the writing section and before the mode sections, and ride every pack", () => {
    const files = readdirSync(PACK).filter((f) => f.endsWith(".md")).sort();
    const at = (f: string) => files.indexOf(f);
    expect(at("12-console.md")).toBeGreaterThan(at("10-writing.md"));
    expect(at("14-record.md")).toBe(at("12-console.md") + 1);
    for (const mode of files.filter((f) => /-mode-/.test(f))) expect(at(mode)).toBeGreaterThan(at("14-record.md"));
    for (const settings of [{ loop: { prompt: "p", mode: "dispatcher" } }, { memory: false }]) {
      bot = makeBot();
      setSettings(bot, settings);
      const out = cli(bot, ["cold-start"], { now: T0 }).out;
      const c = out.indexOf("Your terminal is a log, not a channel (the kit's");
      const r = out.indexOf("What must outlive a compaction goes in a record (the kit's");
      const m = out.indexOf("Your loop mode:");
      expect(c).toBeGreaterThan(0);
      expect(r).toBeGreaterThan(c);
      expect(m).toBeGreaterThan(r);
      bot.cleanup();
    }
  });

  test("16-references.md carries the spec's text verbatim under a one-line comment header", () => {
    const text = readFileSync(join(PACK, "16-references.md"), "utf8");
    const [header, ...rest] = text.split("\n");
    expect(header).toMatch(/^<!-- .* -->$/);
    expect(rest.join("\n")).toBe(fromSpec("16-references.md"));
  });

  test("the references section sorts after the record section and before the mode sections, and rides every pack", () => {
    const files = readdirSync(PACK).filter((f) => f.endsWith(".md")).sort();
    const at = (f: string) => files.indexOf(f);
    expect(at("16-references.md")).toBe(at("14-record.md") + 1);
    for (const mode of files.filter((f) => /-mode-/.test(f))) expect(at(mode)).toBeGreaterThan(at("16-references.md"));
    for (const settings of [{ loop: { prompt: "p", mode: "dispatcher" } }, { loop: { prompt: "p", mode: "strategist" } }, { memory: false }]) {
      bot = makeBot();
      setSettings(bot, settings);
      const out = cli(bot, ["cold-start"], { now: T0 }).out;
      const r = out.indexOf("What must outlive a compaction goes in a record (the kit's");
      const l = out.indexOf("Every issue and pull request is a link (the kit's");
      const m = out.indexOf("Your loop mode:");
      expect(r).toBeGreaterThan(0);
      expect(l).toBeGreaterThan(r);
      expect(m).toBeGreaterThan(l);
      expect(out).not.toContain("Your tags:");
      bot.cleanup();
    }
  });

  test("references.repos lists the bot's tags under the section, in the order written, only when set", () => {
    bot = makeBot();
    setSettings(bot, { references: { repos: { "//": "the bot's tags", OPS: "example-org/ops", WEB2: "example-org/website" } } });
    const out = cli(bot, ["cold-start"], { now: T0 }).out;
    const sec = out.indexOf("Every issue and pull request is a link (the kit's");
    const tags = out.indexOf("Your tags:\n\n| Tag | Repository |\n| --- | --- |\n| `OPS` | `example-org/ops` |\n| `WEB2` | `example-org/website` |");
    const next = out.indexOf("═══", sec + 1);
    expect(sec).toBeGreaterThan(0);
    expect(tags).toBeGreaterThan(sec);
    expect(tags).toBeLessThan(next);
    expect(out.match(/Your tags:/g)?.length).toBe(1);
    bot.cleanup();
    bot = makeBot();
    setSettings(bot, { references: { repos: {} } });
    expect(cli(bot, ["cold-start"], { now: T0 }).out).not.toContain("Your tags:");
  });

  test("no pack rule tells the bot to end a turn with anything but one status line", () => {
    bot = makeBot();
    setSettings(bot, { loop: { prompt: "go on", schedule: "monitor" } });
    const out = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(out).not.toContain("one short line at most");
    expect(out).toContain("End the turn with one status line or nothing: the terminal is a log, not a channel.");
  });
});

describe("record.recall", () => {
  test("a cold-start recall is a pack section after wake.d, inside the wake budget, with limit and … N more", () => {
    bot = makeBot({ points: ["wake.d"] });
    withRecord(bot, { work: work(25) }, [WORK]);
    const out = cli(bot, ["cold-start"], { now: T0 }).out;
    const owed = out.indexOf("═══ 2. owed");
    const sec = out.indexOf("═══ 3. In progress (the record: work)");
    const log = out.indexOf("═══ 4. The cycle log, last 48 hours");
    expect(owed).toBeGreaterThan(0);
    expect(sec).toBeGreaterThan(owed);
    expect(log).toBeGreaterThan(sec);
    const body = out.slice(sec, log);
    expect(body).toContain("25 rows in work match status=open");
    // the sheet's first four fields, in the config's order
    expect(body).toContain("title: task 0 · status: open · next: step 0");
    expect(body).not.toContain("updated:");
    expect(body.match(/^title: /gm)).toHaveLength(20);
    expect(body).toContain("… 5 more: gitsheets-axi query work --filter status=open");
  });

  test("the recall sections share the wake budget, however many rows", () => {
    bot = makeBot({ points: ["wake.d"] });
    withRecord(bot, { work: work(2000) }, [{ ...WORK, limit: 2000 }]);
    bot.env.FIXTURE_WAKE_LINES = "2000";
    const out = cli(bot, ["cold-start"], { now: T0 }).out;
    const from = out.indexOf("═══ 2. owed");
    const to = out.indexOf("═══ 4. The cycle log");
    expect(Buffer.byteLength(out.slice(from, to), "utf8")).toBeLessThanOrEqual(WAKE_BUDGET + 100);
    expect(out.slice(out.indexOf("═══ 3."), to)).toMatch(/… \d+ more lines/);
  });

  test("today is the date in the bot's timezone", () => {
    bot = makeBot();
    const stub = withRecord(bot, { promises: [promise("p1", "2026-03-03", "U1")] }, [{ ...DUE, at: "cold-start" }]);
    // 15:00 UTC on 2 March is already 3 March in a UTC+14 zone
    let out = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(out).toContain("(no rows in promises match status=open due<=2026-03-02)");
    setSettings(bot, { timezone: "Pacific/Kiritimati" });
    out = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(out).toContain("1 row in promises match status=open due<=2026-03-03");
    expect(out).toContain("to: a person · what: promise p1 · due: 2026-03-03 · status: open");
    const calls = readFileSync(stub.log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.at(-1)).toEqual(["query", "promises", "--filter", "status=open", "--filter", "due<=2026-03-03", expect.stringMatching(/^--json-out=/)]);
  });

  test("a cycle-end recall prints with the closing lines, and nothing when no row matches", () => {
    bot = makeBot();
    const rows = { promises: [promise("p1", "2026-03-01", "U1"), promise("p2", "2026-03-09", "U1"), promise("p3", "2026-02-01", "U2", "kept")] };
    withRecord(bot, rows, [DUE]);
    writeStream(bot, [{ key: "chat:c:1", at: T0, conv: "c", kind: "dm", from: "U9", text: "hi" }]);
    expect(cli(bot, ["cycle", "begin"], { now: T0 }).code).toBe(10);
    const end = cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:01:00Z" });
    expect(end.code).toBe(0);
    expect(end.out).toContain("Due (promises: status=open due<=2026-03-02): 1");
    expect(end.out).toContain("to: a person · what: promise p1 · due: 2026-03-01 · status: open");
    expect(end.out).not.toContain("promise p2");
    expect(end.out).not.toContain("promise p3");

    writeFileSync(join(bot.home, "stub", "promises.json"), "[]");
    writeStream(bot, [{ key: "chat:c:2", at: T0, conv: "c", kind: "dm", from: "U9", text: "again" }]);
    expect(cli(bot, ["cycle", "begin"], { now: "2026-03-02T15:10:00Z" }).code).toBe(10);
    const quiet = cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:11:00Z" });
    expect(quiet.code).toBe(0);
    expect(quiet.out).not.toContain("recall");
  });

  test("an item recall adds the rows whose match is the item's from or conv, capped", () => {
    bot = makeBot();
    const many = Array.from({ length: 4 }, (_, i) => promise(`g${i}`, "2026-03-05", "G1"));
    withRecord(bot, { promises: [promise("p1", "2026-03-01", "U1"), ...many] }, [{ ...THEIRS, limit: 3 }]);
    writeStream(bot, [
      { key: "chat:d:1", at: T0, conv: "D1", kind: "dm", from: "U1", text: "where is it?" },
      { key: "chat:g:1", at: T0, conv: "G1", kind: "group", from: "U5", text: "hello" },
      { key: "chat:d:2", at: T0, conv: "D2", kind: "dm", from: "U7", text: "nothing owed" },
    ]);
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(10);
    const items = r.out.split(/\n(?=\s*- n: )/);
    const one = items.find((x) => x.includes("chat:d:1"))!;
    expect(one).toContain("Promised to them (promises): 1");
    expect(one).toContain("what: promise p1");
    const group = items.find((x) => x.includes("chat:g:1"))!;
    expect(group).toContain("Promised to them (promises): 4");
    expect(group).toContain("… 1 more: gitsheets-axi query promises --filter status=open --filter match=G1");
    const none = items.find((x) => x.includes("chat:d:2"))!;
    expect(none).not.toContain("Promised to them");
  });

  test("a missing sheet or a failing query is one line, never an empty section; settings validate reports both", () => {
    bot = makeBot();
    const stub = withRecord(bot, { work: work(2) }, [WORK, { sheet: "decisions", at: "cold-start", title: "Decided" }]);
    let out = cli(bot, ["cold-start"], { now: T0 }).out;
    const sec = out.slice(out.indexOf("═══ 3. Decided (the record: decisions)"));
    expect(sec.split("\n")[1]).toBe("recall of decisions could not run: sheet decisions is missing: no .gitsheets/decisions.toml");
    let v = cli(bot, ["settings", "validate"]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("record.recall[1] names sheet decisions, but .gitsheets/decisions.toml does not exist");

    setSettings(bot, { record: { recall: [WORK] } });
    bot.env.STUB_FAIL = "the store is broken";
    out = cli(bot, ["cold-start"], { now: T0 }).out;
    const body = out.slice(out.indexOf("═══ 2. In progress"), out.indexOf("═══ 3."));
    expect(body.trim().split("\n")).toEqual([
      "═══ 2. In progress (the record: work)",
      "recall of work could not run: gitsheets-axi query failed (exit 1): the store is broken",
    ]);
    v = cli(bot, ["settings", "validate"]);
    expect(v.code).toBe(1);
    expect(v.out).toContain("record.recall[0] (work) cannot run: gitsheets-axi query failed (exit 1): the store is broken");
    // the binary itself missing reads the same way
    delete bot.env.STUB_FAIL;
    bot.env.OPSBOT_GITSHEETS_AXI = join(stub.dir, "no-such-binary");
    expect(cli(bot, ["cold-start"], { now: T0 }).out).toContain("recall of work could not run: gitsheets-axi query failed (exit 127)");
  });

  test("a failing item recall is one line in the check output, and the items still print", () => {
    bot = makeBot();
    withRecord(bot, { promises: [] }, [THEIRS]);
    bot.env.STUB_FAIL = "no luck";
    writeStream(bot, [{ key: "chat:d:1", at: T0, conv: "D1", kind: "dm", from: "U1", text: "hi" }]);
    const r = cli(bot, ["check"], { now: T0 });
    expect(r.code).toBe(10);
    expect(r.out).toContain("recall of promises could not run: gitsheets-axi query failed (exit 1): no luck");
    expect(r.out).toContain("chat:d:1");
  });

  test("settings validate refuses an unknown key, a bad at, and two clauses in one string", () => {
    bot = makeBot();
    withRecord(bot, {}, [WORK]);
    const bad = (record: unknown) => {
      setSettings(bot, { record }, false);
      const r = cli(bot, ["settings", "validate"]);
      expect(r.code).toBe(1);
      return r.out;
    };
    expect(bad({ recall: [WORK], extra: 1 })).toContain("unknown key record.extra");
    expect(bad({ recall: [{ ...WORK, sort: "due" }] })).toContain("unknown key record.recall[0].sort");
    expect(bad({ recall: [{ ...WORK, at: "dawn" }] })).toContain("record.recall[0].at must be one of cold-start, cycle-end, item");
    expect(bad({ recall: [{ ...WORK, filter: "status=open due<=today" }] })).toContain("holds more than one clause; write them as a list");
    expect(bad({ recall: [{ ...WORK, filter: ["status is open"] }] })).toContain("is not a gitsheets-axi filter clause");
    expect(bad({ recall: [{ ...WORK, limit: 0 }] })).toContain("record.recall[0].limit must be a positive whole number");
    expect(bad({ recall: [{ at: "item" }] })).toContain("missing required key record.recall[0].sheet");
    setSettings(bot, { record: { recall: [WORK, DUE, THEIRS] } }, false);
    expect(cli(bot, ["settings", "validate"]).out).toContain("valid · opsbot.json");
  });

  test("record status lists every sheet, flags one no recall names, and counts open rows", () => {
    bot = makeBot();
    withRecord(bot, { work: [...work(3), ...work(2, "done")], promises: [promise("p1", "2026-03-01", "U1")] }, [WORK]);
    let r = cli(bot, ["record", "status"], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 sheets · 1 recall · 1 no recall names");
    expect(r.out).toMatch(/work,cold-start,status=open,3,""/);
    expect(r.out).toMatch(/promises,none,none,unknown,"no recall names it/);
    setSettings(bot, { record: { recall: [WORK, DUE] } });
    r = cli(bot, ["record", "status"], { now: T0 });
    expect(r.out).toContain("2 sheets · 2 recalls");
    expect(r.out).not.toContain("no recall names");
    expect(r.out).toMatch(/promises,cycle-end,status=open due<=2026-03-02,1,""/);
  });

  test("a recall never writes: the repo is unchanged after every surface, and nothing is left in the temp dir", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d"] });
    const stub = withRecord(bot, { work: work(2), promises: [promise("p1", "2026-03-01", "U1")] }, [WORK, DUE, THEIRS]);
    const before = snapshot(bot);
    for (const args of [["cold-start"], ["record", "status"], ["settings", "validate"], ["settings", "validate", "--head"]]) {
      expect(cli(bot, args, { now: T0 }).code).toBe(0);
      expect(snapshot(bot)).toEqual(before);
    }
    // the cycle commits its own log and nothing else
    writeStream(bot, [{ key: "chat:d:1", at: T0, conv: "D1", kind: "dm", from: "U1", text: "hi" }]);
    expect(cli(bot, ["cycle", "begin"], { now: T0 }).code).toBe(10);
    expect(cli(bot, ["cycle", "end", "--records", "0"], { now: "2026-03-02T15:01:00Z" }).code).toBe(0);
    const touched = git(bot.root, "diff", "--name-only", before.head, "HEAD").trim().split("\n").sort();
    expect(touched).toEqual(["logs/cycle.jsonl", "logs/intake/seen", "logs/intake/watermark"]);
    expect(git(bot.root, "status", "--porcelain", "--", ".gitsheets", "records")).toBe("");
    // only queries ran, and each result file went with its temp dir
    const calls = readFileSync(stub.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((c) => c[0] === "query")).toBe(true);
    expect(readdirSync(stub.tmp).filter((f) => f.startsWith("opsbot-recall-"))).toEqual([]);
    expect(readLines(join(bot.root, "logs/cycle.jsonl")).length).toBeGreaterThan(0);
  });
});

describe("the sheet templates", () => {
  const SPEC_FIELDS: Record<string, string[]> = {
    work: ["title", "status", "next", "waiting_on", "updated"],
    promises: ["to", "what", "due", "status", "settled_by"],
  };

  for (const sheet of ["work", "promises"]) {
    test(`${sheet}.toml is a gitsheets config with a schema, required fields, a path template, and valid recall comments`, () => {
      const text = readFileSync(join(TEMPLATES, `${sheet}.toml`), "utf8");
      const cfg = Bun.TOML.parse(text) as { gitsheet: { root: string; path: string; schema: { type: string; required: string[]; properties: Record<string, { type: string }> } } };
      expect(cfg.gitsheet.root).toBe(`records/${sheet}`);
      expect(cfg.gitsheet.path).toMatch(/\$\{\{ *[a-z_]+ *\}\}/);
      const pathField = cfg.gitsheet.path.match(/\$\{\{ *([a-z_]+) *\}\}/)![1]!;
      const { schema } = cfg.gitsheet;
      expect(schema.type).toBe("object");
      expect(schema.required).toContain(pathField);
      for (const r of schema.required) expect(schema.properties[r]).toBeDefined();
      for (const f of SPEC_FIELDS[sheet]!) expect(schema.properties[f]).toBeDefined();
      // the first four, as a recall prints them by default, are the spec's first four
      expect(Object.keys(schema.properties).slice(0, 4)).toEqual(SPEC_FIELDS[sheet]!.slice(0, 4));
      // every recall in the comment is a valid entry naming this sheet
      const recalls = text.split("\n").filter((l) => /^#\s+\{ "sheet"/.test(l)).map((l) => JSON.parse(l.replace(/^#\s+/, "")));
      expect(recalls.length).toBeGreaterThan(0);
      expect(recordProblems({ recall: recalls })).toEqual([]);
      for (const r of recalls) {
        expect(r.sheet).toBe(sheet);
        expect(filterClauses(r.filter).length).toBeGreaterThan(0);
        if (r.at === "item") expect(schema.properties.match).toBeDefined();
      }
    });
  }

  const real = spawnSync("gitsheets-axi", ["--version"], { encoding: "utf8" });
  test.skipIf(real.status !== 0)("with the real gitsheets-axi: both templates take a valid row, refuse a bad one, and answer their recalls", () => {
    bot = makeBot();
    mkdirSync(join(bot.root, ".gitsheets"));
    for (const f of ["work.toml", "promises.toml"]) copyFileSync(join(TEMPLATES, f), join(bot.root, ".gitsheets", f));
    git(bot.root, "add", ".gitsheets");
    git(bot.root, "commit", "-q", "-m", "sheets");
    const gs = (...args: string[]) => spawnSync("gitsheets-axi", args, { cwd: bot.root, encoding: "utf8" });
    expect(gs("upsert", "work", "--data", JSON.stringify(work(1)[0])).status).toBe(0);
    expect(gs("upsert", "promises", "--data", JSON.stringify(promise("p1", "2026-03-01", "U1"))).status).toBe(0);
    expect(gs("upsert", "promises", "--data", JSON.stringify({ id: "p2", to: "x" })).status).not.toBe(0);
    git(bot.root, "checkout", "-q", "HEAD", "--", ".");
    setSettings(bot, { timezone: "UTC", record: { recall: [WORK, DUE, THEIRS] } });
    expect(cli(bot, ["settings", "validate"]).out).toContain("valid · opsbot.json");
    const out = cli(bot, ["cold-start"], { now: T0 }).out;
    expect(out).toContain("1 row in work match status=open");
    const st = cli(bot, ["record", "status"], { now: T0 }).out;
    expect(st).toMatch(/promises,cycle-end,status=open due<=2026-03-02,1,""/);
    expect(existsSync(join(bot.root, "records", "work", "w0.toml"))).toBe(true);
  }, 120_000);
});

describe("references.repos", () => {
  const base = { name: "x", mark: "m", loop: { prompt: "p" }, runtime: { agent: "x" } };
  const problems = (references: unknown) => validateSettings({ ...base, references });

  test("a valid object passes, with a // comment, and is read in the order written", () => {
    const references = { "//": "tags", repos: { "//": "c", OPS: "example-org/ops", A1: "example.org/site_2" } };
    expect(problems(references)).toEqual([]);
    expect(problems({})).toEqual([]);
    expect(problems({ repos: {} })).toEqual([]);
    expect(Object.entries(withDefaults({ ...base, references }).references.repos)).toEqual([["OPS", "example-org/ops"], ["A1", "example.org/site_2"]]);
    expect(withDefaults(base).references.repos).toEqual({});
  });

  test("it refuses a non-object, an unknown key, a repos that is not an object, a bad tag, a bad repository and a repository named twice", () => {
    expect(problems("OPS")).toEqual(["references must be an object ({repos})"]);
    expect(problems({ tags: {} }).join(" ")).toContain("unknown key references.tags");
    expect(problems({ repos: ["example-org/ops"] }).join(" ")).toContain("references.repos must be an object");
    for (const tag of ["ops", "Ops", "1OPS", "OPS-2", "OP S", ""]) {
      expect(referenceProblems({ repos: { [tag]: "example-org/ops" } }).join(" ")).toContain("must be capital letters and digits, starting with a letter");
    }
    for (const repo of ["ops", "example-org/ops/extra", "https://github.com/example-org/ops", "", 7]) {
      expect(referenceProblems({ repos: { OPS: repo } }).join(" ")).toContain("must be a repository as owner/repo");
    }
    expect(referenceProblems({ repos: { OPS: "example-org/ops", OPS2: "Example-Org/Ops" } }).join(" ")).toContain("one repository has one tag");
  });

  test("settings validate names the problem", () => {
    bot = makeBot();
    setSettings(bot, { references: { repos: { ops: "example-org/ops" } } });
    const r = cli(bot, ["settings", "validate"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("references.repos tag");
  });
});
