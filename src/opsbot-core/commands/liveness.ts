/**
 * watchdog and nudge — run outside the session, with no model, from system
 * timers. Neither commits: the next cycle's commit carries what they append.
 *
 * watchdog: under watchdog_minutes since the last cycle, quiet (and records
 * the end of an open outage once cycles resume). Past it, escalates once per
 * outage through every opsbot.d/escalate.d/ script (the message on stdin) and
 * records a `stopped` outage. The told-once marker is kept in the git
 * directory; if no escalation script succeeds, nothing is kept, exit 1, and
 * the next run tries again. While a rebase or merge is in progress it writes
 * nothing to the logs and says so.
 *
 * nudge: re-issues loop.prompt to the runtime's named agent when the loop is
 * quiet past nudge_minutes, no live lock holds the checkout, no git operation
 * is in progress, it has not nudged within nudge_cooldown_minutes, and the
 * runtime reports the agent idle or done. --now skips the quiet test, for a
 * monitor that cannot wait, and has its own cooldown (wake_cooldown_minutes).
 * A prompt that may have landed counts as a nudge; a refused one does not.
 * The nudge never creates a second loop: it prompts the one named agent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit } from "../args.js";
import { baseEnv, configSnapshot, discover, runScript } from "../lifecycle.js";
import { blockedBy, firstLine, gitPath, humanTime, nowIso, nowMs, parseIso, requireRoot } from "../repo.js";
import { loadSettings } from "../settings.js";
import { runtimeFor } from "../runtime.js";
import { CYCLE_OUTCOMES, judgeLock, lastCycleAt, openOutage, readCycleLog, readLock, recordOutage, recordOutageEnd } from "../state.js";

// --------------------------------------------------------------- watchdog

export function watchdogCommand(args: string[]): Record<string, unknown> {
  const { flags } = parseArgs(args, { bool: ["dry-run"] }, "watchdog [--dry-run]");
  const dry = flags["dry-run"] === true;
  const root = requireRoot();
  const { settings, text } = loadSettings(root);
  const now = nowMs();
  const watch = settings.liveness.watchdog_minutes;
  const told = gitPath(root, "opsbot-watchdog");
  const blocked = blockedBy(root);
  const lines = readCycleLog(root);
  const last = lastCycleAt(lines);
  const open = openOutage(root);
  const gap = last ? now - (parseIso(last) ?? now) : null;

  if (gap !== null && gap < watch * 60_000) {
    if (open && last! > open) {
      const resumed = lines.find((l) => CYCLE_OUTCOMES.includes(l.outcome) && l.at > open)?.at ?? last!;
      if (blocked) return { watchdog: `alive · last cycle ${last} · the outage from ${open} ended at ${resumed}; not recorded while ${blocked}` };
      if (dry) return { watchdog: `alive · would record the end of the outage from ${open} at ${resumed}` };
      recordOutageEnd(root, open, resumed);
      return { watchdog: `alive · last cycle ${last} · outage from ${open} ended ${resumed}` };
    }
    return { watchdog: `alive · last cycle ${last}, ${Math.floor(gap / 60_000)} min ago` };
  }

  const started = last ?? "never";
  if (existsSync(told) && readFileSync(told, "utf8").split("\n")[0] === started) {
    return { watchdog: `stopped since ${started} · the operator already told` };
  }

  // what can be seen from outside the session
  const seen: string[] = [];
  if (blocked) seen.push(`In the bot's checkout, ${blocked}, so cycles are waiting for it to finish.`);
  const { hold } = readLock(root);
  if (hold) {
    const h = parseIso(hold.started);
    seen.push(`A cycle took hold of the checkout${h !== null ? ` at ${humanTime(h, settings.timezone)}` : ""} and has not let go.`);
  }
  const found = runtimeFor(settings).get(settings.runtime.agent);
  if (found.ok) {
    if (found.status === "blocked") seen.push("The bot's session is waiting at a permission or question dialog.");
  } else if (found.code === "agent_not_found") {
    seen.push(`The runtime has no agent named ${settings.runtime.agent}, so the session itself is not running.`);
  }
  if (seen.length === 0) seen.push("Nothing outside the session shows why.");

  const first = last
    ? `${settings.mark} ${settings.name} has logged no cycle since ${humanTime(parseIso(last)!, settings.timezone)}, over ${watch} minutes ago, so nothing is being read or answered.`
    : `${settings.mark} ${settings.name} has never logged a cycle in this checkout, so nothing is being read or answered.`;
  const message = [first, ...seen, "The watchdog will not repeat this for the same stop."].join("\n");

  if (dry) return { watchdog: `stopped since ${started} · would tell the operator`, message: message.split("\n") };

  const scripts = discover(root, "escalate").scripts;
  if (scripts.length === 0) {
    setExit(1);
    return {
      watchdog: `stopped since ${started} · cannot tell the operator: no script in opsbot.d/escalate.d/`,
      help: ["Install an escalation script (a channel skill provides one) so the watchdog can reach the operator"],
    };
  }
  const configPath = configSnapshot(root, text);
  const results = scripts.map((s) => {
    const r = runScript(s, root, baseEnv(root, settings, configPath, "escalate"), `${message}\n`);
    return { script: s.name, ok: r.code === 0, error: r.code === 0 ? "" : `exit ${r.code}: ${firstLine(r.stderr) || "no message"}` };
  });
  const sent = results.filter((r) => r.ok);
  if (sent.length === 0) {
    setExit(1);
    return { watchdog: `stopped since ${started} · cannot tell the operator: every escalation script failed`, escalations: results };
  }
  writeFileSync(told, `${started}\n`);

  if (blocked) {
    return { watchdog: `stopped since ${started} · the operator told · outage not recorded while ${blocked}`, escalations: results };
  }
  if (!open) {
    recordOutage(root, {
      kind: "stopped",
      started: last ?? nowIso(),
      note: `no cycle logged for ${watch} minutes or more; seen from outside: ${seen.join(" ")}`,
    });
  }
  return { watchdog: `stopped since ${started} · the operator told · outage recorded`, escalations: results };
}

// ------------------------------------------------------------------ nudge

export function nudgeCommand(args: string[]): Record<string, unknown> {
  const usage = "nudge [--now [--reason TEXT]] [--dry-run]";
  const { flags } = parseArgs(args, { bool: ["now", "dry-run"], value: ["reason"] }, usage);
  const wake = flags.now === true;
  const reason = typeof flags.reason === "string" ? flags.reason : "";
  if (reason && !wake) throw new AxiError("--reason goes with --now", "VALIDATION_ERROR", [usage]);
  const dry = flags["dry-run"] === true;

  const root = requireRoot();
  const { settings } = loadSettings(root);
  const agent = settings.runtime.agent;
  const line = settings.loop.prompt;
  const now = nowMs();
  const quiet = wake ? settings.liveness.wake_cooldown_minutes : settings.liveness.nudge_minutes;
  const cooldown = wake ? settings.liveness.wake_cooldown_minutes : settings.liveness.nudge_cooldown_minutes;
  const marker = gitPath(root, wake ? "opsbot-nudge-now" : "opsbot-nudge");

  const v = judgeLock(root, settings.lock_max_minutes);
  if (v.state === "held") return { nudge: `nothing · a cycle holds the checkout since ${v.hold.started}` };
  const blocked = blockedBy(root);
  if (blocked) return { nudge: `nothing · ${blocked}` };

  const last = lastCycleAt(readCycleLog(root));
  if (!wake && last && now - (parseIso(last) ?? 0) < quiet * 60_000) {
    return { nudge: `nothing · last cycle ${last}` };
  }
  if (existsSync(marker)) {
    const [prev, why] = readFileSync(marker, "utf8").split("\n");
    if (prev && /^\d+$/.test(prev) && now - Number(prev) * 1000 < cooldown * 60_000) {
      const ago = Math.floor((now - Number(prev) * 1000) / 60_000);
      return { nudge: wake ? `nothing · woke ${ago} min ago${why ? ` for: ${why}` : ""}` : `nothing · nudged ${ago} min ago and no cycle since` };
    }
  }

  const rt = runtimeFor(settings);
  const found = rt.get(agent);
  if (!found.ok) {
    setExit(1);
    return { nudge: found.code === "agent_not_found" ? `cannot · the runtime has no agent named ${agent}` : `cannot · ${rt.name}: ${found.code}: ${found.message}` };
  }
  switch (found.status) {
    case "idle":
    case "done":
      break;
    case "working":
      return { nudge: `nothing · ${agent} is working (mid-turn)` };
    case "blocked":
      return { nudge: `nothing · ${agent} is blocked at a dialog; a prompt would land in it` };
    default:
      return { nudge: `nothing · the runtime cannot tell what ${agent} is doing (${found.status}); treated as busy` };
  }

  if (dry) return { nudge: `would prompt ${agent} (${found.pane}, ${found.status})${wake ? ` now${reason ? `, for: ${reason}` : ""}` : ""}: ${line}` };
  const stamp = `${Math.floor(now / 1000)}\n${reason}\n`;
  const r = rt.prompt(agent, line);
  if (!r.ok) {
    // refused before anything was sent: not a nudge; anything else may have landed
    if (r.code !== "agent_blocked" && r.code !== "agent_not_found") writeFileSync(marker, stamp);
    setExit(1);
    return { nudge: `cannot · ${rt.name} prompt ${agent}: ${r.code}: ${r.message}` };
  }
  writeFileSync(marker, stamp);
  return { nudge: wake ? `woke ${agent}${reason ? ` for: ${reason}` : ""}` : `nudged ${agent}: ${line}`, at: nowIso() };
}
