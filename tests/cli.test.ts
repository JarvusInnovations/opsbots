import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE, REPO, SHIM, cli, makeBot, setSettings, type Bot } from "./helpers";
import { validateSettings } from "../src/opsbot-core/settings";

let bot: Bot | null = null;
afterEach(() => {
  bot?.cleanup();
  bot = null;
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function timeNode(args: string[]): number {
  const t = performance.now();
  const r = spawnSync("node", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return performance.now() - t;
}

describe("the bundle", () => {
  test("--version answers through the fast path, near the bare-node floor", () => {
    const out = spawnSync("node", [BUNDLE, "--version"], { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/\S+/);
    for (const f of ["-v", "-V"]) {
      expect(spawnSync("node", [BUNDLE, f], { encoding: "utf8" }).stdout).toBe(out.stdout);
    }
    const floor = median([1, 2, 3, 4, 5].map(() => timeNode(["-e", "1"])));
    const version = median([1, 2, 3, 4, 5].map(() => timeNode([BUNDLE, "--version"])));
    // the whole bundle is parsed either way; the fast path only spares evaluating the graph
    expect(version).toBeLessThan(floor * 2.5 + 60);
  });

  test("the shim and bundle are committed executable", () => {
    const r = spawnSync("git", ["-C", REPO, "ls-files", "-s", "skills/opsbot-core/scripts"], { encoding: "utf8" });
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.startsWith("100755")).toBe(true);
  });

  test("the shim runs the bundle with no install step", () => {
    bot = makeBot();
    const r = spawnSync(SHIM, [], { cwd: bot.root, encoding: "utf8", env: { ...process.env, ...bot.env } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bot: 🧪 testbot");
  });
});

describe("home", () => {
  test("no args prints the home view", () => {
    bot = makeBot();
    const r = cli(bot, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("description:");
    expect(r.out).toContain("bot: 🧪 testbot");
    expect(r.out).toContain("last_cycle: none logged yet");
    expect(r.out).toContain("lock: free");
    expect(r.out).toContain("next_wake:");
    expect(r.out).toMatch(/help\[3\]/);
  });

  test("never errors outside a repo", () => {
    const r = cli(null, [], { cwd: "/" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("not inside a git checkout");
  });

  test("unknown flags are refused by name with exit 2", () => {
    bot = makeBot();
    const r = cli(bot, ["log", "tail", "--count", "3"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unknown flag --count");
    expect(r.out).toContain("--n");
  });
});

describe("settings validate", () => {
  test("accepts the shipped template", () => {
    const tpl = JSON.parse(readFileSync(join(REPO, "skills/opsbot-core/templates/opsbot.json"), "utf8"));
    expect(validateSettings(tpl)).toEqual([]);
  });

  test("rejects an unknown key", () => {
    bot = makeBot();
    setSettings(bot, { colour: "blue" }, false);
    const r = cli(bot, ["settings", "validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown key colour");
  });

  test("rejects a nested unknown key and a missing required key", () => {
    const p = validateSettings({ name: "x", mark: "m", loop: { prompt: "p", extra: 1 }, runtime: {} });
    expect(p).toContain("unknown key loop.extra");
    expect(p).toContain("missing required key runtime.agent");
  });

  test("rejects a cadence value over the cap", () => {
    bot = makeBot();
    setSettings(bot, { cadence: { quiet: 3000, cap: 2700 } }, false);
    const r = cli(bot, ["settings", "validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("cadence.quiet 3000 is over the cap of 2700");
  });

  test("allows // comments at any level", () => {
    expect(validateSettings({ "//": "c", name: "x", mark: "m", loop: { "//": "c", prompt: "p" }, runtime: { agent: "x" } })).toEqual([]);
  });

  test("--head validates the committed file, not the working tree", () => {
    bot = makeBot();
    setSettings(bot, { colour: "blue" }, false);
    expect(cli(bot, ["settings", "validate", "--head"]).code).toBe(0);
  });

  test("refuses an autocompact window set in a second place", () => {
    bot = makeBot();
    const dir = join(bot.root, ".claude");
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoCompactWindow: "750k" }));
    const r = cli(bot, ["settings", "validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("autoCompactWindow");
  });
});

describe("hooks list", () => {
  test("shows every point's scripts in lexical order and skips non-executables and dotfiles", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d", "escalate.d", "monitor.d", "cycle.d"] });
    // an out-of-order name and a non-executable script
    writeFileSync(join(bot.root, "opsbot.d/heartbeat.d/05-early"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bot.root, "opsbot.d/heartbeat.d/05-early"), 0o755);
    writeFileSync(join(bot.root, "opsbot.d/heartbeat.d/15-not-exec"), "#!/bin/sh\nexit 0\n");
    const r = cli(bot, ["hooks", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("heartbeat,1,05-early");
    expect(r.out).toContain("heartbeat,2,10-file-stream");
    expect(r.out).toContain("heartbeat,3,20-quiet-stream");
    expect(r.out).not.toContain(".hidden");
    expect(r.out).toMatch(/skipped\[\d+\]/);
    expect(r.out).toContain("15-not-exec,not executable");
    expect(r.out).toContain("README,not executable");
    expect(r.out).toContain("cycle.end,1,10-due");
    expect(r.out).toContain("monitor,1,10-probe@5m");
  });

  test("--point narrows to one point", () => {
    bot = makeBot({ points: ["heartbeat.d", "wake.d"] });
    const r = cli(bot, ["hooks", "list", "--point", "wake.d"]);
    expect(r.out).toContain("wake,1,10-owed");
    expect(r.out).not.toContain("heartbeat");
  });
});
