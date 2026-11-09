import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs } from "../../opsbot-core/args.js";
import { loadHost, readText, renderUnits, run, tailnetIp, unitPath, vncPasswd, vncPasswordFile } from "../host.js";

export function desktopCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const usage = "desktop install [--dry-run]";
  if (sub !== "install") throw new AxiError(sub ? `unknown desktop subcommand ${sub}` : "desktop needs a subcommand", "VALIDATION_ERROR", [usage]);
  const { flags } = parseArgs(rest, { bool: ["dry-run"] }, usage);
  const dry = flags["dry-run"] === true;
  const h = loadHost();
  const ip = tailnetIp();
  if (!ip) throw new AxiError("no tailnet address found: VNC binds to the tailnet only, never every interface", "CANNOT_RUN", ["Bring tailscale up (tailscale ip -4), or set OPSBOT_HOST_TAILNET_IP"]);
  const units = renderUnits(h, ip);
  const changed: string[] = [];
  const kept: string[] = [];
  const would: Record<string, string> = {};
  for (const [name, text] of Object.entries(units)) {
    const p = unitPath(name);
    if (readText(p) === text) { kept.push(p); continue; }
    if (dry) { would[p] = text; continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    changed.push(p);
  }
  const pwFile = vncPasswordFile(h);
  const commands: string[] = [];
  if (existsSync(pwFile) && existsSync(vncPasswd())) kept.push(pwFile);
  else if (dry) would[pwFile] = "(a generated 14-character password, mode 0600; ~/.vnc/passwd from it with x11vnc -storepasswd)";
  else {
    const pw = existsSync(pwFile) ? (readText(pwFile) ?? "").trim() : randomBytes(12).toString("base64url").slice(0, 14);
    mkdirSync(dirname(pwFile), { recursive: true });
    writeFileSync(pwFile, `${pw}\n`, { mode: 0o600 });
    chmodSync(pwFile, 0o600);
    mkdirSync(dirname(vncPasswd()), { recursive: true });
    const r = run("x11vnc", ["-storepasswd", pw, vncPasswd()]);
    if (r.code !== 0) throw new AxiError(`x11vnc -storepasswd failed: ${(r.err || r.out).split("\n")[0]}`, "CANNOT_RUN", ["Install x11vnc (as root: apt install x11vnc xvfb openbox)"]);
    changed.push(pwFile, vncPasswd());
  }
  commands.push("systemctl --user daemon-reload", "systemctl --user enable --now xvfb.service openbox.service x11vnc.service");
  if (!dry) {
    for (const c of commands) {
      const [cmd, ...a] = c.split(" ");
      const r = run(cmd!, a);
      if (r.code !== 0) throw new AxiError(`${c} failed: ${(r.err || r.out).split("\n")[0]}`, "CANNOT_RUN", ["Check lingering (loginctl show-user $USER -p Linger) and XDG_RUNTIME_DIR"]);
    }
  }
  return dry
    ? { desktop: `would set up :${h.display} with VNC on ${ip}:${h.vncPort}`, would_write: would, would_run: commands, unchanged: kept }
    : { desktop: `:${h.display} up, VNC on ${ip}:${h.vncPort} (password in ${pwFile})`, changed, unchanged: kept, ran: commands };
}
