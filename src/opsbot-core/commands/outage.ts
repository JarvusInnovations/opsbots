/**
 * outage — record a time the loop was not running. Appends to
 * logs/outages.jsonl; does not commit (the next cycle's commit carries it).
 *
 *   failed-turn    a turn ended mid-cycle (an API error, a crash)
 *   refused        a command or a hook refused, and the cycle stopped
 *   plan-limit     the plan's usage limit ran out
 *   session-ended  the session went away
 *   stopped        no cycle logged, cause not known (what the watchdog sees)
 *
 * The note says what was seen, not a guessed cause.
 */
import { AxiError } from "axi-sdk-js";
import { parseArgs, usageError } from "../args.js";
import { ISO_RE, nowIso, parseIso, requireRoot } from "../repo.js";
import { OUTAGE_KINDS, openOutage, outages, recordOutage, recordOutageEnd, type OutageKind } from "../state.js";

export const OUTAGE_USAGE = "outage record <kind> [--note TEXT] [--started ISO] [--ended ISO] | outage end [--ended ISO] | outage list";

function isoFlag(v: string | boolean | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !ISO_RE.test(v) || parseIso(v) === null) {
    throw usageError(`--${name} needs an ISO-8601 UTC time like 2026-01-31T14:05:00Z`, OUTAGE_USAGE);
  }
  return v;
}

export function outageCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub === "record") {
    const { positionals, flags } = parseArgs(rest, { value: ["note", "started", "ended"], maxPositionals: 1 }, OUTAGE_USAGE);
    const kind = positionals[0];
    if (!kind || !(OUTAGE_KINDS as readonly string[]).includes(kind)) {
      throw usageError(`the kind must be one of ${OUTAGE_KINDS.join(", ")}`, OUTAGE_USAGE);
    }
    const root = requireRoot();
    const started = isoFlag(flags.started, "started") ?? nowIso();
    const ended = isoFlag(flags.ended, "ended") ?? null;
    const note = typeof flags.note === "string" ? flags.note : "";
    recordOutage(root, { kind: kind as OutageKind, started, ended, note });
    return { outage: `recorded · ${kind} · started ${started}${ended ? ` · ended ${ended}` : " · open"}` };
  }
  if (sub === "end") {
    const { flags } = parseArgs(rest, { value: ["ended"] }, OUTAGE_USAGE);
    const root = requireRoot();
    const open = openOutage(root);
    if (!open) return { outage: "no open outage (no-op)" };
    const ended = isoFlag(flags.ended, "ended") ?? nowIso();
    recordOutageEnd(root, open, ended);
    return { outage: `ended · started ${open} · ended ${ended}` };
  }
  if (sub === "list") {
    parseArgs(rest, {}, OUTAGE_USAGE);
    const root = requireRoot();
    const all = outages(root);
    if (all.length === 0) return { outages: "0 outages recorded" };
    const open = all.filter((o) => o.ended === null).length;
    return {
      count: `${all.length} outages · ${open} open`,
      outages: all.map((o) => ({ kind: o.kind, started: o.started, ended: o.ended ?? "OPEN", note: o.note })),
    };
  }
  throw new AxiError(sub ? `unknown outage subcommand ${sub}` : "outage needs a subcommand", "VALIDATION_ERROR", [OUTAGE_USAGE]);
}
