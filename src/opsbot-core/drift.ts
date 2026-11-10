/**
 * Session drift: the running session does not match what opsbot.json's loop mode calls for.
 *
 * `start` sets the model and the compaction window when it launches the session. A session
 * started any other way (by hand, by a runtime's own launcher, by a bare resume) has neither,
 * and nothing says so until the context runs out. `cycle begin` runs inside the session, so it
 * can see both: the window is in its environment, and the model is on the last reply in the
 * session log. A bot cannot fix either from inside; it tells its operator, once.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { autocompactTokens } from "./commands/start.js";
import { gitPath } from "./repo.js";
import { MODE_MODEL, type Settings } from "./settings.js";

export const WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** "opus[1m]" → "opus"; a full id stays whole. */
const cls = (m: string) => m.replace(/\[.*\]$/, "").trim().toLowerCase();

export function modelMatches(want: string, have: string): boolean {
  const w = cls(want);
  const h = cls(have);
  return h === w || h.includes(w) || w.includes(h);
}

/**
 * What differs, as lines; empty when nothing does or when this is not running inside a session
 * (`CLAUDECODE` unset: a timer, a test, a person's shell).
 */
export function sessionDrift(s: Settings, env: NodeJS.ProcessEnv, model: string | null): string[] {
  if (!env.CLAUDECODE) return [];
  const out: string[] = [];
  const want = autocompactTokens(s.loop.autocompact);
  const have = env[WINDOW_ENV] ? autocompactTokens(env[WINDOW_ENV]!) : null;
  if (want !== null && have !== want) {
    out.push(`compaction window: this session has ${have ?? "none set"}, the ${s.loop.mode} loop calls for ${want}`);
  }
  const wantModel = s.loop.model ?? MODE_MODEL[s.loop.mode];
  if (model && !modelMatches(wantModel, model)) {
    out.push(`model: this session last replied as ${model}, the ${s.loop.mode} loop calls for ${wantModel}`);
  }
  return out;
}

/**
 * The lines to print now: the drift plus what to do, the first time this drift is seen in this
 * session; nothing on later cycles, so a quiet cycle stays one small call.
 */
export function driftReport(root: string, sessionId: string | null, lines: string[], startLine: string): string[] {
  const marker = gitPath(root, "opsbot-session-drift");
  const sig = `${sessionId ?? "?"}\n${lines.join("\n")}\n`;
  let prev = "";
  try { prev = readFileSync(marker, "utf8"); } catch { /* first time */ }
  if (lines.length === 0) {
    if (prev) try { writeFileSync(marker, ""); } catch { /* a convenience */ }
    return [];
  }
  if (prev === sig) return [];
  try { writeFileSync(marker, sig); } catch { /* shown again next cycle */ }
  return [
    ...lines,
    `The session was not started by \`start\`, or the mode changed since. You cannot change this from inside. Tell your operator once, with the line that fixes it at the next restart: ${startLine}`,
  ];
}
