/**
 * cycle begin / cycle end — one cycle's hold on the checkout.
 *
 * begin: refuses while another writer holds the checkout (a git operation in
 * progress, the index locked, or another live cycle's lock) with exit 30
 * "wait · <who> · next <s> <reason>". Takes over an abandoned lock and records
 * it as an outage. Records a `stopped` outage when no cycle logged within
 * watchdog_minutes and none is open. Runs cycle.d/begin/ (non-zero aborts the
 * cycle as degraded), then the check: on 0 pushes, releases and prints one
 * line; on 10 or 20 prints the check's output and keeps the lock for cycle end.
 *
 * end: pins the watermark to the time of this cycle's check (never "now"),
 * refusing a future time, a backwards move, or no check since the lock was
 * taken; --degraded leaves the watermark alone. Runs cycle.d/end/, appends
 * {at, outcome: "finished", records, watermark, degraded}, commits with
 * --only, pushes, releases, prints the closing line, what the end scripts
 * printed, and the next wake.
 */
import { AxiError } from "axi-sdk-js";
import { intFlag, parseArgs, setExit, usageError } from "../args.js";
import { delayLine, nextDelay } from "../cadence.js";
import { cliInvocation } from "../invocation.js";
import { baseEnv, configSnapshot, discover, runScript } from "../lifecycle.js";
import { blockedBy, commitOnly, firstLine, nowIso, nowMs, parseIso, pushCommits, requireRoot, trailers } from "../repo.js";
import { loadSettings, type Settings } from "../settings.js";
import {
  appendJsonl,
  fileSize,
  judgeLock,
  lastCycleAt,
  openOutage,
  paths,
  readCycleLog,
  readLock,
  readWatermark,
  recordOutage,
  releaseLock,
  takeLock,
  truncateTo,
  writeWatermark,
} from "../state.js";
import { runCheck } from "./check.js";
import { existsSync, rmSync } from "node:fs";

export const CYCLE_USAGE = "cycle begin | cycle end --records N [--degraded] [--summary TEXT]";

function next(root: string, s: Settings): string {
  return delayLine(nextDelay(s, readCycleLog(root), nowMs()));
}

export function cycleCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub === "begin") {
    parseArgs(rest, {}, "cycle begin");
    return cycleBegin();
  }
  if (sub === "end") return cycleEnd(rest);
  throw new AxiError(sub ? `unknown cycle subcommand ${sub}` : "cycle needs a subcommand", "VALIDATION_ERROR", [
    `${cliInvocation()} cycle begin`,
    `${cliInvocation()} cycle end --records <n> [--degraded]`,
  ]);
}

function wait(root: string, s: Settings, who: string): Record<string, unknown> {
  setExit(30);
  return { cycle: `wait · ${who} · next ${next(root, s)}` };
}

function cycleBegin(): Record<string, unknown> {
  const root = requireRoot();
  const { settings, text } = loadSettings(root);

  // another writer
  const blocked = blockedBy(root);
  if (blocked) return wait(root, settings, blocked);

  const verdict = judgeLock(root, settings.lock_max_minutes);
  if (verdict.state === "held") return wait(root, settings, verdict.why);
  if (verdict.state === "abandoned") {
    recordOutage(root, {
      kind: verdict.kind,
      started: verdict.hold.started || nowIso(),
      ended: nowIso(),
      note: verdict.note,
    });
    releaseLock(root);
  }
  if (!takeLock(root)) return wait(root, settings, "another cycle took the checkout at the same moment");

  // a gap
  const lines = readCycleLog(root);
  const last = lastCycleAt(lines);
  if (last && !openOutage(root)) {
    const gap = nowMs() - (parseIso(last) ?? nowMs());
    if (gap >= settings.liveness.watchdog_minutes * 60_000) {
      recordOutage(root, {
        kind: "stopped",
        started: last,
        ended: nowIso(),
        note: `no cycle logged for ${Math.floor(gap / 60_000)} minutes; cause not seen from here`,
      });
    }
  }

  // housekeeping that must run first
  const configPath = configSnapshot(root, text);
  for (const s of discover(root, "cycle.begin").scripts) {
    const r = runScript(s, root, baseEnv(root, settings, configPath, "cycle.begin"));
    if (r.code !== 0) {
      const error = `exit ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout) || "no message"}`;
      appendJsonl(paths(root).log, {
        at: nowIso(),
        outcome: "degraded",
        inputs: {},
        new: 0,
        failed: [{ input: `cycle.d/begin/${s.name}`, error }],
        watermark: readWatermark(root),
      });
      setExit(20);
      return {
        cycle: `degraded · cycle.d/begin/${s.name} failed, so the check did not run · ${error}`,
        help: [`Fix what it reports, then run \`${cliInvocation()} cycle end --records 0 --degraded\` to release the checkout`],
      };
    }
  }

  // the check, with this session's trailers on its commit
  const prev = process.env.OPSBOT_COMMIT_TRAILERS;
  process.env.OPSBOT_COMMIT_TRAILERS = trailers();
  let r;
  try {
    r = runCheck(root, { commit: true });
  } catch (e) {
    // the check could not run: treated as degraded, the hold kept
    setExit(20);
    return {
      cycle: `degraded · the check could not run: ${(e as Error).message}`,
      help: [`Run \`${cliInvocation()} cycle end --records 0 --degraded\` once it is fixed`],
    };
  } finally {
    if (prev === undefined) delete process.env.OPSBOT_COMMIT_TRAILERS;
    else process.env.OPSBOT_COMMIT_TRAILERS = prev;
  }

  if (r.code === 0) {
    const why = pushCommits(root);
    releaseLock(root);
    setExit(0);
    return { cycle: `${r.line}${why ? ` · not pushed: ${why}` : ""} · next ${next(root, settings)}` };
  }
  setExit(r.code);
  return {
    ...r.output,
    help: [
      `Work the items; then \`${cliInvocation()} cycle end --records <n>${r.code === 20 ? " --degraded" : ""}\` (the checkout stays held until then)`,
    ],
  };
}

function cycleEnd(args: string[]): Record<string, unknown> {
  const usage = "cycle end --records N [--degraded] [--summary TEXT]";
  const { flags } = parseArgs(args, { bool: ["degraded"], value: ["records", "summary"] }, usage);
  if (flags.records === undefined) throw usageError("--records is required: how many records this cycle wrote", usage);
  const records = intFlag(flags, "records", usage, { max: 9999 })!;
  const degraded = flags.degraded === true;
  const summary = typeof flags.summary === "string" ? flags.summary : undefined;

  const root = requireRoot();
  const { settings, text } = loadSettings(root);
  const p = paths(root);

  const refuse = (why: string): never => {
    releaseLock(root);
    throw new AxiError(`refused: ${why}; nothing written, the checkout released`, "REFUSED", [
      `Run \`${cliInvocation()} cycle begin\` to start a cycle with a check`,
    ]);
  };

  const { hold } = readLock(root);
  const me = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (hold && me && hold.session && hold.session !== me) {
    throw new AxiError(`refused: session ${hold.session} holds the checkout, not this one`, "REFUSED", [
      `Run \`${cliInvocation()} lock status\` to see the hold`,
    ]);
  }
  const holdAt = hold?.started ?? "";

  const now = nowMs();
  const oldWm = readWatermark(root);
  let wm = oldWm;
  if (!degraded) {
    const lines = readCycleLog(root);
    let checkAt: string | null = null;
    for (const l of lines) {
      if (["new", "degraded", "nothing-new"].includes(l.outcome) && l.at >= holdAt) checkAt = l.at;
    }
    if (!checkAt) refuse(`no check has logged since this cycle began${holdAt ? ` at ${holdAt}` : ""}`);
    const ce = parseIso(checkAt);
    if (ce === null) refuse(`the check's time ${checkAt} cannot be read`);
    if (ce! > now) refuse(`the check's time ${checkAt} is later than the clock, ${nowIso()}`);
    if (oldWm) {
      const oe = parseIso(oldWm);
      if (oe === null) refuse(`the watermark on file, ${oldWm}, cannot be read`);
      if (ce! < oe!) refuse(`the watermark would move backwards, from ${oldWm} to ${checkAt}`);
    }
    wm = checkAt;
  }

  const blocked = blockedBy(root);
  if (blocked) {
    throw new AxiError(`cannot commit: ${blocked}; nothing written, the checkout still held`, "CANNOT_COMMIT", [
      `Run \`${cliInvocation()} cycle end --records ${records}${degraded ? " --degraded" : ""}\` again when it is done`,
    ]);
  }

  // what to show at the close
  const configPath = configSnapshot(root, text);
  const notes: string[] = [];
  for (const s of discover(root, "cycle.end").scripts) {
    const r = runScript(s, root, baseEnv(root, settings, configPath, "cycle.end", { OPSBOT_WATERMARK: wm ?? "" }));
    if (r.code !== 0) {
      notes.push(`cycle.d/end/${s.name} failed, exit ${r.code}: ${firstLine(r.stderr) || "no message"}`);
    }
    for (const line of r.stdout.split("\n")) if (line.trim()) notes.push(line);
  }

  const logSize = fileSize(p.log);
  if (!degraded && wm) writeWatermark(root, wm);
  const line: Record<string, unknown> = {
    at: nowIso(),
    outcome: "finished",
    records,
    watermark: wm ?? null,
    degraded,
  };
  if (summary !== undefined) line.summary = summary;
  appendJsonl(p.log, line);

  const files = [p.log];
  if (existsSync(p.watermark)) files.push(p.watermark);
  if (existsSync(p.outages)) files.push(p.outages);
  const why = commitOnly(root, files, `chore(cycle): finished, ${records} records`);
  if (why) {
    truncateTo(p.log, logSize);
    if (oldWm) writeWatermark(root, oldWm);
    else if (!degraded) rmSync(p.watermark, { force: true });
    throw new AxiError(`cannot commit the cycle log (${why}); nothing written, the checkout still held`, "CANNOT_COMMIT", [
      "Fix the repo, then run cycle end again",
    ]);
  }
  const pushed = pushCommits(root);
  releaseLock(root);
  const out: Record<string, unknown> = {
    cycle: `finished · ${records} records · watermark ${wm ?? "none"}${degraded ? " (held: degraded)" : ""}${pushed ? ` · not pushed: ${pushed}` : ""}`,
  };
  if (notes.length) out.notes = notes;
  out.next = next(root, settings);
  return out;
}
