/**
 * Ledgers, baselines and post logs on the log branch (specs/behaviors/log-branch.md,
 * plans/log-branch-ledgers.md): `log append`, `log state get|set`, `log read`, `log seen`.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASE_SETTINGS, cli, git, makeBot, setSettings, writeStream, type Bot } from "./helpers";
import { SHEET_CONFIGS } from "../src/opsbot-core/log";
import { clauseMatches } from "../src/opsbot-core/commands/logbranch";

setDefaultTimeout(120_000);

const B = "opsbot/log";
const LOG = { log: { branch: B, ledgers: { labels: ["thread", "label"], mail: ["to"] }, state: { inbox: ["cursor"] } } };
let bots: Bot[] = [];
let dirs: string[] = [];
afterEach(() => {
  for (const b of bots) b.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  bots = [];
  dirs = [];
});

function bot(settings: Record<string, unknown> = { ...BASE_SETTINGS, ...LOG }): Bot {
  const b = makeBot({ settings });
  bots.push(b);
  return b;
}

const item = (n: number, at: string) => ({ key: `chat:c:${n}`, at, conv: "c", kind: "group", from: "p", text: `hi ${n}` });
const commits = (b: Bot) => {
  const r = spawnSync("git", ["-C", b.root, "rev-list", "--first-parent", B], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
};
const filesOf = (b: Bot, c: string) => git(b.root, "show", "--name-only", "--format=", c).trim().split("\n").filter(Boolean);
const head = (b: Bot) => git(b.root, "rev-parse", "HEAD").trim();
const status = (b: Bot) => git(b.root, "status", "--porcelain").trim();
const append = (b: Bot, target: string, rec: unknown, now: string) => cli(b, ["log", "append", target], { now, input: typeof rec === "string" ? rec : JSON.stringify(rec) });
function jsonOut(b: Bot, args: string[], now: string): { code: number; out: string; rows: unknown } {
  const d = mkdtempSync(join(tmpdir(), "opsbot-read-"));
  dirs.push(d);
  const f = join(d, "rows.json");
  const r = cli(b, [...args, "--json-out", f], { now });
  return { code: r.code, out: r.out, rows: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined };
}

describe("settings", () => {
  test("log.ledgers and log.state: names with the fields a record must carry, and only with log.branch", () => {
    const b = bot();
    expect(cli(b, ["settings", "validate"]).code).toBe(0);
    const bad = (log: Record<string, unknown>, want: string) => {
      setSettings(b, { log });
      const r = cli(b, ["settings", "validate"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(want);
    };
    bad({ branch: B, ledgers: ["labels"] }, "log.ledgers must be an object");
    bad({ branch: B, ledgers: { labels: "thread" } }, "log.ledgers.labels must be a list of field names");
    bad({ branch: B, ledgers: { "Bad Name": [] } }, "must be lower-case letters, digits, - and _");
    bad({ branch: B, ledgers: { labels: ["hash"] } }, "log.ledgers.labels: hash is set by the log itself");
    bad({ branch: B, state: { inbox: ["cursor", "cursor"] } }, "log.state.inbox names a field twice");
    bad({ ledgers: { labels: [] } }, "log.ledgers needs log.branch");
  });

  test("with log.branch unset, the commands refuse and nothing is written", () => {
    const b = bot({ ...BASE_SETTINGS });
    const r = append(b, "labels", { thread: "t1", label: "x" }, "2026-03-02T15:00:00Z");
    expect(r.code).toBe(2);
    expect(r.out).toContain("needs log.branch");
    expect(commits(b)).toEqual([]);
    expect(status(b)).toBe("");
  });
});

describe("writes", () => {
  test("a ledger append and a state set in a cycle ride its commit; outside a cycle each is its own; neither touches the working tree", () => {
    const b = bot();
    const before = head(b);
    writeStream(b, [item(1, "2026-03-02T14:58:00Z")]);
    expect(cli(b, ["cycle", "begin"], { now: "2026-03-02T15:00:00Z" }).code).toBe(10);
    const n0 = commits(b).length;
    const a = append(b, "labels", { thread: "t1", label: "waiting" }, "2026-03-02T15:01:02Z");
    expect(a.code).toBe(0);
    expect(a.out).toContain("staged: rides this cycle's commit");
    expect(cli(b, ["log", "state", "set", "inbox"], { now: "2026-03-02T15:01:03Z", input: '{"cursor": 41}' }).code).toBe(0);
    // staged: no commit yet (a cycle that found something commits at its end), and the reads see them
    expect(n0).toBe(0);
    expect(commits(b).length).toBe(0);
    expect(jsonOut(b, ["log", "read", "ledgers/labels"], "2026-03-02T15:01:04Z").rows).toEqual([{ at: "2026-03-02T15:01:02Z", thread: "t1", label: "waiting" }]);
    expect(jsonOut(b, ["log", "state", "get", "inbox"], "2026-03-02T15:01:04Z").rows).toEqual({ cursor: 41 });
    expect(cli(b, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:03:00Z" }).code).toBe(0);
    const cycle = commits(b);
    expect(cycle.length).toBe(2); // the root, then the cycle's one commit
    const files = filesOf(b, cycle[0]!);
    expect(files.some((f) => f.startsWith("cycles/2026/03/02/15/0300-finished"))).toBe(true);
    expect(files.filter((f) => f.startsWith("ledgers/"))).toHaveLength(1);
    expect(files.find((f) => f.startsWith("ledgers/"))).toMatch(/^ledgers\/labels\/2026\/03\/02\/150102-[0-9a-f]{12}\.toml$/);
    expect(files).toContain("state/inbox.toml");

    // outside a cycle: each write is a commit of its own, at once
    const out = append(b, "labels", { thread: "t2", label: "done" }, "2026-03-02T15:20:00Z");
    expect(out.code).toBe(0);
    expect(out.out).toContain("committed");
    const c1 = commits(b);
    expect(c1.length).toBe(cycle.length + 1);
    expect(filesOf(b, c1[0]!)).toEqual([expect.stringMatching(/^ledgers\/labels\/2026\/03\/02\/152000-/)]);
    expect(cli(b, ["log", "state", "set", "inbox"], { now: "2026-03-02T15:21:00Z", input: '{"cursor": 42}' }).code).toBe(0);
    const c2 = commits(b);
    expect(c2.length).toBe(c1.length + 1);
    expect(filesOf(b, c2[0]!)).toEqual(["state/inbox.toml"]);
    // the commit carries the log's trailers, so the tip still says the watermark
    const tr = git(b.root, "log", "-1", "--format=%(trailers:only,unfold)", B);
    expect(tr).toContain("Watermark: 2026-03-02T15:00:00Z");
    expect(tr).toContain(`Program: ${before}`);
    // an unchanged baseline writes nothing
    const same = cli(b, ["log", "state", "set", "inbox"], { now: "2026-03-02T15:22:00Z", input: '{"cursor": 42}' });
    expect(same.out).toContain("unchanged");
    expect(commits(b).length).toBe(c2.length);
    // nothing in the working tree, the program branch where it was
    expect(head(b)).toBe(before);
    expect(status(b)).toBe("");
    expect(existsSync(join(b.root, "logs"))).toBe(false);
    expect(existsSync(join(b.root, ".git", "opsbot-log-pending.json"))).toBe(false);
  });

  test("a record missing a declared field is refused with the field named; so is an undeclared ledger or a field the log sets", () => {
    const b = bot();
    const r = append(b, "labels", { thread: "t1" }, "2026-03-02T15:00:00Z");
    expect(r.code).toBe(2);
    expect(r.out).toContain("record 1 has no label: ledger labels requires thread, label");
    const batch = append(b, "labels", `{"thread":"t1","label":"a"}\n{"label":"b"}\n`, "2026-03-02T15:00:00Z");
    expect(batch.out).toContain("record 2 has no thread");
    expect(append(b, "nope", { x: 1 }, "2026-03-02T15:00:00Z").out).toContain("no ledger nope in log.ledgers");
    expect(append(b, "labels", { thread: "t", label: "l", hash: "x" }, "2026-03-02T15:00:00Z").out).toContain("hash is set by the log itself");
    expect(append(b, "labels", { thread: "t", label: "l", at: "yesterday" }, "2026-03-02T15:00:00Z").out).toContain("at must be an ISO time in UTC");
    const s = cli(b, ["log", "state", "set", "inbox"], { now: "2026-03-02T15:00:00Z", input: '{"other": 1}' });
    expect(s.code).toBe(2);
    expect(s.out).toContain("the value has no cursor: state inbox requires cursor");
    // nothing was written by any of them
    expect(commits(b)).toEqual([]);
  });

  test("a batch is one commit with one gitsheets write per sheet; a branch made before the sheet existed gets its config in that commit", () => {
    const b = bot();
    // a log branch as the core made it before these sheets: only cycles, outages, seen, routines
    const d = mkdtempSync(join(tmpdir(), "opsbot-old-"));
    dirs.push(d);
    let tip = "";
    for (const s of ["cycles", "outages", "seen", "routines"] as const) {
      writeFileSync(join(d, `${s}.json`), JSON.stringify(SHEET_CONFIGS[s].schema));
      const r = spawnSync("gitsheets-axi", ["--branch", B, "init", s, "--path", SHEET_CONFIGS[s].path, "--schema", join(d, `${s}.json`), "--message", "log: the sheets of the loop's log", ...(tip ? ["--replace", tip] : [])], { cwd: b.root, encoding: "utf8" });
      expect(r.status).toBe(0);
      tip = git(b.root, "rev-parse", B).trim();
    }
    expect(git(b.root, "ls-tree", "--name-only", `${B}:.gitsheets`).trim().split("\n")).toEqual(["cycles.toml", "outages.toml", "routines.toml", "seen.toml"]);
    // count the gitsheets calls
    const calls = join(d, "calls");
    const wrap = join(d, "gs");
    writeFileSync(wrap, `#!/usr/bin/env bash\necho "$*" >> ${calls}\nexec gitsheets-axi "$@"\n`, { mode: 0o755 });
    const lines = ["t1", "t2", "t3"].map((t) => JSON.stringify({ thread: t, label: "x" })).join("\n");
    const r = cli(b, ["log", "append", "labels"], { now: "2026-03-02T15:00:00Z", input: lines, env: { OPSBOT_GITSHEETS_AXI: wrap } });
    expect(r.code).toBe(0);
    const all = commits(b);
    expect(all).toHaveLength(2);
    const files = filesOf(b, all[0]!);
    expect(files).toContain(".gitsheets/ledgers.toml");
    expect(files.filter((f) => f.startsWith("ledgers/labels/"))).toHaveLength(3);
    const writes = readFileSync(calls, "utf8").trim().split("\n").filter((l) => / (upsert|init|commit) /.test(` ${l} `));
    expect(writes.map((l) => l.split(" ").slice(2, 4).join(" "))).toEqual(["init ledgers", "upsert ledgers"]);
    expect(git(b.root, "log", "-1", "--format=%(trailers:only,unfold)", B)).toContain("Program: ");
  });
});

describe("reads", () => {
  test("log read --since over a day walks only that day's partitions", () => {
    const b = bot();
    for (const [at, t] of [["2026-03-01T10:00:00Z", "d1"], ["2026-03-02T09:00:00Z", "d2a"], ["2026-03-02T17:30:00Z", "d2b"]]) {
      expect(append(b, "labels", { thread: t, label: "x", at }, "2026-03-02T18:00:00Z").code).toBe(0);
    }
    // a record file on the first day that no reader can parse: a walk that opens it fails
    const idx = join(b.home, "idx");
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const g = (...a: string[]) => {
      const r = spawnSync("git", ["-C", b.root, ...a], { encoding: "utf8", env, input: a[0] === "hash-object" ? "not = = toml [[\n" : undefined });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    g("read-tree", B);
    const blob = g("hash-object", "-w", "--stdin");
    g("update-index", "--add", "--cacheinfo", `100644,${blob},ledgers/labels/2026/03/01/120000-badbadbadbad.toml`);
    const tree = g("write-tree");
    const c = g("commit-tree", tree, "-p", B, "-m", "a record no reader can parse");
    g("update-ref", `refs/heads/${B}`, c);
    const day = jsonOut(b, ["log", "read", "ledgers/labels", "--since", "2026-03-02T00:00:00Z"], "2026-03-02T18:00:00Z");
    expect(day.code).toBe(0);
    expect((day.rows as Array<{ thread: string }>).map((r) => r.thread)).toEqual(["d2a", "d2b"]);
    const hour = jsonOut(b, ["log", "read", "ledgers/labels", "--since", "2026-03-02T12:00:00Z", "--filter", "label=x"], "2026-03-02T18:00:00Z");
    expect((hour.rows as Array<{ thread: string }>).map((r) => r.thread)).toEqual(["d2b"]);
    // the whole sheet opens the first day too, and fails on it
    const whole = cli(b, ["log", "read", "ledgers/labels"], { now: "2026-03-02T18:00:00Z" });
    expect(whole.code).toBe(1);
    expect(whole.out).toContain("TOML");
  });

  test("log read --repo reads another bot's ledger from its fetched log branch, never this checkout's branches", () => {
    const a = bot();
    for (const t of ["t1", "t2"]) expect(append(a, "labels", { thread: t, label: "sent" }, "2026-03-02T15:00:00Z").code).toBe(0);
    // the other repo is reached through a remote, as on another host
    const remote = join(a.home, "a.git");
    git(a.home, "init", "-q", "--bare", remote);
    git(a.root, "push", "-q", remote, B);
    const reader = bot({ ...BASE_SETTINGS }); // a bot still writing files may read another's branch
    const r = jsonOut(reader, ["log", "read", "ledgers/labels", "--repo", remote], "2026-03-02T16:00:00Z");
    expect(r.code).toBe(0);
    const rows = (r.rows as Array<{ thread: string }>).slice().sort((x, y) => (x.thread < y.thread ? -1 : 1));
    expect(rows).toEqual([
      { at: "2026-03-02T15:00:00Z", thread: "t1", label: "sent" },
      { at: "2026-03-02T15:00:00Z", thread: "t2", label: "sent" },
    ] as never);
    // by path too, and newer records arrive on the next read
    expect(append(a, "labels", { thread: "t3", label: "sent" }, "2026-03-02T15:30:00Z").code).toBe(0);
    const byPath = jsonOut(reader, ["log", "read", "ledgers/labels", "--repo", a.root, "--since", "2026-03-02T15:10:00Z"], "2026-03-02T16:00:00Z");
    expect(byPath.rows).toEqual([{ at: "2026-03-02T15:30:00Z", thread: "t3", label: "sent" }]);
    // the reader's own checkout gained no branch and no file
    expect(git(reader.root, "for-each-ref", "--format=%(refname)").trim().split("\n")).toEqual(["refs/heads/main"]);
    expect(status(reader)).toBe("");
    expect(cli(reader, ["log", "read", "ledgers/labels", "--repo", join(a.home, "nowhere")], { now: "2026-03-02T16:00:00Z" }).out).toContain("cannot fetch opsbot/log");
  });

  test("log seen answers from the branch, staged keys included, with nothing in the working tree", () => {
    const b = bot();
    writeStream(b, [item(1, "2026-03-02T14:58:00Z")]);
    expect(cli(b, ["cycle", "begin"], { now: "2026-03-02T15:00:00Z" }).code).toBe(10);
    // inside the cycle the key is staged, and already seen
    expect(cli(b, ["log", "seen", "chat:c:1"]).code).toBe(0);
    expect(cli(b, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:03:00Z" }).code).toBe(0);
    const yes = cli(b, ["log", "seen", "chat:c:1"]);
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("seen: yes");
    expect(cli(b, ["log", "seen", "chat:c:2"]).code).toBe(1);
    expect(existsSync(join(b.root, "logs"))).toBe(false);
  });

  test("state get: not set, then the value", () => {
    const b = bot();
    const none = jsonOut(b, ["log", "state", "get", "inbox"], "2026-03-02T15:00:00Z");
    expect(none.code).toBe(0);
    expect(none.out).toContain("inbox · not set");
    expect(none.rows).toBeNull();
    cli(b, ["log", "state", "set", "inbox"], { now: "2026-03-02T15:00:00Z", input: '{"cursor": 7, "seen": {"a": [1, 2]}}' });
    expect(jsonOut(b, ["log", "state", "get", "inbox"], "2026-03-02T15:01:00Z").rows).toEqual({ cursor: 7, seen: { a: [1, 2] } });
  });

  test("the filter clauses applied to staged records", () => {
    const r = { at: "2026-03-02T15:00:00Z", n: 9, label: "waiting", tags: [] };
    expect(clauseMatches(r, "label=waiting")).toBe(true);
    expect(clauseMatches(r, "label!=waiting")).toBe(false);
    expect(clauseMatches(r, "n>10")).toBe(false);
    expect(clauseMatches(r, "n<10")).toBe(true);
    expect(clauseMatches(r, "at>=2026-03-02T14:00:00Z")).toBe(true);
    expect(clauseMatches(r, "label~^wait")).toBe(true);
    expect(clauseMatches(r, "label in (done, waiting)")).toBe(true);
    expect(clauseMatches(r, "tags:empty")).toBe(true);
    expect(clauseMatches(r, "missing:present")).toBe(false);
  });
});
