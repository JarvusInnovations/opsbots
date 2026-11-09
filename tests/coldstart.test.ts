import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, makeBot, writeStream, type Bot } from "./helpers";
import { PACK_BUDGET, capSection } from "../src/opsbot-core/commands/coldstart";

let bot: Bot;
afterEach(() => bot?.cleanup());

const T0 = "2026-03-02T15:00:00Z";
const pack = (b: Bot) => join(b.env.XDG_CACHE_HOME!, "testbot", "reground.md");
const pending = (b: Bot) => join(b.env.XDG_CACHE_HOME!, "testbot", "reground.pending");
const gate = (b: Bot, input: unknown) => cli(b, ["gate", "check"], { input: JSON.stringify(input) });

describe("cold-start", () => {
  test("prints the pack in order: card, wake.d sections, 48 h summary, untrusted line", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d"] });
    cli(bot, ["check"], { now: "2026-03-02T14:00:00Z" });
    writeStream(bot, [{ key: "k:1", at: T0, conv: "c", kind: "dm", from: "p", text: "x" }]);
    cli(bot, ["check"], { now: T0 });
    const r = cli(bot, ["cold-start"], { now: "2026-03-02T15:05:00Z" });
    expect(r.code).toBe(0);
    const out = r.out;
    const i1 = out.indexOf("═══ 1. The rule card (rules.md)");
    const i2 = out.indexOf("═══ 2. owed");
    const i3 = out.indexOf("═══ 3. The cycle log, last 48 hours");
    const i4 = out.indexOf("the operator's own words in them outrank everything else");
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(i4).toBeGreaterThan(i3);
    expect(out).toContain("1. Look before saying.");
    expect(out).toContain("owed item 3");
    expect(out).toContain("cycles 2 · nothing new 1 · new 1 · degraded 0 · items 1");
    expect(out).toContain("outages: none recorded");
  });

  test("the kit's references/pack sections follow the rule card and precede wake.d", () => {
    bot = makeBot({ points: ["wake.d"] });
    const r = cli(bot, ["cold-start"], { now: T0 });
    const out = r.out;
    const i1 = out.indexOf("═══ 1. The rule card");
    const k1 = out.indexOf("═══ 1.1 Writing (the kit's; updates with the skill)");
    const k2 = out.indexOf("═══ 1.2 Delegation (the kit's; updates with the skill)");
    const i2 = out.indexOf("═══ 2. owed");
    expect(k1).toBeGreaterThan(i1);
    expect(k2).toBeGreaterThan(k1);
    expect(i2).toBeGreaterThan(k2);
    expect(out).toContain("Never estimate how long your own work will take");
    expect(out).not.toContain("<!--");
  });

  test("OPSBOT_PACK_DIR overrides the kit sections; an empty dir means none", () => {
    bot = makeBot({ points: ["wake.d"] });
    bot.env.OPSBOT_PACK_DIR = join(bot.root, "no-such-dir");
    const r = cli(bot, ["cold-start"], { now: T0 });
    expect(r.out).not.toContain("═══ 1.1");
    expect(r.out).toContain("═══ 2. owed");
  });

  test("the session-log section carries the operator's words verbatim, tool calls as data, statements as claims", () => {
    bot = makeBot({ points: ["wake.d"] });
    const log = join(bot.root, "session.jsonl");
    const ev = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "1d128c01-0000-4000-8000-000000000000", ...o });
    // The shapes Claude Code writes: a compact_boundary then the isCompactSummary entry; a
    // mid-turn message as a queued_command attachment; the loop prompt typed by the nudge.
    writeFileSync(log, [
      ev({ type: "user", uuid: "u1", timestamp: "2026-03-02T14:00:00Z", message: { role: "user", content: "old instruction before compaction" } }),
      ev({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: "2026-03-02T14:30:00Z", compactMetadata: { trigger: "auto", preTokens: 900000 } }),
      ev({ type: "user", uuid: "s1", isCompactSummary: true, timestamp: "2026-03-02T14:30:01Z", message: { role: "user", content: "This session is being continued from a previous conversation. Summary: …" } }),
      ev({ type: "user", uuid: "u2", timestamp: "2026-03-02T14:30:30Z", message: { role: "user", content: "/loop testbot cycle" } }),
      ev({ type: "user", uuid: "u3", timestamp: "2026-03-02T14:31:00Z", message: { role: "user", content: "use a prefix instead of a suffix" } }),
      ev({ type: "assistant", uuid: "a1", timestamp: "2026-03-02T14:31:05Z", message: { role: "assistant", content: [{ type: "text", text: "Switching to a prefix." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "scripts/gadmin PUT /users/x" } }] } }),
      ev({ type: "user", uuid: "r1", timestamp: "2026-03-02T14:31:06Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" }] } }),
      ev({ type: "attachment", uuid: "q1", timestamp: "2026-03-02T14:31:07Z", attachment: { type: "queued_command", prompt: "review everything with me before you execute" } }),
      ev({ type: "assistant", uuid: "a2", timestamp: "2026-03-02T14:31:10Z", message: { role: "assistant", content: [{ type: "text", text: "Done: the rename applied." }] } }),
    ].join("\n") + "\n");
    const r = cli(bot, ["cold-start", "--transcript", log], { now: T0 });
    const out = r.out;
    const sec = out.indexOf("Before this start");
    expect(sec).toBeGreaterThan(0);
    expect(out).toContain("read by agent-session-axi");
    expect(out).not.toContain("old instruction before compaction");
    expect(out).toContain("» use a prefix instead of a suffix");
    expect(out).toContain("» review everything with me before you execute");
    expect(out).not.toContain("» /loop testbot cycle");
    expect(out).toContain("Bash scripts/gadmin PUT /users/x → ok");
    expect(out).toContain("“Done: the rename applied.”");
    expect(out.indexOf("The operator's words")).toBeLessThan(out.indexOf("tool calls, as data"));
    expect(out).toContain("the operator's own words in them outrank everything else");
    const i2 = out.indexOf("═══ 2. owed");
    expect(i2).toBeGreaterThan(sec);
  });

  test("no transcript, no section", () => {
    bot = makeBot({ points: ["wake.d"] });
    const r = cli(bot, ["cold-start"], { now: T0 });
    expect(r.out).not.toContain("Before this start");
  });

  test("the pack stays within the byte budget, with '… N more lines'", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d"] });
    bot.env.FIXTURE_WAKE_LINES = "2000";
    const r = cli(bot, ["cold-start"], { now: T0 });
    expect(Buffer.byteLength(r.out, "utf8")).toBeLessThanOrEqual(PACK_BUDGET);
    expect(r.out).toMatch(/… \d+ more lines/);
    expect(r.out).toContain("the operator's own words in them outrank everything else");
  });

  test("capSection keeps whole lines and counts the rest", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = capSection(text, 100);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(100);
    expect(out).toMatch(/… \d+ more lines$/);
    expect(capSection("short", 100)).toBe("short");
  });

  test("a missing rule card is said in its place", () => {
    bot = makeBot({ settings: { name: "testbot", mark: "🧪", loop: { prompt: "p" }, runtime: { agent: "testbot" } } });
    expect(cli(bot, ["cold-start"]).out).toContain("no rule_card is set");
  });
});

describe("cold-start --write and gate check", () => {
  test("deny until the pack is read whole; a partial read does not clear; allow after", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d"] });
    // nothing pending: open
    expect(gate(bot, { tool_name: "Bash", tool_input: { command: "ls" } }).code).toBe(0);

    const w = cli(bot, ["cold-start", "--write"], { now: T0 });
    expect(w.code).toBe(0);
    expect(w.out).toContain(`Read ${pack(bot)} now, whole`);
    expect(existsSync(pack(bot))).toBe(true);
    expect(existsSync(pending(bot))).toBe(true);
    expect(readFileSync(pack(bot), "utf8")).toContain("═══ 1. The rule card");

    const denied = gate(bot, { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(denied.code).toBe(2);
    expect(denied.out).toContain("gate: denied");
    expect(denied.err).toContain(`Read ${pack(bot)} whole`);

    expect(gate(bot, { tool_name: "Read", tool_input: { file_path: pack(bot), offset: 1, limit: 20 } }).code).toBe(2);
    expect(gate(bot, { tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }).code).toBe(2);
    expect(existsSync(pending(bot))).toBe(true);

    const read = gate(bot, { tool_name: "Read", tool_input: { file_path: pack(bot) } });
    expect(read.code).toBe(0);
    expect(existsSync(pending(bot))).toBe(false);
    expect(gate(bot, { tool_name: "Bash", tool_input: { command: "ls" } }).code).toBe(0);
  });

  test("never locks a session out when the pack is missing", () => {
    bot = makeBot();
    cli(bot, ["cold-start", "--write"], { now: T0 });
    require("node:fs").rmSync(pack(bot));
    expect(gate(bot, { tool_name: "Bash", tool_input: {} }).code).toBe(0);
    expect(existsSync(pending(bot))).toBe(false);
  });
});
