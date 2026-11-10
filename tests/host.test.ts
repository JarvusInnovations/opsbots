import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bashrcState, renderUnits, unitCore, type HostConfig } from "../src/opsbot-host/host";
import { withRetention } from "../src/opsbot-host/commands/sessions";
import { withBashrcBlock } from "../src/opsbot-host/commands/browser";
import { bashrcBlock } from "../src/opsbot-host/host";

const ENTRY = resolve(import.meta.dir, "..", "src", "opsbot-host", "bin.ts");
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function bot(settings: Record<string, unknown> = { name: "testbot" }) {
  const h = mkdtempSync(join(tmpdir(), "opsbot-host-test-"));
  dirs.push(h);
  const root = join(h, "repo");
  mkdirSync(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "opsbot.json"), JSON.stringify(settings));
  return { home: h, root };
}

function host(b: { home: string; root: string }, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: b.root, encoding: "utf8",
    env: { ...process.env, HOME: b.home, OPSBOT_HOST_UID: "30034", OPSBOT_HOST_TAILNET_IP: "100.64.0.9", ...env },
  });
  return { code: r.status ?? -1, out: r.stdout };
}

const H: HostConfig = { bot: "testbot", uid: 30034, display: 134, vncPort: 5934, bridgePort: 9334, resolution: "1920x1080x24",
  source: { display: "derived", vnc_port: "derived", bridge_port: "derived", resolution: "derived" }, root: null };

describe("rendering", () => {
  test("units carry the display, the tailnet bind and the port; never every interface", () => {
    const u = renderUnits(H, "100.64.0.9");
    expect(u.xvfb).toContain("ExecStart=/usr/bin/Xvfb :134 -screen 0 1920x1080x24");
    expect(u.openbox).toContain("Environment=DISPLAY=:134");
    expect(u.x11vnc).toContain("-listen 100.64.0.9 -rfbport 5934");
    expect(u.x11vnc).not.toContain("0.0.0.0");
  });

  test("unit comparison ignores comments and Description, not behavior", () => {
    const u = renderUnits(H, "100.64.0.9").xvfb;
    expect(unitCore(u.replace("for testbot", "for TestBot"))).toBe(unitCore(u));
    expect(unitCore(u.replaceAll(":134", ":135"))).not.toBe(unitCore(u));
  });

  test("the .bashrc block goes above the interactive guard, and rewriting it is idempotent", () => {
    const rc = "# ~/.bashrc\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nexport CHROME_DEVTOOLS_AXI_PORT=9999\n";
    expect(bashrcState(rc, "CHROME_DEVTOOLS_AXI_PORT")).toEqual({ value: "9999", beforeGuard: false });
    const block = bashrcBlock({ DISPLAY: ":134", CHROME_DEVTOOLS_AXI_PORT: "9334" });
    const once = withBashrcBlock(rc, block);
    expect(withBashrcBlock(once, block)).toBe(once);
    expect(bashrcState(once, "CHROME_DEVTOOLS_AXI_PORT")).toEqual({ value: "9334", beforeGuard: true });
  });

  test("retention is merged into the user settings with every other key kept; bad JSON is refused", () => {
    const { next, current } = withRetention(JSON.stringify({ model: "fable", permissions: { defaultMode: "auto" } }));
    expect(current).toBeUndefined();
    expect(JSON.parse(next)).toEqual({ model: "fable", permissions: { defaultMode: "auto" }, cleanupPeriodDays: 36500 });
    expect(() => withRetention("{ not json")).toThrow();
  });
});

describe("the CLI", () => {
  test("numbers derive from the uid, and opsbot.json `host` pins them", () => {
    const b = bot();
    expect(host(b, ["desktop", "install", "--dry-run"]).out).toContain("would set up :134 with VNC on 100.64.0.9:5934");
    const p = bot({ name: "testbot", host: { display: 101, vnc_port: 5902, bridge_port: 9226 } });
    expect(host(p, ["desktop", "install", "--dry-run"]).out).toContain("would set up :101 with VNC on 100.64.0.9:5902");
  });

  test("desktop install --dry-run prints every file and command and writes nothing", () => {
    const b = bot();
    const r = host(b, ["desktop", "install", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("xvfb.service");
    expect(r.out).toContain("x11vnc.service");
    expect(r.out).toContain("vnc-password");
    expect(r.out).toContain("systemctl --user enable --now xvfb.service openbox.service x11vnc.service");
    expect(existsSync(join(b.home, ".config", "systemd"))).toBe(false);
  });

  test("desktop install refuses without a tailnet address", () => {
    const r = host(bot(), ["desktop", "install", "--dry-run"], { OPSBOT_HOST_TAILNET_IP: "none" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("VNC binds to the tailnet only");
  });

  test("sessions keep sets retention once, then reports it kept", () => {
    const b = bot();
    mkdirSync(join(b.home, ".claude"));
    writeFileSync(join(b.home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    expect(host(b, ["sessions", "keep", "--dry-run"]).out).toContain("would set cleanupPeriodDays");
    expect(JSON.parse(readFileSync(join(b.home, ".claude", "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    expect(host(b, ["sessions", "keep"]).out).toContain("session logs are no longer pruned");
    expect(JSON.parse(readFileSync(join(b.home, ".claude", "settings.json"), "utf8"))).toEqual({ theme: "dark", cleanupPeriodDays: 36500 });
    expect(host(b, ["sessions", "keep"]).out).toContain("already 36500");
  });

  test("an unknown flag fails loud", () => {
    const r = host(bot(), ["desktop", "install", "--dryrun"]);
    expect(r.code).toBe(2);
  });
});

describe("bootstrap", () => {
  const SCRIPT = resolve(import.meta.dir, "..", "skills", "opsbot-host", "scripts", "bootstrap.sh");
  const fresh = (args: string[], cwd?: string) => {
    const h = mkdtempSync(join(tmpdir(), "opsbot-host-fresh-"));
    dirs.push(h);
    const r = spawnSync("bash", [SCRIPT, ...args], { cwd: cwd ?? h, encoding: "utf8", env: { HOME: h, PATH: "/usr/bin:/bin" } });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr, home: h };
  };

  test("--dry-run on an empty home lists every piece with its commands and writes nothing", () => {
    const r = fresh(["--dry-run"]);
    expect(r.code).toBe(0);
    for (const piece of ["PATH", "asdf", "node", "gh-axi", "agent-recall-axi", "claude", "herdr"]) expect(r.out).toMatch(new RegExp(`^would  ${piece} `, "m"));
    expect(r.out).toContain("nothing changed");
    expect(existsSync(join(r.home, ".bashrc"))).toBe(false);
    // a probed tool may write its own state under the home (gh does on some hosts); the script's own targets stay absent
    expect(existsSync(join(r.home, ".local", "bin"))).toBe(false);
    expect(existsSync(join(r.home, ".asdf"))).toBe(false);
  });

  test("--tools replaces the default set, none drops it, --no-herdr skips herdr, --node pins the version", () => {
    const r = fresh(["--dry-run", "--tools", "gh-axi,npm-axi", "--no-herdr", "--node", "22.1.0"]);
    expect(r.out).toMatch(/^would  npm-axi /m);
    expect(r.out).not.toContain("slack-axi");
    expect(r.out).not.toMatch(/^would  herdr /m);
    expect(r.out).toContain("v=22.1.0");
    expect(fresh(["--dry-run", "--tools", "none"]).out).not.toContain("npm install -g");
  });

  test("the repo's pinned node is used, and missing skills from skills-lock.json are named", () => {
    const b = bot();
    writeFileSync(join(b.root, ".tool-versions"), "nodejs 22.9.0\n");
    writeFileSync(join(b.root, "skills-lock.json"), JSON.stringify({ version: 1, skills: { "opsbot-core": { source: "x" } } }, null, 2));
    const r = fresh(["--dry-run"], b.root);
    expect(r.out).toContain("v=22.9.0");
    expect(r.out).toMatch(/^would  skills .*opsbot-core/m);
  });

  test("an unknown flag and a tool name that is not a package name are refused before anything runs", () => {
    expect(fresh(["--dry-runn"]).code).toBe(2);
    const bad = fresh(["--dry-run", "--tools", "gh-axi; rm -rf ~"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not one");
  });

  test("an existing .bashrc keeps its content under the PATH block, and the block is written once", () => {
    const h = mkdtempSync(join(tmpdir(), "opsbot-host-rc-"));
    dirs.push(h);
    writeFileSync(join(h, ".bashrc"), "case $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll='ls -l'\n");
    // a stand-in PATH where every later piece already exists, so only the PATH step acts
    const bin = join(h, "bin");
    mkdirSync(join(h, ".local", "bin"), { recursive: true });
    mkdirSync(bin);
    for (const t of ["asdf", "node", "gh", "claude", "herdr"]) writeFileSync(join(h, ".local", "bin", t), "#!/bin/sh\necho v99.0.0\n", { mode: 0o755 });
    const run = () => spawnSync("bash", [SCRIPT, "--tools", "none"], { cwd: h, encoding: "utf8", env: { HOME: h, PATH: "/usr/bin:/bin" } });
    const a = run();
    expect(a.status).toBe(0);
    const rc = readFileSync(join(h, ".bashrc"), "utf8");
    expect(rc.startsWith("# >>> opsbot-host: tools on PATH")).toBe(true);
    expect(rc).toContain("alias ll='ls -l'");
    expect(rc.indexOf("export PATH=")).toBeLessThan(rc.indexOf("case $- in"));
    const b2 = run();
    expect(b2.stdout).toContain("installed 0");
    expect(readFileSync(join(h, ".bashrc"), "utf8")).toBe(rc);
  });

  test("the CLI's bootstrap command is the same script", () => {
    const b = bot();
    const r = host(b, ["bootstrap", "--dry-run", "--tools", "none", "--no-herdr"], { PATH: `/usr/bin:/bin:${process.env.PATH}` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing changed");
  });
});

