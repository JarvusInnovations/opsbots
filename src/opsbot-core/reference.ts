/**
 * The single source of truth for what opsbot-core is and what it does. The
 * home view, `--help`, and the generated region of skills/opsbot-core/SKILL.md
 * all derive from this, so they cannot disagree.
 */

export const DESCRIPTION =
  "The ops-bot loop: one cycle at a time (lock, check every stream, act, end), the cycle log, outage accounting, cadence, cold start with a read-gate, and the watchdog and nudge that keep it alive";

export interface CommandRef {
  usage: string;
  summary: string;
}

export interface CommandGroup {
  group: string;
  commands: CommandRef[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  {
    group: "The cycle",
    commands: [
      {
        usage: "cycle begin",
        summary:
          "Refuse while another writer holds the checkout (exit 30, `wait · … · next <s>`); take the lock; record outages; run `cycle.d/begin/`; run the check. Exit 0 nothing new (lock released), 10 new, 20 degraded (lock kept until `cycle end`).",
      },
      {
        usage: "check [--no-commit]",
        summary:
          "Run every `opsbot.d/heartbeat.d/` script, record seen keys, log, commit. Exit 0 nothing new · 10 new (digest) · 20 degraded (failed inputs named) · 2 cannot run.",
      },
      {
        usage: "cycle end --records N [--degraded] [--summary TEXT]",
        summary:
          "Pin the watermark to this cycle's check time (refuses a future time, a backwards move, or no check since the lock); run `cycle.d/end/`; log `finished`; commit, push, release; print `next <s> <reason>`.",
      },
      { usage: "next-delay", summary: "Seconds until the next cycle and why, from the cycle log and the cadence table." },
    ],
  },
  {
    group: "Cold start",
    commands: [
      {
        usage: "cold-start [--write]",
        summary:
          "Print the reground pack: the rule card, each `wake.d/` section, the last 48 hours of the cycle log, the untrusted-memory line. `--write` also writes the pack file and sets the pending flag.",
      },
      {
        usage: "gate check",
        summary: "PreToolUse body: exit 0 when nothing is pending or this call reads the pack whole; otherwise deny (exit 2).",
      },
    ],
  },
  {
    group: "State",
    commands: [
      { usage: "lock status | lock release [--abandon]", summary: "Show the writer lock, or release it (another live process's only with `--abandon`)." },
      {
        usage: "outage record <kind> [--note TEXT] [--started ISO] [--ended ISO] | outage end | outage list",
        summary: "Record, close or list outages: failed-turn, refused, plan-limit, session-ended, stopped.",
      },
      { usage: "log tail [--n N]", summary: "The last N cycle-log lines (default 10)." },
    ],
  },
  {
    group: "Liveness (run by system timers)",
    commands: [
      { usage: "watchdog [--dry-run]", summary: "When no cycle has logged within `watchdog_minutes`, tell the operator once per outage through `escalate.d/` and record it." },
      {
        usage: "nudge [--now [--reason TEXT]] [--dry-run]",
        summary: "Re-issue `loop.prompt` to the named agent when the loop is quiet, unlocked, past cooldown and idle. `--now` (for monitors) skips the quiet test.",
      },
      {
        usage: "infra install|uninstall|status [--dry-run]",
        summary: "Render the watchdog and nudge timers and one unit per `monitor.d/` script from `opsbot.json`; `status` names stale units.",
      },
    ],
  },
  {
    group: "Setup",
    commands: [
      {
        usage: "hook install|uninstall|status [--scope project|global] [--dir PATH]",
        summary: "Register the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks; project scope by default.",
      },
      { usage: "hooks list [--point P]", summary: "Every script that will run at each lifecycle point, in order, with its source." },
      { usage: "settings validate [--head]", summary: "Refuse an `opsbot.json` with an unknown key, a missing required key, or a cadence over the cap." },
    ],
  },
];

/** The flat command reference, for --help. */
export function commandReferenceText(invocation: string): string {
  return COMMAND_GROUPS.map((g) => {
    const items = g.commands.map((c) => `  ${invocation} ${c.usage}\n      ${c.summary}`).join("\n");
    return `${g.group}:\n${items}`;
  }).join("\n\n");
}

/** Per-command help: every usage line whose first word is the command. */
export function commandHelp(command: string, invocation: string): string | undefined {
  const hits: CommandRef[] = [];
  for (const g of COMMAND_GROUPS) {
    for (const c of g.commands) {
      if (c.usage.split(/[ |]/)[0] === command) hits.push(c);
    }
  }
  if (hits.length === 0) return undefined;
  return `${hits.map((c) => `usage: ${invocation} ${c.usage}\n  ${c.summary}`).join("\n\n")}\n`;
}
