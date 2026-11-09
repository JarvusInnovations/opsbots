import { setExit } from "../../opsbot-core/args.js";
import { existsSync, statSync } from "node:fs";
import { cliInvocation } from "../invocation.js";
import {
  envDAll, RETENTION_DAYS, userClaudeSettings, shell, unitCore, bashrcState, envDFile, envValues, home, loadHost, readText, renderUnits, repoEnv, run, tailnetIp, unitPath,
  vncPasswd, vncPasswordFile, type HostConfig,
} from "../host.js";
import { join } from "node:path";
import { userInfo } from "node:os";

export interface Row { piece: string; state: "ok" | "missing" | "differs"; detail: string; fix: string }

const TOOLS = ["claude", "herdr", "gh-axi", "gws-axi", "slack-axi", "gitsheets-axi", "chrome-devtools-axi"];

export function statusRows(h: HostConfig): Row[] {
  const cli = cliInvocation();
  const rows: Row[] = [];
  const add = (piece: string, ok: boolean | "differs", detail: string, fix: string) =>
    rows.push({ piece, state: ok === true ? "ok" : ok === "differs" ? "differs" : "missing", detail, fix: ok === true ? "" : fix });

  const user = userInfo().username;
  const lg = run("loginctl", ["show-user", user, "-p", "Linger", "--value"]);
  add("linger", lg.out.trim() === "yes", lg.out.trim() || "unknown", `as root: loginctl enable-linger ${user}`);

  let keep: unknown;
  try { keep = JSON.parse(readText(userClaudeSettings()) ?? "{}").cleanupPeriodDays; } catch { keep = "unreadable"; }
  add("session retention", keep === RETENTION_DAYS ? true : keep === undefined ? false : "differs",
    keep === undefined ? "unset: Claude Code prunes session logs after 30 days" : `cleanupPeriodDays ${String(keep)}`, `${cli} sessions keep`);

  const node = shell("node --version");
  const major = Number((node.out.match(/v(\d+)/) ?? [])[1] ?? 0);
  add("node", node.code === 0 && major >= 22 ? true : node.code === 0 ? "differs" : false, node.out.trim() || "not on PATH", "asdf set -u nodejs 22 && asdf install");

  for (const t of TOOLS) {
    const w = shell(`command -v ${t}`);
    add(`tool ${t}`, w.code === 0, w.out.trim() || "not on PATH", t === "claude" ? "curl -fsSL https://claude.ai/install.sh | bash" : t === "herdr" ? "install herdr (see the kit README)" : `npm i -g ${t}`);
  }

  const ip = tailnetIp();
  const want = renderUnits(h, ip ?? "<tailnet-ip>");
  for (const u of ["xvfb", "openbox", "x11vnc"] as const) {
    const have = readText(unitPath(u));
    const same = have !== null && ip !== null && unitCore(have) === unitCore(want[u]);
    const active = run("systemctl", ["--user", "is-active", `${u}.service`]).out.trim();
    add(`unit ${u}`, have === null ? false : same && active === "active" ? true : "differs",
      have === null ? "not installed" : `${same ? "matches" : "differs from the render"} · ${active || "unknown"}`, `${cli} desktop install`);
  }

  const pw = vncPasswordFile(h);
  const pwMode = existsSync(pw) ? (statSync(pw).mode & 0o777) : null;
  add("vnc password", pwMode === 0o600 && existsSync(vncPasswd()) ? true : pwMode === null ? false : "differs",
    pwMode === null ? "none" : `${pw.replace(home(), "~")} mode ${pwMode.toString(8)}`, `${cli} desktop install`);

  const env = envValues(h);
  const mcp = env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  add("browser mcp", !!mcp && existsSync(mcp), mcp ?? "npm root -g failed", `${cli} browser install`);

  const envD = envDAll();
  const bashrc = readText(join(home(), ".bashrc"));
  const repo = repoEnv(h.root);
  for (const [k, v] of Object.entries(env)) {
    const inEnvD = new RegExp(`^${k}=${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(envD);
    add(`env ${k} (environment.d)`, inEnvD, inEnvD ? v : "absent or different", `${cli} browser install`);
    const b = bashrcState(bashrc, k);
    add(`env ${k} (.bashrc)`, b.value === v && b.beforeGuard ? true : b.value === null ? false : "differs",
      b.value === null ? "absent" : `${b.value}${b.beforeGuard ? "" : " (below the interactive guard)"}`, `${cli} browser install`);
    const r = repo ? repo[k] : undefined;
    add(`env ${k} (repo settings)`, r === v ? true : r === undefined ? false : "differs", r ?? "absent",
      `${cli} browser install --dry-run, then commit the printed env block in a PR`);
  }
  return rows;
}

export function statusCommand(): Record<string, unknown> {
  const h = loadHost();
  const rows = statusRows(h);
  const bad = rows.filter((r) => r.state !== "ok");
  setExit(bad.length ? 1 : 0);
  return {
    host: `${h.bot} · display :${h.display} · vnc ${h.vncPort} · bridge ${h.bridgePort}`,
    status: bad.length ? `${bad.length} of ${rows.length} to fix` : `all ${rows.length} ok`,
    rows: rows.map((r) => ({ piece: r.piece, state: r.state, detail: r.detail })),
    ...(bad.length ? { fix: [...new Set(bad.map((r) => r.fix))] } : {}),
  };
}
