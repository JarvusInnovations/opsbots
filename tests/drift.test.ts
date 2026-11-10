import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SETTINGS, cli, makeBot, type Bot } from "./helpers";
import { modelMatches, sessionDrift } from "../src/opsbot-core/drift";
import { withDefaults } from "../src/opsbot-core/settings";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const base = { name: "x", mark: "x", runtime: { adapter: "herdr", agent: "x" } };
const strat = withDefaults({ ...base, loop: { prompt: "p" } });
const disp = withDefaults({ ...base, loop: { prompt: "p", mode: "dispatcher" } });

describe("session drift", () => {
  test("nothing outside a session; nothing when the window and the model match the mode", () => {
    expect(sessionDrift(strat, {}, "claude-opus-5-5")).toEqual([]);
    expect(sessionDrift(strat, { CLAUDECODE: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "750000" }, "claude-fable-5-2")).toEqual([]);
    expect(sessionDrift(disp, { CLAUDECODE: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300k" }, "claude-opus-5-5")).toEqual([]);
    expect(sessionDrift(disp, { CLAUDECODE: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }, null)).toEqual([]);
  });

  test("a missing or different window and a model of another class are each named", () => {
    const none = sessionDrift(strat, { CLAUDECODE: "1" }, "claude-fable-5-2");
    expect(none).toHaveLength(1);
    expect(none[0]).toContain("none set");
    expect(none[0]).toContain("750000");
    const both = sessionDrift(disp, { CLAUDECODE: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "750000" }, "claude-fable-5-1");
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("300000");
    expect(both[1]).toContain("opus");
  });

  test("model classes: an alias matches its ids and its [1m] form", () => {
    expect(modelMatches("opus", "claude-opus-5-5")).toBe(true);
    expect(modelMatches("opus[1m]", "claude-opus-5-5")).toBe(true);
    expect(modelMatches("claude-fable-5-2", "claude-fable-5-2")).toBe(true);
    expect(modelMatches("fable", "claude-opus-5-5")).toBe(false);
  });

  test("cycle begin says it once per session, with the start line, then stays quiet", () => {
    bot = makeBot({ settings: { ...BASE_SETTINGS, loop: { prompt: "/loop go" } } });
    const log = join(bot.root, "session.jsonl");
    writeFileSync(log, JSON.stringify({ type: "assistant", timestamp: T0, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } }) + "\n");
    writeFileSync(join(bot.root, ".git", "opsbot-session"), JSON.stringify({ transcript_path: log, session_id: "s1", at: T0 }) + "\n");
    const env = { CLAUDECODE: "1" };
    const a = cli(bot, ["cycle", "begin"], { now: T0, env });
    expect(a.out).toContain("compaction window");
    expect(a.out).toContain("the strategist loop calls for fable");
    expect(a.out).toContain("start --continue");
    const b = cli(bot, ["cycle", "begin"], { now: "2026-03-02T15:10:00Z", env });
    expect(b.out).not.toContain("compaction window");
    const ok = cli(bot, ["cycle", "begin"], { now: "2026-03-02T15:20:00Z" });
    expect(ok.out).not.toContain("session");
  });
});
