import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, makeBot, makeExecutable, setSettings, type Bot } from "./helpers";

let bot: Bot;
afterEach(() => bot?.cleanup());

function fakeSystemctl(b: Bot): string {
  const log = join(b.home, "systemctl.log");
  const bin = join(b.home, "systemctl");
  makeExecutable(bin, `#!/usr/bin/env bash\necho "$*" >>"${log}"\n[ "$2" = is-active ] && echo active\nexit 0\n`);
  b.env.OPSBOT_SYSTEMCTL = bin;
  return log;
}
const unitDir = (b: Bot) => join(b.env.XDG_CONFIG_HOME!, "systemd", "user");

describe("infra", () => {
  test("install renders units whose intervals come from opsbot.json, and status shows them", () => {
    bot = makeBot({ points: ["heartbeat.d", "monitor.d"] });
    setSettings(bot, { liveness: { interval_minutes: 12 } });
    const calls = fakeSystemctl(bot);

    const dry = cli(bot, ["infra", "install", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("OnCalendar=*:00/12");
    expect(dry.out).toContain("OnCalendar=*:06/12");
    expect(existsSync(unitDir(bot))).toBe(false);

    const r = cli(bot, ["infra", "install"]);
    expect(r.code).toBe(0);
    const files = readdirSync(unitDir(bot)).sort();
    expect(files).toEqual([
      "opsbot-testbot-monitor-20-listener.service",
      "opsbot-testbot-nudge.service",
      "opsbot-testbot-nudge.timer",
      "opsbot-testbot-probe-10-probe.service",
      "opsbot-testbot-probe-10-probe.timer",
      "opsbot-testbot-watchdog.service",
      "opsbot-testbot-watchdog.timer",
    ]);
    const wd = readFileSync(join(unitDir(bot), "opsbot-testbot-watchdog.timer"), "utf8");
    expect(wd).toContain("OnCalendar=*:00/12");
    const svc = readFileSync(join(unitDir(bot), "opsbot-testbot-watchdog.service"), "utf8");
    expect(svc).toContain(`WorkingDirectory=${bot.root}`);
    expect(svc).toMatch(/ExecStart=\S+opsbot-core watchdog/);
    expect(readFileSync(join(unitDir(bot), "opsbot-testbot-probe-10-probe.timer"), "utf8")).toContain("OnUnitActiveSec=5m");
    expect(readFileSync(join(unitDir(bot), "opsbot-testbot-monitor-20-listener.service"), "utf8")).toContain("Environment=OPSBOT_CORE=");
    expect(readFileSync(calls, "utf8")).toContain("--user enable --now opsbot-testbot-watchdog.timer opsbot-testbot-nudge.timer");

    const st = cli(bot, ["infra", "status"]);
    expect(st.out).toContain("all 7 units current");

    // the value changes in opsbot.json: status names the stale units
    setSettings(bot, { liveness: { interval_minutes: 15 } });
    const stale = cli(bot, ["infra", "status"]);
    expect(stale.out).toContain("need `infra install`");
    expect(stale.out).toContain("opsbot-testbot-watchdog.timer,stale");

    const un = cli(bot, ["infra", "uninstall"]);
    expect(un.code).toBe(0);
    expect(readdirSync(unitDir(bot))).toHaveLength(0);
  });

  test("a monitor whose interval cannot be read is refused by name", () => {
    bot = makeBot({ points: ["heartbeat.d"] });
    mkdirSync(join(bot.root, "opsbot.d", "monitor.d"), { recursive: true });
    makeExecutable(join(bot.root, "opsbot.d", "monitor.d", "probe@often"), "#!/bin/sh\n");
    fakeSystemctl(bot);
    const r = cli(bot, ["infra", "install"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("probe@often");
  });
});

describe("hook (project scope)", () => {
  test("install registers SessionStart and PreToolUse, idempotently, and uninstall keeps other hooks", () => {
    bot = makeBot();
    const p = join(bot.root, ".claude", "settings.json");
    mkdirSync(join(bot.root, ".claude"));
    const other = { type: "command", command: "other-tool home" };
    writeFileSync(p, JSON.stringify({ hooks: { SessionStart: [{ hooks: [other] }] } }));

    const r = cli(bot, ["hook", "install"]);
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(p, "utf8"));
    const starts = s.hooks.SessionStart.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(starts).toContain("other-tool home");
    expect(starts.some((c: string) => /opsbot-core"? cold-start --write$/.test(c))).toBe(true);
    const pre = s.hooks.PreToolUse[0];
    expect(pre.matcher).toBe("*");
    expect(pre.hooks[0].command).toMatch(/opsbot-core" gate check$/);

    expect(cli(bot, ["hook", "install"]).out).toContain("no-op");
    expect(cli(bot, ["hook", "status"]).out).toContain("SessionStart,installed");

    expect(cli(bot, ["hook", "uninstall"]).code).toBe(0);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(JSON.stringify(after)).not.toContain("opsbot-core");
    expect(JSON.stringify(after)).toContain("other-tool home");
  });

  test("a skill vendored in the repo gets a ${CLAUDE_PROJECT_DIR}-relative command", async () => {
    const { hookBase } = await import("../src/opsbot-core/commands/hook");
    const { REPO } = await import("./helpers");
    expect(hookBase("project", REPO)).toBe('"${CLAUDE_PROJECT_DIR}/skills/opsbot-core/scripts/opsbot-core"');
  });
});
