/**
 * The small read-mostly commands: next-delay, lock, log tail, hooks list,
 * settings validate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { intFlag, parseArgs, setExit, usageError } from "../args.js";
import { delayLine, nextDelay } from "../cadence.js";
import { cliInvocation } from "../invocation.js";
import { POINTS, POINT_DIRS, discover, parsePoint, type Point } from "../lifecycle.js";
import { nowMs, parseIso, requireRoot, showHead } from "../repo.js";
import { SETTINGS_FILE, loadSettings, parseSettingsText } from "../settings.js";
import { judgeLock, pidAlive, readCycleLog, readLock, releaseLock, type LogLine } from "../state.js";

// ------------------------------------------------------------ next-delay

export function nextDelayCommand(args: string[]): Record<string, unknown> {
  parseArgs(args, {}, "next-delay");
  const root = requireRoot();
  const { settings } = loadSettings(root);
  return { next: delayLine(nextDelay(settings, readCycleLog(root), nowMs())) };
}

// ------------------------------------------------------------------ lock

export const LOCK_USAGE = "lock status | lock release [--abandon]";

export function lockCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const root = requireRoot();
  if (sub === "status") {
    parseArgs(rest, {}, LOCK_USAGE);
    const { settings } = loadSettings(root);
    const v = judgeLock(root, settings.lock_max_minutes);
    if (v.state === "free") return { lock: "free" };
    const started = parseIso(v.hold.started);
    return {
      lock: {
        state: v.state,
        session: v.hold.session || "unknown",
        pid: v.hold.pid || "unknown",
        alive: v.hold.pid ? pidAlive(v.hold.pid) : "unknown",
        started: v.hold.started || "unknown",
        age_minutes: started === null ? "unknown" : Math.floor((nowMs() - started) / 60_000),
        ...(v.state === "abandoned" ? { abandoned: v.note } : {}),
      },
    };
  }
  if (sub === "release") {
    const { flags } = parseArgs(rest, { bool: ["abandon"] }, LOCK_USAGE);
    const { hold } = readLock(root);
    if (!hold) return { lock: "free (no-op)" };
    const { settings } = loadSettings(root);
    const v = judgeLock(root, settings.lock_max_minutes);
    const mine = !!process.env.CLAUDE_CODE_SESSION_ID && hold.session === process.env.CLAUDE_CODE_SESSION_ID;
    if (v.state === "held" && !mine && !flags.abandon) {
      throw new AxiError(`refused: ${v.why}, and it is alive`, "REFUSED", [
        `Run \`${cliInvocation()} lock release --abandon\` only if you know that cycle is gone`,
      ]);
    }
    releaseLock(root);
    return { lock: `released · was held by session ${hold.session || "unknown"} since ${hold.started || "unknown"}` };
  }
  throw new AxiError(sub ? `unknown lock subcommand ${sub}` : "lock needs a subcommand", "VALIDATION_ERROR", [
    `${cliInvocation()} ${LOCK_USAGE}`,
  ]);
}

// -------------------------------------------------------------- log tail

export function detail(l: LogLine): string {
  switch (l.outcome) {
    case "nothing-new":
    case "new":
    case "degraded": {
      const failed = Array.isArray(l.failed) ? l.failed.length : 0;
      return `${l.new ?? 0} new${failed ? ` · ${failed} failed` : ""}`;
    }
    case "finished":
      return `${l.records ?? 0} records${l.degraded ? " · degraded" : ""}${l.summary ? ` · ${String(l.summary)}` : ""}`;
    case "outage":
      return `${l.kind ?? ""} from ${l.started ?? ""}`;
    case "outage-end":
      return `outage from ${l.started ?? ""} ended ${l.ended ?? ""}`;
    default:
      return "";
  }
}

export function logCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub !== "tail") {
    throw new AxiError(sub ? `unknown log subcommand ${sub}` : "log needs a subcommand", "VALIDATION_ERROR", [
      `${cliInvocation()} log tail [--n N]`,
    ]);
  }
  const usage = "log tail [--n N]";
  const { flags } = parseArgs(rest, { value: ["n"] }, usage);
  const n = intFlag(flags, "n", usage, { min: 1, max: 1000 }) ?? 10;
  const root = requireRoot();
  const lines = readCycleLog(root);
  if (lines.length === 0) return { cycles: "0 lines: no cycle has logged in this checkout" };
  const tail = lines.slice(-n);
  const out: Record<string, unknown> = {
    count: `${tail.length} of ${lines.length} lines`,
    cycles: tail.map((l) => ({
      at: l.at,
      outcome: l.outcome,
      detail: detail(l),
      watermark: (l.watermark as string | null | undefined) ?? "",
    })),
  };
  if (tail.length < lines.length) out.help = [`Run \`${cliInvocation()} log tail --n ${Math.min(lines.length, 1000)}\` for more`];
  return out;
}

// ------------------------------------------------------------ hooks list

export function hooksCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const usage = "hooks list [--point P]";
  if (sub !== "list") throw usageError(sub ? `unknown hooks subcommand ${sub}` : "hooks needs a subcommand", usage);
  const { flags } = parseArgs(rest, { value: ["point"] }, usage);
  let points: readonly Point[] = POINTS;
  if (typeof flags.point === "string") {
    const pt = parsePoint(flags.point);
    if (!pt) throw usageError(`unknown point ${flags.point}`, usage, `points: ${POINTS.join(", ")}`);
    points = [pt];
  }
  const root = requireRoot();
  const rows: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const pt of points) {
    const d = discover(root, pt);
    d.scripts.forEach((s, i) => rows.push({ point: pt, order: i + 1, name: s.name, source: s.source }));
    for (const k of d.skipped) skipped.push({ point: pt, name: k.name, reason: k.reason });
  }
  const out: Record<string, unknown> = {};
  out.scripts = rows.length
    ? rows
    : `0 scripts in ${points.map((p) => `opsbot.d/${POINT_DIRS[p]}/`).join(", ")}`;
  if (skipped.length) out.skipped = skipped;
  return out;
}

// ------------------------------------------------------- settings validate

export function settingsCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  const usage = "settings validate [--head]";
  if (sub !== "validate") throw usageError(sub ? `unknown settings subcommand ${sub}` : "settings needs a subcommand", usage);
  const { flags } = parseArgs(rest, { bool: ["head"] }, usage);
  const root = requireRoot();
  let text: string | null;
  let where: string;
  if (flags.head) {
    text = showHead(root, SETTINGS_FILE);
    where = `${SETTINGS_FILE} at HEAD`;
  } else {
    const p = join(root, SETTINGS_FILE);
    text = existsSync(p) ? readFileSync(p, "utf8") : null;
    where = SETTINGS_FILE;
  }
  if (text === null) {
    throw new AxiError(`${where} does not exist`, "CANNOT_RUN", [
      `Copy the skill's templates/opsbot.json to ${SETTINGS_FILE} and fill it in`,
    ]);
  }
  const { raw, problems } = parseSettingsText(text, where);
  // one value, one place: Claude Code's own autocompact setting must agree
  const claude = join(root, ".claude", "settings.json");
  if (raw && existsSync(claude)) {
    try {
      const cs = JSON.parse(readFileSync(claude, "utf8"));
      const loop = (raw.loop ?? {}) as Record<string, unknown>;
      if (cs && cs.autoCompactWindow !== undefined && String(cs.autoCompactWindow) !== String(loop.autocompact ?? "")) {
        problems.push(
          `.claude/settings.json sets autoCompactWindow ${JSON.stringify(cs.autoCompactWindow)} but loop.autocompact is ${JSON.stringify(loop.autocompact ?? null)}; set it in one place`,
        );
      }
    } catch {
      // not our file to judge
    }
  }
  if (problems.length) {
    setExit(1);
    return { settings: `invalid · ${where} · ${problems.length} problem${problems.length === 1 ? "" : "s"}`, problems };
  }
  return { settings: `valid · ${where}` };
}
