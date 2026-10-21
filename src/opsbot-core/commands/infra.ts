/**
 * infra install | uninstall | status — the liveness units, as systemd user
 * units rendered from the skill's templates with this repo's paths and
 * opsbot.json's values (read at HEAD):
 *
 *   opsbot-<name>-watchdog.{service,timer}   every liveness.interval_minutes
 *   opsbot-<name>-nudge.{service,timer}      the same interval, half an interval later
 *   opsbot-<name>-monitor-<m>.service        per opsbot.d/monitor.d/<m> (always on)
 *   opsbot-<name>-probe-<m>.{service,timer}  per opsbot.d/monitor.d/<m>@<interval>
 *
 * Units go to $XDG_CONFIG_HOME/systemd/user (~/.config/systemd/user).
 * `status` re-renders and compares, so a unit that no longer matches
 * opsbot.json is reported stale (one value, one place). OPSBOT_SYSTEMCTL
 * replaces `systemctl` in tests.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit, usageError } from "../args.js";
import { absoluteInvocation, cliInvocation, skillDir } from "../invocation.js";
import { discover } from "../lifecycle.js";
import { firstLine, requireRoot, run } from "../repo.js";
import { loadSettings, type Settings } from "../settings.js";

export const INFRA_USAGE = "infra install|uninstall|status [--dry-run]";

export interface Unit {
  file: string;
  content: string;
  /** enabled and started by install */
  enable: boolean;
}

export function unitDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user");
}

export function templatesDir(): string {
  const env = process.env.OPSBOT_TEMPLATES;
  if (env) return env;
  return join(skillDir(), "templates");
}

function template(name: string): string {
  const p = join(templatesDir(), name);
  if (!existsSync(p)) {
    throw new AxiError(`the unit template ${name} is missing from ${templatesDir()}`, "CANNOT_RUN", [
      "Reinstall the skill: npx skills add JarvusInnovations/opsbots --skill opsbot-core",
    ]);
  }
  return readFileSync(p, "utf8");
}

function fill(t: string, vars: Record<string, string>): string {
  return t.replace(/@([A-Z_]+)@/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

const SPAN_RE = /^(\d+)(s|sec|m|min|h|hr)$/;

export function prefix(s: Settings): string {
  return `opsbot-${s.name}-`;
}

/** Every unit `install` would write now, from the settings and opsbot.d/monitor.d/. */
export function renderUnits(root: string, s: Settings): { units: Unit[]; problems: string[] } {
  const core = absoluteInvocation();
  const interval = s.liveness.interval_minutes;
  const base = {
    NAME: s.name,
    ROOT: root,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    CORE: core,
    INTERVAL: String(interval).padStart(2, "0"),
    OFFSET: String(Math.floor(interval / 2)).padStart(2, "0"),
  };
  const pre = prefix(s);
  const units: Unit[] = [
    { file: `${pre}watchdog.service`, content: fill(template("opsbot-watchdog.service"), base), enable: false },
    { file: `${pre}watchdog.timer`, content: fill(template("opsbot-watchdog.timer"), base), enable: true },
    { file: `${pre}nudge.service`, content: fill(template("opsbot-nudge.service"), base), enable: false },
    { file: `${pre}nudge.timer`, content: fill(template("opsbot-nudge.timer"), base), enable: true },
  ];
  const problems: string[] = [];
  for (const sc of discover(root, "monitor").scripts) {
    const at = sc.name.lastIndexOf("@");
    const monitor = (at > 0 ? sc.name.slice(0, at) : sc.name).replace(/[^A-Za-z0-9_.-]/g, "-");
    const vars = { ...base, SCRIPT: sc.path, SCRIPT_NAME: sc.name, MONITOR: monitor };
    if (at > 0) {
      const span = sc.name.slice(at + 1);
      if (!SPAN_RE.test(span)) {
        problems.push(`monitor.d/${sc.name}: the interval after @ must look like 30s, 5m or 1h`);
        continue;
      }
      units.push(
        { file: `${pre}probe-${monitor}.service`, content: fill(template("opsbot-probe.service"), { ...vars, SPAN: span }), enable: false },
        { file: `${pre}probe-${monitor}.timer`, content: fill(template("opsbot-probe.timer"), { ...vars, SPAN: span }), enable: true },
      );
    } else {
      units.push({ file: `${pre}monitor-${monitor}.service`, content: fill(template("opsbot-monitor.service"), vars), enable: true });
    }
  }
  return { units, problems };
}

/** Units compared without their PATH line, which follows whichever shell ran install. */
export function samePathless(a: string, b: string): boolean {
  const strip = (t: string) => t.replace(/^Environment=PATH=.*$/m, "");
  return strip(a) === strip(b);
}

function systemctl(args: string[]): { ok: boolean; out: string } {
  const bin = process.env.OPSBOT_SYSTEMCTL || "systemctl";
  const r = run(bin, ["--user", ...args], { timeoutMs: 60_000 });
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
}

function installed(s: Settings): string[] {
  const dir = unitDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix(s)))
    .sort();
}

export function infraCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    throw usageError(sub ? `unknown infra subcommand ${sub}` : "infra needs a subcommand", INFRA_USAGE);
  }
  const { flags } = parseArgs(rest, { bool: sub === "status" ? [] : ["dry-run"] }, INFRA_USAGE);
  const dry = flags["dry-run"] === true;
  const root = requireRoot();
  const { settings } = loadSettings(root);
  const dir = unitDir();

  if (sub === "status") {
    const { units, problems } = renderUnits(root, settings);
    const want = new Set(units.map((u) => u.file));
    const rows = units.map((u) => {
      const p = join(dir, u.file);
      const state = !existsSync(p) ? "missing" : samePathless(readFileSync(p, "utf8"), u.content) ? "current" : "stale";
      let active = "-";
      if (u.enable && state !== "missing") {
        const r = systemctl(["is-active", u.file]);
        active = firstLine(r.out) || (r.ok ? "active" : "unknown");
      }
      return { unit: u.file, state, active };
    });
    for (const f of installed(settings)) {
      if (!want.has(f)) rows.push({ unit: f, state: "orphaned", active: "-" });
    }
    const bad = rows.filter((r) => r.state !== "current").length;
    const out: Record<string, unknown> = {
      infra: bad ? `${bad} of ${rows.length} units need \`infra install\`` : `all ${rows.length} units current`,
      dir,
      units: rows,
    };
    if (problems.length) out.problems = problems;
    if (bad) out.help = [`Run \`${cliInvocation()} infra install\` to render them from opsbot.json`];
    return out;
  }

  if (sub === "install") {
    const { units, problems } = renderUnits(root, settings);
    if (problems.length) {
      throw new AxiError(`cannot render every unit: ${problems.join("; ")}`, "VALIDATION_ERROR", [
        "Rename the monitor script, then run infra install again",
      ]);
    }
    const want = new Set(units.map((u) => u.file));
    const stale = installed(settings).filter((f) => !want.has(f));
    const timers = units.filter((u) => u.enable).map((u) => u.file);
    if (dry) {
      return {
        infra: `would write ${units.length} units to ${dir}, remove ${stale.length}, and enable ${timers.join(", ")}`,
        units: units.map((u) => ({ unit: u.file, content: u.content })),
      };
    }
    mkdirSync(dir, { recursive: true });
    if (stale.length) {
      systemctl(["disable", "--now", ...stale]);
      for (const f of stale) rmSync(join(dir, f), { force: true });
    }
    for (const u of units) writeFileSync(join(dir, u.file), u.content);
    const steps: Array<Record<string, unknown>> = [];
    const reload = systemctl(["daemon-reload"]);
    steps.push({ step: "daemon-reload", ok: reload.ok, detail: firstLine(reload.out) });
    const en = systemctl(["enable", "--now", ...timers]);
    steps.push({ step: `enable --now ${timers.join(" ")}`, ok: en.ok, detail: firstLine(en.out) });
    if (!reload.ok || !en.ok) setExit(1);
    return {
      infra: `${reload.ok && en.ok ? "installed" : "written, but systemctl failed"} · ${units.length} units in ${dir}${stale.length ? ` · removed ${stale.length} no longer wanted` : ""}`,
      steps,
      note: "the timers run while logged out only with lingering (loginctl enable-linger)",
    };
  }

  // uninstall
  const files = installed(settings);
  if (files.length === 0) return { infra: `no ${prefix(settings)}* units installed (no-op)` };
  if (dry) return { infra: `would disable and remove ${files.length} units from ${dir}`, units: files };
  const dis = systemctl(["disable", "--now", ...files]);
  for (const f of files) rmSync(join(dir, f), { force: true });
  const reload = systemctl(["daemon-reload"]);
  if (!reload.ok) setExit(1);
  return {
    infra: `removed ${files.length} units from ${dir}`,
    steps: [
      { step: "disable --now", ok: dis.ok, detail: firstLine(dis.out) },
      { step: "daemon-reload", ok: reload.ok, detail: firstLine(reload.out) },
    ],
  };
}
