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
          "Refuse while another writer holds the checkout (exit 30, `wait · … · next <s>`); take the lock; record outages; run `cycle.d/begin/`; run the check. Exit 0 nothing new (lock released), 10 new, 20 degraded (lock kept until `cycle end`). With `wake.files` set, a `wake` field says whether the live-wake monitor is armed and prints the call that arms it. With `loop.schedule: monitor`, on 0 and 30 the `wake` field holds the schedule monitor's state and the one Monitor call to make now.",
      },
      {
        usage: "check [--no-commit]",
        summary:
          "Run every `opsbot.d/heartbeat.d/` script, record seen keys, log, commit. Exit 0 nothing new · 10 new (digest) · 20 degraded (failed inputs named) · 2 cannot run.",
      },
      {
        usage: "cycle end --records N [--degraded] [--summary TEXT]",
        summary:
          "Pin the watermark to this cycle's check time (refuses a future time, a backwards move, or no check since the lock); run `cycle.d/end/`; log `finished`; commit, push, release; print `next <s> <reason>` and, with `wake.files` set, the `wake` field with the monitor's deadline bounded by that next wake. With `loop.schedule: monitor`, the `wake` field holds the one schedule Monitor call (exits on a wake-file line or `cycle due`), and nothing else schedules the next cycle.",
      },
      {
        usage: "check --peek",
        summary:
          "Run every heartbeat script as a check does (each also gets `OPSBOT_PEEK=1`) and print the count of new items per input. Records, logs and commits nothing; the watermark and seen keys are untouched, so the next check sees the same items. Exit 0 · 10 · 20 · 2 as `check`.",
      },
      { usage: "next-delay", summary: "Seconds until the next cycle and why, from the cycle log and the cadence table. With `loop.schedule: monitor`, never over 1740 (29 min), and the reason says when that cap applied." },
    ],
  },
  {
    group: "Cold start",
    commands: [
      {
        usage: "start [--continue] [--dry-run] [-- <extra claude args>]",
        summary:
          "Launch the bot's Claude Code session with the flags opsbot.json implies: permission mode (default auto), model, autocompact window, autocompact forced on, and `loop.prompt` as the first message. `--continue` resumes the last session in this checkout. A bot's `bin/start` shim calls this.",
      },
      {
        usage: "cold-start [--write]",
        summary:
          "Print the reground pack: the rule card, the kit's sections (house style, delegation, what the session log says, the live wake to arm), each `wake.d/` section, the last 48 hours of the cycle log, the untrusted-memory line. `--write` also makes sure `.scratch/` exists and is git-excluded, writes the pack to `.scratch/opsbot-core/reground.md`, sets the pending flag and records the session log's path for `cycle` and `nudge`.",
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
        summary: "Re-issue `loop.prompt` to the named agent when the loop is quiet, unlocked, past cooldown and idle. `--now` (for listeners) skips the quiet test. A `working` agent whose own session log shows its turn ended (background work only) is prompted anyway, with a note.",
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
