---
name: opsbot-core
description: >-
  The loop for an ops bot: run one cycle at a time (cycle begin → act → cycle end), check every
  stream without the model, keep the cycle log, watermark and seen keys in git, account for
  outages, pace the next wake, reground after a start or compaction behind a read-gate, and keep
  the loop alive with a watchdog and a nudge. Use when running, starting, debugging or setting up
  an ops bot's cycle; when a session starts or compacts in a bot repo; when the loop has stopped,
  a lock is stuck, a check is degraded, or the timers need installing. Triggers: "cycle begin",
  "run a cycle", "the loop stopped", "cold start", "reground", "next wake", "watchdog", "nudge",
  "opsbot.json", "opsbot.d", "heartbeat script".
---

# opsbot-core: the loop

One long-lived agent session in the bot's repo runs a self-paced cycle. A **cycle** is:
begin → check → act, or say nothing new → end → compute the next wake. The idle path is
one command and one line of output; the model is not involved until the check says there
is something to do.

If output shows a follow-up command starting with `opsbot-core`, run it as
`scripts/opsbot-core …` (from this skill's directory) or by the path the output printed —
the CLI is not on PATH.

## A cycle

1. **`scripts/opsbot-core cycle begin`.** It refuses while another writer holds the checkout
   (a rebase, merge, cherry-pick, revert or bisect in progress, `index.lock`, or another
   live cycle's lock) and prints `wait · <who> · next <seconds> <reason>`, exit 30: schedule
   the next wake for those seconds and stop. Otherwise it takes the lock, records an outage
   if the last one was abandoned or the loop was stopped, runs `opsbot.d/cycle.d/begin/`,
   and runs the check.
   - **Exit 0, nothing new.** One line ending `next <seconds> <reason>`. The check already
     logged, committed and advanced the watermark; the lock is released. Schedule the wake
     and stop.
   - **Exit 10, new.** The digest: every item whole, tagged with its conversation and
     `GROUP` or `DM`. A `gate_word: present` line flags the configured word; it is never
     judged here.
   - **Exit 20, degraded.** The failed inputs by name, then what could be read. Never treat
     it as nothing new: tell the operator what could not be read.
2. **Act.** Do the work the items ask for, through the bot's own tools. Anything longer than
   a cycle is acknowledged first.
3. **`scripts/opsbot-core cycle end --records <n>`** (add `--degraded` when an input failed).
   It pins the watermark to the time of this cycle's check, never to now, so anything that
   arrived mid-cycle is read next time. It refuses a future time, a backwards move, or a
   cycle with no check since the lock was taken. It runs `opsbot.d/cycle.d/end/`, logs
   `finished`, commits the log and watermark with `--only`, pushes, releases the lock, and
   prints the closing line, what the end scripts printed (due promises, fixes not yet told),
   and `next <seconds> <reason>`.
4. **Wake.** Schedule the next wake with the session's own self-pacing call, using the loop
   prompt verbatim. There is one clock: never create a cron or a second loop. The nudge is
   the only thing that restarts a stopped loop.

`scripts/opsbot-core next-delay` prints the wake on its own. The defaults: something arrived
in the last 15 minutes, 3 min; night, 45 min; something in the last hour, 10 min; quiet in
working hours, 10 min; quiet otherwise, 30 min; never over the cap (45 min, under the
one-hour cache). Every value and the hours are in `opsbot.json`.

## Cold start and compaction

`hook install` registers two Claude Code hooks. On every session start, resume, clear and
compaction, `cold-start --write` writes the reground pack to `~/.cache/<bot>/reground.md` and
sets a pending flag; until the pack has been **read whole** (a Read with no offset or limit),
`gate check` refuses every other tool. The pack, in order, within a byte budget:

1. the rule card, whole (`rule_card` in `opsbot.json`, read at `HEAD`)
2. one section per `opsbot.d/wake.d/` script (what is owed, open escalations, …), each cut
   to its share of the budget with `… N more lines`
3. the last 48 hours of the cycle log: counts, the longest gap, the last degraded cycle,
   outages
4. memory before this point is untrusted: open the source before saying

Read the whole pack, then start a cycle.

## The lifecycle directories (`opsbot.d/`)

The core keeps no list of what contributes to each point. Like `/etc/*.d`, it runs every
executable in the directory in lexical order (`NN-name`); dotfiles and non-executables are
skipped. A kit skill or the bot's own `bin/` extends the loop by dropping a script in.
`scripts/opsbot-core hooks list` shows what will run, in order, and where each came from.

| Directory | When | Contract |
| --- | --- | --- |
| `heartbeat.d/` | every check | one stream: print NDJSON items `{key, at, conv, kind: "group"\|"dm", from, text, …}`; `key` is the typed seen key (`chat:<conv>:<msg>`, `mail:<id>`, `log:<service>:<id>`); no lines = nothing new; non-zero = this input failed (its first stderr line is the reason) |
| `monitor.d/` | always on | a watcher (`<name>`, a service) or a probe (`<name>@5m`, a timer); wakes the loop with `$OPSBOT_CORE nudge --now` |
| `cycle.d/begin/` | after the lock, before the check | housekeeping such as a repo sync; non-zero aborts the cycle as degraded |
| `cycle.d/end/` | before the commit | what to show at the close; its stdout follows the closing line |
| `wake.d/` | every cold start | one section of the pack each |
| `escalate.d/` | when the core must reach the operator | the message on stdin; every script runs; at least one must succeed |

Every script gets `OPSBOT_ROOT`, `OPSBOT_CONFIG` (`opsbot.json` as committed at `HEAD`),
`OPSBOT_NAME`, `OPSBOT_MARK` and `OPSBOT_HOOK`; heartbeat scripts also get `OPSBOT_SINCE`
(the watermark less a 30-minute margin), `OPSBOT_SEEN` (the seen-key file) and
`OPSBOT_WATERMARK`. The core drops items already seen, so a heartbeat may over-report.

## Settings (`opsbot.json`)

One committed file holds every loop value; nothing is set twice. Copy
`templates/opsbot.json` to the repo root, fill it in, commit it, and run
`scripts/opsbot-core settings validate`. It refuses an unknown key, a missing required key
(`name`, `mark`, `loop.prompt`, `runtime.agent`), and a cadence value over the cap; a `//`
key is a comment. The check and every lifecycle script read the file as committed at
`HEAD`, so what runs is what was reviewed.

## State it keeps

| Path | What |
| --- | --- |
| `logs/cycle.jsonl` | one line per cycle: `{at, outcome, inputs, new, failed, watermark}`, or `{at, outcome: "finished", records, watermark, degraded}` |
| `logs/intake/seen`, `logs/intake/watermark` | typed seen keys; one UTC time |
| `logs/outages.jsonl` | outages and their ends |
| `.git/opsbot-cycle.lock` | the writer lock `{pid, session, started}`, never committed |

## Staying alive

`scripts/opsbot-core infra install` renders systemd user units from `opsbot.json`: the
**watchdog** (tells the operator once per outage through `escalate.d/` when no cycle has
logged within `watchdog_minutes`, and records it), the **nudge** (re-issues `loop.prompt`
to the named runtime agent when the loop is quiet, unlocked, past its cooldown and idle),
and one unit per `monitor.d/` script. `infra status` says which installed units no longer
match `opsbot.json`. The session must run as a named agent in the runtime (herdr) for the
nudge to reach it.

## Commands

<!-- BEGIN GENERATED: command-reference -->

### The cycle

- `scripts/opsbot-core cycle begin` — Refuse while another writer holds the checkout (exit 30, `wait · … · next <s>`); take the lock; record outages; run `cycle.d/begin/`; run the check. Exit 0 nothing new (lock released), 10 new, 20 degraded (lock kept until `cycle end`).
- `scripts/opsbot-core check [--no-commit]` — Run every `opsbot.d/heartbeat.d/` script, record seen keys, log, commit. Exit 0 nothing new · 10 new (digest) · 20 degraded (failed inputs named) · 2 cannot run.
- `scripts/opsbot-core cycle end --records N [--degraded] [--summary TEXT]` — Pin the watermark to this cycle's check time (refuses a future time, a backwards move, or no check since the lock); run `cycle.d/end/`; log `finished`; commit, push, release; print `next <s> <reason>`.
- `scripts/opsbot-core next-delay` — Seconds until the next cycle and why, from the cycle log and the cadence table.

### Cold start

- `scripts/opsbot-core cold-start [--write]` — Print the reground pack: the rule card, each `wake.d/` section, the last 48 hours of the cycle log, the untrusted-memory line. `--write` also writes the pack file and sets the pending flag.
- `scripts/opsbot-core gate check` — PreToolUse body: exit 0 when nothing is pending or this call reads the pack whole; otherwise deny (exit 2).

### State

- `scripts/opsbot-core lock status | lock release [--abandon]` — Show the writer lock, or release it (another live process's only with `--abandon`).
- `scripts/opsbot-core outage record <kind> [--note TEXT] [--started ISO] [--ended ISO] | outage end | outage list` — Record, close or list outages: failed-turn, refused, plan-limit, session-ended, stopped.
- `scripts/opsbot-core log tail [--n N]` — The last N cycle-log lines (default 10).

### Liveness (run by system timers)

- `scripts/opsbot-core watchdog [--dry-run]` — When no cycle has logged within `watchdog_minutes`, tell the operator once per outage through `escalate.d/` and record it.
- `scripts/opsbot-core nudge [--now [--reason TEXT]] [--dry-run]` — Re-issue `loop.prompt` to the named agent when the loop is quiet, unlocked, past cooldown and idle. `--now` (for monitors) skips the quiet test.
- `scripts/opsbot-core infra install|uninstall|status [--dry-run]` — Render the watchdog and nudge timers and one unit per `monitor.d/` script from `opsbot.json`; `status` names stale units.

### Setup

- `scripts/opsbot-core hook install|uninstall|status [--scope project|global] [--dir PATH]` — Register the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks; project scope by default.
- `scripts/opsbot-core hooks list [--point P]` — Every script that will run at each lifecycle point, in order, with its source.
- `scripts/opsbot-core settings validate [--head]` — Refuse an `opsbot.json` with an unknown key, a missing required key, or a cadence over the cap.

<!-- END GENERATED: command-reference -->
