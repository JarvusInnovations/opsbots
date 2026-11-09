/**
 * The host model: the bot's effective numbers (opsbot.json `host`, else derived from the uid),
 * the files this CLI owns (rendered, so `status` can compare and `install` can write), and the
 * probes it runs. Pure where it can be, so tests drive it with a fake home and PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { findRoot } from "../opsbot-core/repo.js";

export interface HostConfig {
  bot: string;
  uid: number;
  display: number;
  vncPort: number;
  bridgePort: number;
  resolution: string;
  source: Record<"display" | "vnc_port" | "bridge_port" | "resolution", "opsbot.json" | "derived">;
  root: string | null;
}

export function run(cmd: string, args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout: 120_000 });
  if (r.error) return { code: 127, out: "", err: String(r.error.message) };
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** A probe in the bot's own shell: interactive, so it sees what the operator's `sudo -u <bot> -i`
 * session and an agent's Bash tool see (asdf shims and PATH are usually set in .bashrc). */
export function shell(cmd: string): { code: number; out: string } {
  const r = spawnSync("bash", ["-ic", cmd], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { code: 127, out: "" };
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

/** The lines of a unit that change behavior: comments and Description are presentation. */
export function unitCore(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("Description=")).join("\n");
}

export function home(): string {
  return process.env.HOME || homedir();
}

export function uid(): number {
  const fake = process.env.OPSBOT_HOST_UID;
  if (fake && /^\d+$/.test(fake)) return Number(fake);
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

export function loadHost(): HostConfig {
  const root = findRoot();
  let raw: Record<string, unknown> = {};
  let bot = userInfo().username;
  if (root && existsSync(join(root, "opsbot.json"))) {
    try {
      const j = JSON.parse(readFileSync(join(root, "opsbot.json"), "utf8"));
      if (typeof j.name === "string") bot = j.name;
      if (j.host && typeof j.host === "object") raw = j.host as Record<string, unknown>;
    } catch { /* settings validate reports it */ }
  }
  const u = uid();
  const o = u % 100;
  const int = (k: string, d: number) => (Number.isInteger(raw[k]) ? (raw[k] as number) : d);
  const src = (k: string) => (raw[k] !== undefined ? "opsbot.json" : "derived") as "opsbot.json" | "derived";
  return {
    bot,
    uid: u,
    display: int("display", 100 + o),
    vncPort: int("vnc_port", 5900 + o),
    bridgePort: int("bridge_port", 9300 + o),
    resolution: typeof raw.resolution === "string" ? raw.resolution : "1920x1080x24",
    source: { display: src("display"), vnc_port: src("vnc_port"), bridge_port: src("bridge_port"), resolution: src("resolution") },
    root,
  };
}

export function tailnetIp(): string | null {
  const fake = process.env.OPSBOT_HOST_TAILNET_IP;
  if (fake === "none") return null;
  if (fake) return fake;
  const r = run("tailscale", ["ip", "-4"]);
  const ip = r.code === 0 ? r.out.split("\n")[0]!.trim() : "";
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

const UNIT_DIR = () => join(home(), ".config", "systemd", "user");
export const unitPath = (name: string) => join(UNIT_DIR(), `${name}.service`);
export const vncPasswordFile = (h: HostConfig) => join(home(), ".config", h.bot, "vnc-password");
export const vncPasswd = () => join(home(), ".vnc", "passwd");
export const envDFile = () => join(home(), ".config", "environment.d", "10-opsbot-host.conf");

export function renderUnits(h: HostConfig, ip: string): Record<"xvfb" | "openbox" | "x11vnc", string> {
  const d = `:${h.display}`;
  return {
    xvfb: `# Written by opsbot-host; edit opsbot.json \`host\` and rerun \`desktop install\` instead.
[Unit]
Description=Xvfb virtual display ${d} for ${h.bot} (${h.resolution})

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb ${d} -screen 0 ${h.resolution} -dpi 96 -ac -nolisten tcp
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`,
    openbox: `# Written by opsbot-host; edit opsbot.json \`host\` and rerun \`desktop install\` instead.
[Unit]
Description=Openbox window manager on ${d} for ${h.bot}
Requires=xvfb.service
After=xvfb.service
PartOf=xvfb.service

[Service]
Type=simple
Environment=DISPLAY=${d}
ExecStart=/usr/bin/openbox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`,
    x11vnc: `# Written by opsbot-host; edit opsbot.json \`host\` and rerun \`desktop install\` instead.
[Unit]
Description=x11vnc for display ${d} (${h.bot}; bound to the tailnet address, VNC password)
Requires=xvfb.service
After=xvfb.service
PartOf=xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display ${d} -forever -shared -listen ${ip} -rfbport ${h.vncPort} -rfbportv6 -1 -rfbauth %h/.vnc/passwd
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=default.target
`,
  };
}

export function npmRoot(): string | null {
  const r = shell("npm root -g");
  return r.code === 0 && r.out ? r.out.split("\n").pop()!.trim() : null;
}

export function mcpPath(): string | null {
  const root = npmRoot();
  return root ? join(root, "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js") : null;
}

export function envValues(h: HostConfig): Record<string, string> {
  const out: Record<string, string> = { DISPLAY: `:${h.display}`, CHROME_DEVTOOLS_AXI_PORT: String(h.bridgePort) };
  const m = mcpPath();
  if (m) out.CHROME_DEVTOOLS_AXI_MCP_PATH = m;
  return out;
}

export const BASHRC_BEGIN = "# >>> opsbot-host: browser bridge and virtual desktop (exported before the interactive guard) >>>";
export const BASHRC_END = "# <<< opsbot-host <<<";

export function bashrcBlock(env: Record<string, string>): string {
  return [BASHRC_BEGIN, ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`), BASHRC_END].join("\n");
}

export function envDText(env: Record<string, string>): string {
  return `# Written by opsbot-host for systemd user units.\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}

export function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/** Where `.bashrc` sets each key relative to its interactive guard, if at all. */
export function bashrcState(text: string | null, key: string): { value: string | null; beforeGuard: boolean } {
  if (!text) return { value: null, beforeGuard: false };
  const lines = text.split("\n");
  const guard = lines.findIndex((l) => /^\s*case \$- in|\[\[ \$- != \*i\* \]\]|\[ -z "\$PS1" \]/.test(l));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(new RegExp(`^\\s*export ${key}=(.*)$`));
    if (m) return { value: m[1]!.replace(/^["']|["']$/g, ""), beforeGuard: guard < 0 || i < guard };
  }
  return { value: null, beforeGuard: false };
}

/** The repo's `.claude/settings.json` `env` block, as committed in the working tree. */
export function repoEnv(root: string | null): Record<string, string> | null {
  if (!root) return null;
  const t = readText(join(root, ".claude", "settings.json"));
  if (!t) return null;
  try { const j = JSON.parse(t); return j.env && typeof j.env === "object" ? (j.env as Record<string, string>) : {}; } catch { return null; }
}

/** Session logs are the bot's full-resolution memory; Claude Code prunes them after 30 days
 * unless the user-level settings say otherwise. Kept as long as the operator's own. */
export const RETENTION_DAYS = 36500;
export const userClaudeSettings = () => join(home(), ".claude", "settings.json");

/** Every environment.d file, concatenated in systemd's (lexical) order: any of them may set a key. */
export function envDAll(): string {
  const dir = join(home(), ".config", "environment.d");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".conf")).sort().map((f) => readText(join(dir, f)) ?? "").join("\n");
  } catch { return ""; }
}
