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

export interface Settings {
  name: string;
  mark: string;
  timezone: string;
  rule_card: string | null;
  gate_word: string | null;
  loop: { prompt: string; autocompact: string | null };
  cadence: Cadence;
  lock_max_minutes: number;
  liveness: Liveness;
  runtime: { adapter: "herdr"; agent: string };
  streams: Record<string, Record<string, unknown>>;
  repo_sync: "pull-on-clean" | "never-pull";
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
    allow(loop, "loop.", ["prompt", "autocompact"]);
    str(loop, "prompt", "loop.", true);
    const ac = loop.autocompact;
    if (ac !== undefined && !(typeof ac === "string" && ac !== "") && !(typeof ac === "number" && ac > 0)) {
      problems.push("loop.autocompact must be a window such as \"300k\" or a number");
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
  const liveness = Object.fromEntries(
    LIVENESS_KEYS.map((k) => [k, pick(lv[k], DEFAULT_LIVENESS[k])]),
  ) as unknown as Liveness;
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
      autocompact: loop.autocompact === undefined ? null : String(loop.autocompact),
    },
    cadence,
    lock_max_minutes: pick(raw.lock_max_minutes, 60),
    liveness,
    runtime: { adapter: "herdr", agent: rt.agent as string },
    streams,
    repo_sync: pick(raw.repo_sync, "pull-on-clean"),
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
