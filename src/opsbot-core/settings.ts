/**
 * opsbot.json: the one committed file that holds every loop value.
 *
 * `validateSettings` refuses an unknown key, a missing required key, a value of
 * the wrong shape, and a cadence value over the cap. A key named "//" is a
 * comment and is allowed anywhere. `streams.<name>` objects belong to the
 * heartbeat scripts and are not checked inside.
 *
 * `loadSettings` reads the file as committed at HEAD (what runs is what was
 * reviewed) and fills defaults.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { isValidTimeZone, showHead } from "./repo.js";

export const SETTINGS_FILE = "opsbot.json";

/** specs/principles.md#the-loops-class-follows-its-work-strategist-or-dispatcher */
export const LOOP_MODES = ["strategist", "dispatcher"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];
/**
 * The compaction window when `loop.autocompact` is unset. Every call reads the whole window from
 * cache, so the window is priced per call. A strategist uses its context on most turns: 750k,
 * with room to spare under 1M. A dispatcher mostly re-reads a context it does not use: 300k.
 * Measured on a support bot (floor 75k after a compaction, 2k of growth a call): 300k costs half
 * of a 715k window per call and about a fifth more than 200k, with half of 200k's compactions.
 */
export const MODE_AUTOCOMPACT: Record<LoopMode, string> = { strategist: "750k", dispatcher: "300k" };
/**
 * How the session schedules its next cycle. `self`: the self-paced call with the loop prompt.
 * `monitor`: one bounded Monitor armed at the end of every cycle, which exits on a new line in a
 * wake file or when the next cycle is due (specs/skills/opsbot-core.md, The schedule monitor).
 */
export const LOOP_SCHEDULES = ["self", "monitor"] as const;
export type LoopSchedule = (typeof LOOP_SCHEDULES)[number];
/** The model `start` passes when `loop.model` is not set. */
export const MODE_MODEL: Record<LoopMode, string> = { strategist: "fable", dispatcher: "opus" };

export interface Cadence {
  hot: number;
  warm: number;
  quiet_working: number;
  quiet: number;
  night: number;
  cap: number;
  working_hours: { days: number[]; start: string; end: string };
  night_hours: { start: string; end: string };
}

export interface Liveness {
  watchdog_minutes: number;
  nudge_minutes: number;
  nudge_cooldown_minutes: number;
  wake_cooldown_minutes: number;
  interval_minutes: number;
}

/** Sleep after a quiet stretch, wake on an event (specs/skills/opsbot-core.md, Sleep). */
export interface Sleep {
  after_minutes: number;
  probe_minutes: number;
  max_minutes: number;
  compact: boolean;
}

export const DEFAULT_SLEEP: Sleep = { after_minutes: 60, probe_minutes: 10, max_minutes: 480, compact: true };

export interface Settings {
  name: string;
  mark: string;
  timezone: string;
  rule_card: string | null;
  gate_word: string | null;
  loop: { prompt: string; autocompact: string | null; model: string | null; permission_mode: string; mode: LoopMode; session_name: string; schedule: LoopSchedule };
  cadence: Cadence;
  lock_max_minutes: number;
  liveness: Liveness;
  runtime: { adapter: "herdr"; agent: string };
  streams: Record<string, Record<string, unknown>>;
  repo_sync: "pull-on-clean" | "never-pull";
  /** Files a stream's monitor appends one line per event to; the session arms a bounded
   * Monitor on each between cycles (the live wake), and the listener's nudge is the backstop. */
  wake: { files: string[] };
  /** Repo-relative files the check's commit and the cycle-end commit also take when changed. */
  commit_paths: string[];
  /** Null when `sleep` is absent: the bot never sleeps. */
  sleep: Sleep | null;
}

/** The kit's defaults (specs/architecture.md, Next wake; specs/skills/opsbot-core.md). */
export const DEFAULT_CADENCE: Cadence = {
  hot: 180,
  warm: 600,
  quiet_working: 600,
  quiet: 1800,
  night: 2700,
  cap: 2700,
  working_hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  night_hours: { start: "22:00", end: "07:00" },
};

export const DEFAULT_LIVENESS: Liveness = {
  watchdog_minutes: 60,
  nudge_minutes: 50,
  nudge_cooldown_minutes: 50,
  wake_cooldown_minutes: 10,
  interval_minutes: 10,
};

/** With `loop.schedule: "monitor"` the nudge's unset quiet limit and cooldown: one missed wake
 * (29 minutes at most) plus a margin, so a session whose monitor was not re-armed is noticed. */
export const MONITOR_NUDGE_MINUTES = 35;

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CADENCE_SECONDS = ["hot", "warm", "quiet_working", "quiet", "night", "cap"] as const;
const LIVENESS_KEYS = Object.keys(DEFAULT_LIVENESS) as Array<keyof Liveness>;
const ONE_HOUR = 3600;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keysOf(o: Json): string[] {
  return Object.keys(o).filter((k) => k !== "//");
}

/** Problems with a parsed settings object; empty when it is valid. */
export function validateSettings(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(raw)) return ["the file is not a JSON object"];

  const allow = (o: Json, where: string, allowed: string[]) => {
    for (const k of keysOf(o)) {
      if (!allowed.includes(k)) problems.push(`unknown key ${where}${k}`);
    }
  };
  const str = (o: Json, k: string, where: string, required: boolean, re?: RegExp, hint?: string) => {
    const v = o[k];
    if (v === undefined) {
      if (required) problems.push(`missing required key ${where}${k}`);
      return;
    }
    if (typeof v !== "string" || v === "") {
      problems.push(`${where}${k} must be a non-empty string`);
      return;
    }
    if (re && !re.test(v)) problems.push(`${where}${k} ${hint ?? `must match ${re}`} (got ${JSON.stringify(v)})`);
  };
  const posInt = (o: Json, k: string, where: string) => {
    const v = o[k];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      problems.push(`${where}${k} must be a positive whole number`);
    }
  };
  const obj = (o: Json, k: string, where: string, required: boolean): Json | null => {
    const v = o[k];
    if (v === undefined) {
      if (required) problems.push(`missing required key ${where}${k}`);
      return null;
    }
    if (!isObj(v)) {
      problems.push(`${where}${k} must be an object`);
      return null;
    }
    return v;
  };

  allow(raw, "", [
    "name",
    "mark",
    "timezone",
    "rule_card",
    "gate_word",
    "loop",
    "cadence",
    "lock_max_minutes",
    "liveness",
    "runtime",
    "streams",
    "repo_sync",
    "wake",
    "host",
    "commit_paths",
    "sleep",
  ]);
  str(raw, "name", "", true, NAME_RE, "must be lowercase letters, digits and dashes, starting with a letter");
  str(raw, "mark", "", true);
  str(raw, "timezone", "", false);
  if (typeof raw.timezone === "string" && raw.timezone && !isValidTimeZone(raw.timezone)) {
    problems.push(`timezone ${JSON.stringify(raw.timezone)} is not an IANA time zone`);
  }
  str(raw, "rule_card", "", false);
  str(raw, "gate_word", "", false, /^[A-Z]{3,}$/, "must be three or more capital letters");
  posInt(raw, "lock_max_minutes", "");
  if (raw.repo_sync !== undefined && raw.repo_sync !== "pull-on-clean" && raw.repo_sync !== "never-pull") {
    problems.push(`repo_sync must be pull-on-clean or never-pull (got ${JSON.stringify(raw.repo_sync)})`);
  }

  const loop = obj(raw, "loop", "", true);
  if (loop) {
    allow(loop, "loop.", ["prompt", "autocompact", "model", "permission_mode", "mode", "session_name", "schedule"]);
    if (loop.mode !== undefined && !LOOP_MODES.includes(loop.mode as LoopMode)) problems.push(`loop.mode must be one of ${LOOP_MODES.join(", ")}`);
    if (loop.schedule !== undefined && !LOOP_SCHEDULES.includes(loop.schedule as LoopSchedule)) problems.push(`loop.schedule must be one of ${LOOP_SCHEDULES.join(", ")}`);
    str(loop, "prompt", "loop.", true);
    str(loop, "session_name", "loop.", false, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be one word of letters, digits, dots, dashes or underscores");
    if (loop.schedule === "monitor" && typeof loop.prompt === "string" && loop.prompt.trimStart().startsWith("/")) {
      problems.push("loop.prompt must not start with a slash command when loop.schedule is monitor: every wake would re-read the command's body");
    }
    if (loop.model !== undefined && (typeof loop.model !== "string" || loop.model === "")) problems.push("loop.model must be a non-empty string (a Claude Code model name or alias)");
    const PM = ["auto", "default", "acceptEdits", "plan"];
    if (loop.permission_mode !== undefined && !PM.includes(loop.permission_mode as string)) problems.push(`loop.permission_mode must be one of ${PM.join(", ")}`);
    const ac = loop.autocompact;
    if (ac !== undefined && !(typeof ac === "string" && ac !== "") && !(typeof ac === "number" && ac > 0)) {
      problems.push("loop.autocompact must be a window such as \"750k\" or a number");
    }
  }

  const cadence = obj(raw, "cadence", "", false);
  if (cadence) {
    allow(cadence, "cadence.", [...CADENCE_SECONDS, "working_hours", "night_hours"]);
    for (const k of CADENCE_SECONDS) posInt(cadence, k, "cadence.");
    const cap = typeof cadence.cap === "number" ? cadence.cap : DEFAULT_CADENCE.cap;
    if (cap > ONE_HOUR) problems.push(`cadence.cap ${cap} is over 3600, the one-hour cache`);
    for (const k of CADENCE_SECONDS) {
      if (k === "cap") continue;
      const v = cadence[k];
      if (typeof v === "number" && v > cap) problems.push(`cadence.${k} ${v} is over the cap of ${cap}`);
    }
    const wh = obj(cadence, "working_hours", "cadence.", false);
    if (wh) {
      allow(wh, "cadence.working_hours.", ["days", "start", "end"]);
      if (wh.days !== undefined) {
        const d = wh.days;
        if (!Array.isArray(d) || !d.every((x) => Number.isInteger(x) && x >= 1 && x <= 7)) {
          problems.push("cadence.working_hours.days must be ISO weekday numbers, 1 (Monday) to 7 (Sunday)");
        }
      }
      str(wh, "start", "cadence.working_hours.", false, HM_RE, "must be HH:MM");
      str(wh, "end", "cadence.working_hours.", false, HM_RE, "must be HH:MM");
    }
    const nh = obj(cadence, "night_hours", "cadence.", false);
    if (nh) {
      allow(nh, "cadence.night_hours.", ["start", "end"]);
      str(nh, "start", "cadence.night_hours.", false, HM_RE, "must be HH:MM");
      str(nh, "end", "cadence.night_hours.", false, HM_RE, "must be HH:MM");
    }
  }

  const liveness = obj(raw, "liveness", "", false);
  if (liveness) {
    allow(liveness, "liveness.", LIVENESS_KEYS);
    for (const k of LIVENESS_KEYS) posInt(liveness, k, "liveness.");
    const iv = liveness.interval_minutes;
    if (typeof iv === "number" && iv > 60) problems.push("liveness.interval_minutes must be 60 or less");
  }

  const runtime = obj(raw, "runtime", "", true);
  if (runtime) {
    allow(runtime, "runtime.", ["adapter", "agent"]);
    if (runtime.adapter !== undefined && runtime.adapter !== "herdr") {
      problems.push(`runtime.adapter must be herdr, the one adapter this version has (got ${JSON.stringify(runtime.adapter)})`);
    }
    str(runtime, "agent", "runtime.", true, AGENT_RE, "must be a runtime agent name ([a-z][a-z0-9_-]{0,31})");
  }

  const streams = obj(raw, "streams", "", false);
  if (streams) {
    for (const k of keysOf(streams)) {
      if (!isObj(streams[k])) problems.push(`streams.${k} must be an object`);
    }
  }
  // `host` belongs to opsbot-host (display, ports); it is checked there, not here.
  obj(raw, "host", "", false);
  const wake = obj(raw, "wake", "", false);
  if (wake) {
    allow(wake, "wake.", ["files"]);
    const files = wake.files;
    if (files !== undefined) {
      if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !f.trim())) {
        problems.push("wake.files must be an array of file paths (strings)");
      }
    }
  }
  if (raw.commit_paths !== undefined) problems.push(...commitPathProblems(raw.commit_paths));
  const sleep = obj(raw, "sleep", "", false);
  if (sleep) {
    allow(sleep, "sleep.", ["after_minutes", "probe_minutes", "max_minutes", "compact"]);
    for (const k of ["after_minutes", "probe_minutes", "max_minutes"]) posInt(sleep, k, "sleep.");
    if (sleep.compact !== undefined && typeof sleep.compact !== "boolean") problems.push("sleep.compact must be true or false");
    // the compaction on the way down must land while the one-hour cache is warm
    if (typeof sleep.probe_minutes === "number" && sleep.probe_minutes > 60) problems.push("sleep.probe_minutes must be 60 or less");
    const loopSchedule = isObj(raw.loop) ? raw.loop.schedule : undefined;
    if (loopSchedule !== "monitor") {
      problems.push("sleep requires loop.schedule to be monitor: the prompt is then a plain message the sleep timer can type, and there is no self-paced loop to end");
    }
  }
  return problems;
}

/**
 * `commit_paths`: an array of repo-relative file paths. Refuses an absolute path, a `..`
 * segment, and anything under `.git/` or `.claude/` (the core never commits those).
 */
function commitPathProblems(v: unknown): string[] {
  if (!Array.isArray(v)) return ["commit_paths must be an array of repo-relative file paths"];
  const problems: string[] = [];
  for (const f of v) {
    if (typeof f !== "string" || !f.trim()) {
      problems.push("commit_paths entries must be non-empty strings");
      continue;
    }
    const segs = f.split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
    if (f.startsWith("/") || /^[A-Za-z]:/.test(f)) problems.push(`commit_paths ${JSON.stringify(f)} must be relative to the repo, not absolute`);
    else if (segs.includes("..")) problems.push(`commit_paths ${JSON.stringify(f)} must not contain a .. segment`);
    else if (segs[0] === ".git" || segs[0] === ".claude") problems.push(`commit_paths ${JSON.stringify(f)} is under ${segs[0]}/, which the core never commits`);
    else if (segs.length === 0) problems.push(`commit_paths ${JSON.stringify(f)} names the repo itself, not a file`);
  }
  return problems;
}

/** Fill defaults into a settings object that validated. */
export function withDefaults(raw: Json): Settings {
  const loop = (raw.loop ?? {}) as Json;
  const cad = (raw.cadence ?? {}) as Json;
  const wh = (cad.working_hours ?? {}) as Json;
  const nh = (cad.night_hours ?? {}) as Json;
  const lv = (raw.liveness ?? {}) as Json;
  const rt = (raw.runtime ?? {}) as Json;
  const pick = <T>(v: unknown, d: T): T => (v === undefined ? d : (v as T));
  const mode: LoopMode = LOOP_MODES.includes(loop.mode as LoopMode) ? (loop.mode as LoopMode) : "strategist";
  const wakeList = Array.isArray((raw.wake as Json | undefined)?.files) ? ((raw.wake as Json).files as string[]) : [];
  const cadence: Cadence = {
    hot: pick(cad.hot, DEFAULT_CADENCE.hot),
    warm: pick(cad.warm, DEFAULT_CADENCE.warm),
    quiet_working: pick(cad.quiet_working, DEFAULT_CADENCE.quiet_working),
    quiet: pick(cad.quiet, DEFAULT_CADENCE.quiet),
    night: pick(cad.night, DEFAULT_CADENCE.night),
    cap: pick(cad.cap, DEFAULT_CADENCE.cap),
    working_hours: {
      days: pick(wh.days, DEFAULT_CADENCE.working_hours.days),
      start: pick(wh.start, DEFAULT_CADENCE.working_hours.start),
      end: pick(wh.end, DEFAULT_CADENCE.working_hours.end),
    },
    night_hours: {
      start: pick(nh.start, DEFAULT_CADENCE.night_hours.start),
      end: pick(nh.end, DEFAULT_CADENCE.night_hours.end),
    },
  };
  // A dispatcher with a live wake (wake.files) is woken by its streams, so its timer between
  // arrivals only keeps the cache warm: the quiet delays default to the cap. Without wake files
  // the timer is still how it notices anything, and the table stands.
  if (mode === "dispatcher" && wakeList.length > 0) {
    if (cad.quiet_working === undefined) cadence.quiet_working = cadence.cap;
    if (cad.quiet === undefined) cadence.quiet = cadence.cap;
  }
  const schedule: LoopSchedule = loop.schedule === "monitor" ? "monitor" : "self";
  const liveness = Object.fromEntries(
    LIVENESS_KEYS.map((k) => [k, pick(lv[k], DEFAULT_LIVENESS[k])]),
  ) as unknown as Liveness;
  // A monitor schedule tightens the backstop's unset values; explicit values always win.
  if (schedule === "monitor") {
    if (lv.nudge_minutes === undefined) liveness.nudge_minutes = MONITOR_NUDGE_MINUTES;
    if (lv.nudge_cooldown_minutes === undefined) liveness.nudge_cooldown_minutes = MONITOR_NUDGE_MINUTES;
  }
  const streams = Object.fromEntries(
    Object.entries((raw.streams ?? {}) as Json).filter(([k]) => k !== "//"),
  ) as Record<string, Record<string, unknown>>;
  return {
    name: raw.name as string,
    mark: raw.mark as string,
    timezone: pick(raw.timezone, "UTC"),
    rule_card: pick(raw.rule_card, null),
    gate_word: pick(raw.gate_word, null),
    loop: {
      prompt: loop.prompt as string,
      autocompact: loop.autocompact === undefined ? MODE_AUTOCOMPACT[mode] : String(loop.autocompact),
      model: loop.model === undefined ? null : String(loop.model),
      permission_mode: loop.permission_mode === undefined ? "auto" : String(loop.permission_mode),
      mode,
      // the main session's name: set when it is created, and how it is found again
      session_name: typeof loop.session_name === "string" && loop.session_name ? loop.session_name : (raw.name as string),
      schedule,
    },
    cadence,
    lock_max_minutes: pick(raw.lock_max_minutes, 60),
    liveness,
    runtime: { adapter: "herdr", agent: rt.agent as string },
    streams,
    repo_sync: pick(raw.repo_sync, "pull-on-clean"),
    wake: { files: wakeList },
    commit_paths: Array.isArray(raw.commit_paths) ? (raw.commit_paths as string[]) : [],
    sleep: isObj(raw.sleep)
      ? {
          after_minutes: pick(raw.sleep.after_minutes, DEFAULT_SLEEP.after_minutes),
          probe_minutes: pick(raw.sleep.probe_minutes, DEFAULT_SLEEP.probe_minutes),
          max_minutes: pick(raw.sleep.max_minutes, DEFAULT_SLEEP.max_minutes),
          compact: pick(raw.sleep.compact, DEFAULT_SLEEP.compact),
        }
      : null,
  };
}

export interface LoadedSettings {
  settings: Settings;
  /** The committed text, as read. */
  text: string;
}

export function parseSettingsText(text: string, where: string): { raw: Json | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: null, problems: [`${where} is not JSON: ${(e as Error).message}`] };
  }
  const problems = validateSettings(raw);
  return { raw: isObj(raw) ? raw : null, problems };
}

/**
 * The settings as committed at HEAD, with defaults. Throws a CANNOT_RUN error
 * (exit 2 at the edge) when the file is not committed or does not validate.
 */
export function loadSettings(root: string): LoadedSettings {
  const text = showHead(root, SETTINGS_FILE);
  if (text === null) {
    throw new AxiError(`${SETTINGS_FILE} is not committed in this checkout`, "CANNOT_RUN", [
      existsSync(join(root, SETTINGS_FILE))
        ? `Commit ${SETTINGS_FILE}: what runs is what was reviewed`
        : `Copy the skill's templates/opsbot.json to ${SETTINGS_FILE}, fill it in, and commit it`,
    ]);
  }
  const { raw, problems } = parseSettingsText(text, `${SETTINGS_FILE} at HEAD`);
  if (!raw || problems.length) {
    throw new AxiError(`${SETTINGS_FILE} at HEAD is not valid: ${problems.join("; ")}`, "CANNOT_RUN", [
      "Fix it, commit it, and run `settings validate`",
    ]);
  }
  return { settings: withDefaults(raw), text };
}

/** Settings at HEAD, else the working tree, else null. Never throws (home, gate). */
export function trySettings(root: string): Settings | null {
  const tryText = (text: string | null) => {
    if (text === null) return null;
    const { raw, problems } = parseSettingsText(text, SETTINGS_FILE);
    return raw && problems.length === 0 ? withDefaults(raw) : null;
  };
  const head = tryText(showHead(root, SETTINGS_FILE));
  if (head) return head;
  const p = join(root, SETTINGS_FILE);
  return existsSync(p) ? tryText(readFileSync(p, "utf8")) : null;
}
