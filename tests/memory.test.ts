import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SETTINGS, cli, git, makeBot, readLines, setSettings, writeStream, type Bot } from "./helpers";
import { validateSettings, withDefaults } from "../src/opsbot-core/settings";
import { frontmatterType, reviewCounts } from "../src/opsbot-core/memory";

let bot: Bot;
afterEach(() => bot?.cleanup());

// Spawning several CLI processes per test: give each test room on a slow runner.
const SLOW = 60_000;
const DAY = 86_400_000;
/** A clock `days` from the real now: memory files carry real file and commit times. */
/** Rounded up to the next whole second, since the CLI's clock has no milliseconds. */
const after = (days: number) => new Date(Math.ceil((Date.now() + days * DAY) / 1000) * 1000 + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const base = { name: "x", mark: "m", loop: { prompt: "p" }, runtime: { agent: "x" } };
const problems = (memory: unknown) => validateSettings({ ...base, memory }).join("; ");

function mem(b: Bot, name: string, body: string, dir = "memory"): void {
  const p = join(b.root, dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

const headFiles = (b: Bot) => git(b.root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();
const item = (n: number) => ({ key: `chat:c:${n}`, at: "2026-03-02T14:59:00Z", conv: "c", kind: "dm", from: "p", text: `m${n}` });

describe("memory settings", () => {
  test("defaults, false, and what is refused", () => {
    expect(withDefaults(base).memory).toEqual({ dir: "memory", review_days: 7 });
    expect(withDefaults({ ...base, memory: { dir: "./notes/mem/" } }).memory).toEqual({ dir: "notes/mem", review_days: 7 });
    expect(withDefaults({ ...base, memory: { review_days: 3 } }).memory).toEqual({ dir: "memory", review_days: 3 });
    expect(withDefaults({ ...base, memory: false }).memory).toBeNull();
    expect(problems(false)).toBe("");
    expect(problems({ dir: "notes/mem", review_days: 14 })).toBe("");
    for (const bad of ["/abs/memory", "~/memory", "../memory", "a/../../b", ".", "", ".git", ".git/memory", ".scratch/memory", ".claude/memory"]) {
      expect(problems({ dir: bad })).toContain("memory.dir");
    }
    expect(problems({ dir: 5 })).toContain("memory.dir");
    expect(problems({ review_days: 0 })).toContain("memory.review_days");
    expect(problems({ other: 1 })).toContain("unknown key memory.other");
    expect(problems(true)).toContain("memory must be an object");
    expect(problems("memory")).toContain("memory must be an object");
  });

  test("settings validate refuses .claude/settings.json setting auto memory itself", () => {
    bot = makeBot();
    mkdirSync(join(bot.root, ".claude"), { recursive: true });
    writeFileSync(join(bot.root, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: "/elsewhere" }));
    const r = cli(bot, ["settings", "validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("autoMemoryDirectory");
    writeFileSync(join(bot.root, ".claude", "settings.json"), JSON.stringify({ permissions: {} }));
    expect(cli(bot, ["settings", "validate"]).code).toBe(0);
  }, SLOW);
});

describe("start and auto memory", () => {
  test("--dry-run passes the repo's absolute memory directory in the one --settings object, and creates nothing", () => {
    bot = makeBot();
    const root = realpathSync(bot.root);
    const r = cli(bot, ["start", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out.match(/"--settings"/g)?.length).toBe(1);
    expect(r.out).toContain('\\"autoMemoryEnabled\\":true');
    expect(r.out).toContain(`\\"autoMemoryDirectory\\":\\"${root}/memory\\"`);
    expect(r.out).toContain("autoCompactEnabled");
    expect(r.out).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(r.out).not.toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    expect(existsSync(join(bot.root, "memory"))).toBe(false);
    setSettings(bot, { memory: { dir: "notes/mem" } });
    expect(cli(bot, ["start", "--dry-run"]).out).toContain(`\\"autoMemoryDirectory\\":\\"${root}/notes/mem\\"`);
  }, SLOW);

  test("memory: false turns it off with both switches", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, memory: false } });
    const r = cli(bot, ["start", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('\\"autoMemoryEnabled\\":false');
    expect(r.out).toContain('\\"CLAUDE_CODE_DISABLE_AUTO_MEMORY\\":\\"1\\"');
    expect(r.out).not.toContain("autoMemoryDirectory");
    expect(cli(bot, []).out).toContain("memory: off");
    expect(cli(bot, ["memory", "status"]).code).toBe(1);
  }, SLOW);
});

describe("memory is committed with the cycle", () => {
  test("the check commits memory written between cycles, and a deletion, and nothing else", () => {
    bot = makeBot();
    mem(bot, "MEMORY.md", "- [A](a.md) — fact a\n");
    mem(bot, "a.md", "---\ntype: feedback\n---\nfact a\n");
    mem(bot, "sub/b.md", "fact b\n");
    writeFileSync(join(bot.root, "stray.txt"), "not memory\n");
    expect(cli(bot, ["check"], { now: "2026-03-02T15:00:00Z" }).code).toBe(0);
    expect(headFiles(bot)).toEqual(["logs/cycle.jsonl", "logs/intake/seen", "logs/intake/watermark", "memory/MEMORY.md", "memory/a.md", "memory/sub/b.md"]);
    expect(git(bot.root, "status", "--porcelain").trim()).toBe("?? stray.txt");

    rmSync(join(bot.root, "memory", "a.md"));
    mem(bot, "MEMORY.md", "");
    expect(cli(bot, ["check"], { now: "2026-03-02T15:10:00Z" }).code).toBe(0);
    expect(headFiles(bot)).toEqual(["logs/cycle.jsonl", "logs/intake/watermark", "memory/MEMORY.md", "memory/a.md"]);
    expect(git(bot.root, "ls-files", "memory").trim().split("\n").sort()).toEqual(["memory/MEMORY.md", "memory/sub/b.md"]);
    expect(git(bot.root, "status", "--porcelain").trim()).toBe("?? stray.txt");
  }, SLOW);

  test("cycle end commits memory written during the cycle, and a deletion, and nothing else", () => {
    bot = makeBot();
    mem(bot, "old.md", "old\n");
    git(bot.root, "add", "memory/old.md");
    git(bot.root, "commit", "-q", "-m", "memory");
    writeStream(bot, [item(1)]);
    expect(cli(bot, ["cycle", "begin"], { now: "2026-03-02T15:00:00Z" }).code).toBe(10);
    mem(bot, "new.md", "new\n");
    rmSync(join(bot.root, "memory", "old.md"));
    writeFileSync(join(bot.root, "stray.txt"), "x\n");
    const r = cli(bot, ["cycle", "end", "--records", "1"], { now: "2026-03-02T15:05:00Z" });
    expect(r.code).toBe(0);
    expect(headFiles(bot)).toEqual(["logs/cycle.jsonl", "logs/intake/watermark", "memory/new.md", "memory/old.md"]);
    expect(git(bot.root, "ls-files", "memory").trim()).toBe("memory/new.md");
    expect(git(bot.root, "status", "--porcelain").trim()).toBe("?? stray.txt");
  }, SLOW);

  test("a custom memory.dir is the one committed; memory: false commits no memory", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, memory: { dir: "notes/mem" } } });
    mem(bot, "a.md", "a\n", "notes/mem");
    mem(bot, "a.md", "a\n", "memory");
    cli(bot, ["check"], { now: "2026-03-02T15:00:00Z" });
    expect(headFiles(bot)).toContain("notes/mem/a.md");
    expect(headFiles(bot)).not.toContain("memory/a.md");
    setSettings(bot, { memory: false });
    mem(bot, "b.md", "b\n", "notes/mem");
    cli(bot, ["check"], { now: "2026-03-02T15:10:00Z" });
    expect(headFiles(bot)).not.toContain("notes/mem/b.md");
  }, SLOW);
});

describe("memory status and when a review is due", () => {
  test("counts, sizes, and due after review_days with no review, or after the last review", () => {
    bot = makeBot();
    expect(cli(bot, ["memory", "status"]).out).toContain("not due: no memory files");
    mem(bot, "MEMORY.md", "- [A](a.md) — a\n- [B](b.md) — b\n");
    mem(bot, "a.md", "aaaa\n");
    mem(bot, "b.md", "bb\n");
    const soon = cli(bot, ["memory", "status"], { now: after(1) });
    expect(soon.code).toBe(0);
    expect(soon.out).toContain("2 files · 8 bytes");
    expect(soon.out).toContain("MEMORY.md · 36 bytes · 2 lines");
    expect(soon.out).toContain("last_review: never");
    expect(soon.out).toContain("not due: never reviewed; first review in");
    const late = cli(bot, ["memory", "status"], { now: after(8) });
    expect(late.out).toContain("due: never reviewed, oldest file 8 days old");
    expect(late.out).toContain("memory review --begin");
    expect(cli(bot, [], { now: after(8) }).out).toContain("review due");

    // a review resets the clock; review_days is the setting's
    cli(bot, ["memory", "review", "--begin"], { now: after(8) });
    cli(bot, ["memory", "review", "--done"], { now: after(8) });
    expect(cli(bot, ["memory", "status"], { now: after(10) }).out).toContain("not due: next review in");
    expect(cli(bot, ["memory", "status"], { now: after(15) }).out).toContain("due: last review 7 days ago");
    setSettings(bot, { memory: { review_days: 30 } });
    expect(cli(bot, ["memory", "status"], { now: after(15) }).out).toContain("not due");
  }, SLOW);
});

describe("memory review", () => {
  test("--begin prints the worksheet; --done counts kept, updated, removed and added and logs them", () => {
    bot = makeBot();
    mem(bot, "MEMORY.md", "- index\n");
    mem(bot, "keep.md", "---\nname: keep\ntype: feedback\n---\nstill right\n");
    mem(bot, "update.md", "old wording\n");
    mem(bot, "fold.md", "belongs in a protocol\n");
    mem(bot, "prune.md", "stale\n");
    const b = cli(bot, ["memory", "review", "--begin"]);
    expect(b.code).toBe(0);
    expect(b.out).toContain("begun · 4 files");
    expect(b.out).toContain("files[4]{name,type,bytes,age,changed_since_review}");
    expect(b.out).toMatch(/keep\.md,feedback,\d+,/);
    expect(b.out).toContain("memory-review.md");
    expect(b.out).toContain("**fold**");
    mem(bot, "update.md", "new wording\n");
    rmSync(join(bot.root, "memory", "fold.md"));
    rmSync(join(bot.root, "memory", "prune.md"));
    mem(bot, "added.md", "split out of update.md\n");
    mem(bot, "MEMORY.md", "- index, rewritten\n");
    const d = cli(bot, ["memory", "review", "--done", "--note", "folded fold.md into protocols/x.md; pruned prune.md"], { now: "2026-03-02T15:00:00Z" });
    expect(d.code).toBe(0);
    expect(d.out).toContain("kept 1 · updated 1 · removed 2 (folded or pruned) · added 1");
    const last = readLines(join(bot.root, "logs", "cycle.jsonl")).pop()!;
    expect(last).toEqual({ at: "2026-03-02T15:00:00Z", outcome: "memory-review", files: 4, kept: 1, updated: 1, removed: 2, added: 1, note: "folded fold.md into protocols/x.md; pruned prune.md" });
    // the snapshot is gone: a second --done has nothing to compare with
    expect(cli(bot, ["memory", "review", "--done"]).code).toBe(1);
    expect(cli(bot, ["memory", "review"]).code).toBe(2);
    // the review line and the folder are committed by the next check
    cli(bot, ["check"], { now: "2026-03-02T15:10:00Z" });
    expect(headFiles(bot)).toContain("memory/added.md");
    expect(git(bot.root, "show", "HEAD:logs/cycle.jsonl")).toContain('"outcome":"memory-review"');
    expect(cli(bot, ["log", "tail"]).out).toContain("kept 1 · updated 1 · removed 2 · added 1");
  }, SLOW);

  test("the counting and frontmatter helpers", () => {
    const f = (name: string, sha: string) => ({ name, sha, bytes: 1, type: null, changed: 0 });
    expect(reviewCounts({ at: "", dir: "memory", files: { a: "1", b: "2", c: "3" } }, [f("a", "1"), f("b", "9"), f("d", "4")])).toEqual({ files: 3, kept: 1, updated: 1, removed: 1, added: 1 });
    expect(frontmatterType("---\nname: x\ntype: \"project\"\n---\nbody")).toBe("project");
    expect(frontmatterType("no frontmatter\ntype: x")).toBeNull();
  });
});

describe("a due review surfaces once, and never blocks", () => {
  test("cycle end prints one memory line when due and none otherwise", () => {
    bot = makeBot();
    mem(bot, "a.md", "a\n");
    writeStream(bot, [item(1)]);
    let now = after(1);
    expect(cli(bot, ["cycle", "begin"], { now }).code).toBe(10);
    const quiet = cli(bot, ["cycle", "end", "--records", "1"], { now });
    expect(quiet.code).toBe(0);
    expect(quiet.out).not.toContain("memory review due");
    writeStream(bot, [item(2)]);
    now = after(9);
    expect(cli(bot, ["cycle", "begin"], { now }).code).toBe(10);
    const due = cli(bot, ["cycle", "end", "--records", "1"], { now });
    expect(due.code).toBe(0);
    expect(due.out.match(/memory review due/g)?.length).toBe(1);
    expect(due.out).toContain("memory review --begin");
  }, SLOW);

  test("the cold-start pack carries one line when due, none otherwise; the memory section rides only while memory is on", () => {
    bot = makeBot();
    mem(bot, "a.md", "a\n");
    const notDue = cli(bot, ["cold-start"], { now: after(1) }).out;
    expect(notDue).not.toContain("memory review due");
    expect(notDue).toContain("Memory files (the kit's; updates with the skill)");
    expect(notDue).toContain("your memory files included");
    const due = cli(bot, ["cold-start"], { now: after(9) }).out;
    expect(due.match(/memory review due/g)?.length).toBe(1);
    setSettings(bot, { memory: false });
    const off = cli(bot, ["cold-start"], { now: after(9) }).out;
    expect(off).not.toContain("Memory files (the kit's");
    expect(off).not.toContain("memory review due");
  }, SLOW);
});

describe("memory import", () => {
  test("copies, merges the index without duplicates, never overwrites, and dry-run writes nothing", () => {
    bot = makeBot();
    const src = join(bot.home, "old-memory");
    mkdirSync(src);
    writeFileSync(join(src, "MEMORY.md"), "# Memory Index\n\n- [A](a.md) — fact a\n- [B](b.md) — fact b\n- [C](c.md) — fact c\n");
    writeFileSync(join(src, "a.md"), "a\n");
    writeFileSync(join(src, "b.md"), "b from the old place\n");
    writeFileSync(join(src, "c.md"), "c\n");
    mkdirSync(join(src, "nested"));
    mem(bot, "MEMORY.md", "# Memory Index\n- [C](c.md) — c, said differently\n- [B](b.md) — b here\n");
    mem(bot, "b.md", "b in the repo\n");
    mem(bot, "c.md", "c\n");
    const before = readFileSync(join(bot.root, "memory", "MEMORY.md"), "utf8");

    const dry = cli(bot, ["memory", "import", src, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would copy 1 · already there 1 · clashes 1 · index lines to add 1 · dry run: nothing written");
    expect(existsSync(join(bot.root, "memory", "a.md"))).toBe(false);
    expect(readFileSync(join(bot.root, "memory", "MEMORY.md"), "utf8")).toBe(before);

    const r = cli(bot, ["memory", "import", src]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("copied 1 · already there 1 · clashes 1 · index lines added 1");
    expect(r.out).toContain("b.md: a different file of that name is already there");
    expect(r.out).toContain("nested: not a plain file");
    expect(readFileSync(join(bot.root, "memory", "a.md"), "utf8")).toBe("a\n");
    expect(readFileSync(join(bot.root, "memory", "b.md"), "utf8")).toBe("b in the repo\n");
    expect(readFileSync(join(bot.root, "memory", "MEMORY.md"), "utf8")).toBe(`${before}- [A](a.md) — fact a\n`);
    // the source is left as it was
    expect(readFileSync(join(src, "b.md"), "utf8")).toBe("b from the old place\n");
    // a second import changes nothing
    expect(cli(bot, ["memory", "import", src]).out).toContain("copied 0 · already there 2 · clashes 1 · index lines added 0");
  }, SLOW);

  test("into an empty repo the index comes over whole; a missing source is refused", () => {
    bot = makeBot();
    const src = join(bot.home, "old");
    mkdirSync(src);
    writeFileSync(join(src, "MEMORY.md"), "- [A](a.md) — a\n");
    writeFileSync(join(src, "a.md"), "a\n");
    expect(cli(bot, ["memory", "import", src]).code).toBe(0);
    expect(readFileSync(join(bot.root, "memory", "MEMORY.md"), "utf8")).toBe("- [A](a.md) — a\n");
    expect(cli(bot, ["memory", "import", join(bot.home, "nope")]).code).toBe(1);
    expect(cli(bot, ["memory", "import", join(bot.root, "memory")]).code).toBe(1);
  }, SLOW);
});
