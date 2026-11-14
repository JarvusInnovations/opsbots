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
     judged here. `present, does not count: <why>` means the adapter said the item's author
     cannot give it (another bot's message): it approves nothing.
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
4. **Wake.** `loop.schedule` in `opsbot.json` says how. There is one clock either way:
   never create a cron or a second loop. The nudge is the only thing that restarts a
   stopped loop.
   - **`self`** (the default). Schedule the next wake with the session's own self-pacing
     call, using the loop prompt verbatim.
   - **`monitor`**. `cycle begin` (on 0 or 30) and `cycle end` print a `wake` field with one
     `Monitor` call. Make it exactly as printed. It exits on a new line in a wake file or
     with `cycle due` when the next cycle is due; either way, run `cycle begin`. Never call
     ScheduleWakeup and never start `/loop`; the loop prompt is a plain message. Never two
     monitors. If none is armed (after a start, a compaction, an error), run `cycle begin`.
5. **Sleep** (only with `sleep` set, which needs `loop.schedule: monitor`). After
   `after_minutes` with nothing found and no message from the operator, and nothing from
   `opsbot.d/due.d/` due within that long, `cycle begin` or `cycle end` prints a `sleep`
   field in place of `wake`. Then arm no monitor, schedule nothing, and end the turn. The
   sleep timer compacts the idle session and wakes it later by typing the loop prompt with
   `(woken: <reason>)` after it: a wake-file line, a stream that `check --peek` finds new or
   failing, the due time, or `max_minutes`. Treat the wake as any other: read the pack if
   the gate asks, then run `cycle begin`.

`scripts/opsbot-core next-delay` prints the wake on its own. The defaults: something arrived
in the last 15 minutes, 3 min; night, 45 min; something in the last hour, 10 min; quiet in
working hours, 10 min; quiet otherwise, 30 min; never over the cap (45 min, under the
one-hour cache), and with `loop.schedule: monitor` never over 29 min (a monitor's limit). Every value and the hours are in `opsbot.json`.

## Cold start and compaction

`hook install` registers two Claude Code hooks. On every session start, resume, clear and
compaction, `cold-start --write` writes the reground pack to `.scratch/opsbot-core/reground.md`
in the bot's checkout and sets a pending flag; until the pack has been **read whole** (a Read with no offset or limit),
`gate check` refuses every other tool. The pack, in order:

1. the rule card, whole (`rule_card` in `opsbot.json`, read at `HEAD`)
2. one section per `opsbot.d/wake.d/` script (what is owed, open escalations, …), each cut
   to its share of the wake budget (6 000 bytes across them all) with `… N more lines`
3. the last 48 hours of the cycle log: counts, the longest gap, the last degraded cycle,
   outages, one line when the memory review is due, and a few naming the other due routines
4. memory before this point is untrusted, the auto-memory files included: open the source
   before saying

Read the whole pack, then start a cycle.

## The lifecycle directories (`opsbot.d/`)

The core keeps no list of what contributes to each point. Like `/etc/*.d`, it runs every
executable in the directory in lexical order (`NN-name`); dotfiles and non-executables are
skipped. A kit skill or the bot's own `bin/` extends the loop by dropping a script in.
`scripts/opsbot-core hooks list` shows what will run, in order, and where each came from.

| Directory | When | Contract |
| --- | --- | --- |
| `heartbeat.d/` | every check | one stream: print NDJSON items `{key, at, conv, kind: "group"\|"dm", from, text, …}`; `key` is the typed seen key (`chat:<conv>:<msg>`, `mail:<id>`, `log:<service>:<id>`); optional `keys` lists more seen keys the item stands for (a digest row for a group of events; new when any key is unseen, all recorded when reported); optional `report: false` records the keys as seen without showing the item (the bot's own messages); no lines = nothing new; non-zero = this input failed (its first stderr line is the reason) |
| `monitor.d/` | always on | a watcher (`<name>`, a service) or a probe (`<name>@5m`, a timer); wakes the loop with `$OPSBOT_CORE nudge --now` |
| `cycle.d/begin/` | after the lock, before the check | housekeeping such as a repo sync; non-zero aborts the cycle as degraded |
| `cycle.d/end/` | before the commit | what to show at the close; its stdout follows the closing line |
| `wake.d/` | every cold start | one section of the pack each |
| `escalate.d/` | when the core must reach the operator | the message on stdin; every script runs; at least one must succeed |
| `due.d/` | when a sleep is being decided | one line per thing due, `<ISO time> <what>`; the earliest is the sleep's wake time; a failure or a line with no time keeps the bot awake. The core adds the next time each routine becomes due |

Every script gets `OPSBOT_ROOT`, `OPSBOT_CONFIG` (`opsbot.json` as committed at `HEAD`),
`OPSBOT_NAME`, `OPSBOT_MARK` and `OPSBOT_HOOK`; heartbeat scripts also get `OPSBOT_SINCE`
(the watermark less a 30-minute margin), `OPSBOT_SEEN` (the seen-key file) and
`OPSBOT_WATERMARK`. The core drops items already seen, so a heartbeat may over-report.
`check --peek` runs the heartbeat scripts with `OPSBOT_PEEK=1` and records nothing; a
heartbeat that keeps state of its own (a baseline it updates) must leave it alone then.

## Settings (`opsbot.json`)

One committed file holds every loop value; nothing is set twice. Copy
`templates/opsbot.json` to the repo root, fill it in, commit it, and run
`scripts/opsbot-core settings validate`. It refuses an unknown key, a missing required key
(`name`, `mark`, `loop.prompt`, `runtime.agent`), and a cadence value over the cap; a `//`
key is a comment. The check and every lifecycle script read the file as committed at
`HEAD`, so what runs is what was reviewed.

`sleep` (optional) is `{after_minutes, probe_minutes, max_minutes, compact}`, defaults 60,
10, 480 and `true`, and is refused unless `loop.schedule` is `monitor`. Absent, the bot
never sleeps and nothing below about sleep applies. It is a trial setting: it has run on a
test bot, not yet for a week on a working one, so turn it on for one bot and read its log
before relying on it.

`commit_paths` (optional) lists repo-relative files the check's commit and the `cycle end`
commit also take when they exist and have changes: a baseline an adapter updates, an
append-only log a helper script writes between cycles. Nothing else is added to those
commits. It refuses an absolute path, a `..` segment, and a path under `.git/` or `.claude/`.

`memory` (optional) is `{dir, review_days}`, defaults `memory` and `7`, or `false`. See
*Auto memory* below.

`routines` (optional) is `{dir, runs_dir}`, defaults `routines` and `records/routine-runs`.
See *Routines* below.

## State it keeps

| Path | What |
| --- | --- |
| `logs/cycle.jsonl` | one line per cycle: `{at, outcome, inputs, new, failed, watermark}`, or `{at, outcome: "finished", records, watermark, degraded}` |
| `logs/intake/seen`, `logs/intake/watermark` | typed seen keys; one UTC time |
| `logs/outages.jsonl` | outages and their ends |
| `.git/opsbot-cycle.lock` | the writer lock `{pid, session, started}`, never committed |
| `memory/` (`memory.dir`) | the session's auto memory: `MEMORY.md` and one file per memory; committed with the cycles |
| `.git/opsbot-memory-review.json` | the snapshot a memory review diffs against; never committed |
| `routines/` (`routines.dir`) | the routine definitions, one markdown file each; read at `HEAD`; changed only through review |
| `records/routine-runs/` (`routines.runs_dir`) | one record per run, under `YYYY/MM/`; committed with the cycles |
| `.git/opsbot-sleep` | while going down, asleep, or woken and not yet answered; removed by `cycle begin`; never committed. The log gets `sleep` and `wake` lines, and its readers treat the span between them as intended silence |

## Staying alive

`scripts/opsbot-core infra install` renders systemd user units from `opsbot.json`: the
**watchdog** (tells the operator once per outage through `escalate.d/` when no cycle has
logged within `watchdog_minutes`, and records it), the **nudge** (re-issues `loop.prompt`
to the named runtime agent when the loop is quiet, unlocked, past its cooldown and idle),
and one unit per `monitor.d/` script. With `sleep` set it adds the **sleep timer**
(`sleep tick` every `probe_minutes`): it compacts a session told to sleep once it is idle,
wakes it when there is something to do, and tells the operator once about a wake no
`cycle begin` answered within `watchdog_minutes`. While the bot sleeps, the nudge (without
`--now`) and the watchdog stand down. `infra status` says which installed units no longer
match `opsbot.json`, and with `sleep` set, the sleep state. The session must run as a named agent in the runtime (herdr) for the
nudge to reach it.

## Commands


## What the kit puts in every cold start

`references/pack/*.md` ship with this skill and are read into the reground pack right
after the rule card, whole, at every start, resume, clear and compaction: the house
writing style (`10-writing.md`: tone, shape, Slack mrkdwn, email, records, logs) and the
delegation rubric (`20-delegation.md`: which model class earns which work, and what the
loop keeps for itself), how to read the digest (`30-digest.md`), where scratch files go
(`40-scratch.md`), how routines work (`45-routines.md`, only when the bot has a routine
definition) and what memory files are for (`50-memory.md`, only while auto memory is on). They update with `npx skills update`, so no bot copies them into
its CLAUDE.md.

## The scratch directory

Every bot's checkout has a `.scratch/` directory for files written to look at and throw
away. `cold-start --write` creates it at every start, resume, clear and compaction, and adds
a `.scratch/` line to the repository's `info/exclude` (found through
`git rev-parse --git-path`, so a worktree checkout works), never to `.gitignore`. Both steps
run only when needed. The pack lives in `.scratch/opsbot-core/`, inside the working
directory, so the gate's required read needs no permission beyond the checkout. A pending
flag left at the pack's earlier home, `~/.cache/<bot>/`, is honored once: a whole read of
the old pack clears it, and the next `cold-start --write` removes it. The old pack file is
left where it is; delete it by hand when you like. A bot's own `specs/persona.md` colors the style and never overrides it.

## Auto memory

Claude Code's auto memory is a folder of small notes the model writes on its own: an index,
`MEMORY.md`, loaded at every session start, and one file per memory. A bot keeps that folder
in its repo, so it is versioned, reviewable, and moves with the bot.

- `start` passes `autoMemoryEnabled: true` and `autoMemoryDirectory` (the absolute path of
  `memory.dir`) in its one `--settings` object, and creates the directory when it is
  missing. `memory: false` turns auto memory off instead. No setting leaves it at Claude
  Code's default location, so launch the bot with `start`.
- The check's commit and the `cycle end` commit take every changed file under the directory,
  new, modified or deleted, and nothing else. Memory written between cycles is committed at
  the next one.
- Every `review_days` (7) a review is due. The review is the built-in routine
  `memory-review`: when due it is one item in the check, `cycle end` prints one `memory` line
  with the command, and the cold-start pack carries one line; none blocks a cycle. Run
  `scripts/opsbot-core memory review --begin`, work the worksheet (each file is folded,
  updated, kept or pruned, as `references/memory-review.md` says), then
  `scripts/opsbot-core memory review --done --note "<what was folded where>"`. The count puts
  folded and pruned files together as `removed`; the note says which was which.
- A bot that ran before this setting brings its old notes in with
  `scripts/opsbot-core memory import ~/.claude/projects/<encoded path>/memory --dry-run`,
  then without `--dry-run`, and reviews them.

## Routines

Recurring work the bot owes on a schedule. **Definitions are the bot's program; runs are its
record.** They live apart.

- A definition is `routines/<id>.md`: TOML frontmatter between `+++` lines holds the
  schedule, the body holds the instructions (what to check, what done looks like, who gets
  what). Keys: `id` (the file's name), `title`, then one schedule, either an interval
  (`cadence = "daily"`, `"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"`, or
  `every = "10d"`) or a preferred time (`at = "08:30"` with `days = [1, 2, 3, 4, 5]`, ISO
  weekdays, in `timezone`); optional `since` (a date or time counting starts from),
  `active` (default `true`), `owner`, `hands_to`. Start from
  `templates/routines/weekly-backup-check.md`; check with `routines validate`.
- **Due is computed, never stored.** An interval routine is due once its interval has
  passed since its newest run (or `since`; with neither, at once). A slot routine is due
  when its latest slot at or before now has no run at or after it.
- A due routine is **one item** in the check, keyed by the occurrence
  (`routine:<id>:after:<last run>` or `routine:<id>:slot:<slot time>`), so it is reported
  once, not every cycle. `cycle end` lists due routines in a `routines` field, the pack
  names them, `check --peek` sees them, and the sleep decision wakes the bot for the next
  slot. A bot with no definitions reads exactly as before.
- Do the work as the body says (`routines view <id>`), then record it:
  `routines done <id> --notes "…" [--outcome partial|skipped|blocked] [--checked ITEM]...
  [--handed-to WHO]`. The run record lands in `records/routine-runs/YYYY/MM/` and rides the
  next cycle's commit. `routines history <id>` shows the runs and the missed stretches.
- **Definitions are governed.** A change to `routines/` changes what the bot does, so it goes
  through the same review as the rule card. The core reads definitions at `HEAD` and never
  writes to `routines/`; the bot never edits them on its own.
- The files are gitsheets markdown records. `templates/gitsheets/routines.toml` and
  `routine-runs.toml` are optional sheet configs to install under `.gitsheets/` for querying
  with gitsheets; the core needs no other tool.
- **Built in:** `memory-review` (every `memory.review_days`, instructions
  `references/memory-review.md`) exists while memory is on. A `routines/memory-review.md`
  overrides it.

<!-- BEGIN GENERATED: command-reference -->

### The cycle

- `scripts/opsbot-core cycle begin` — Refuse while another writer holds the checkout (exit 30, `wait · … · next <s>`); take the lock; record outages; run `cycle.d/begin/`; run the check. Exit 0 nothing new (lock released), 10 new, 20 degraded (lock kept until `cycle end`). With `wake.files` set, a `wake` field says whether the live-wake monitor is armed and prints the call that arms it. With `loop.schedule: monitor`, on 0 and 30 the `wake` field holds the schedule monitor's state and the one Monitor call to make now. With `sleep` set, a nothing-new begin that finds the loop quiet for `after_minutes` prints a `sleep` field in place of `wake`: arm nothing, end the turn. A begin that finds `.git/opsbot-sleep` removes it and logs the wake.
- `scripts/opsbot-core check [--no-commit]` — Run every `opsbot.d/heartbeat.d/` script and the core's `routines` input (one item per due routine occurrence), record seen keys, log, commit. Exit 0 nothing new · 10 new (digest) · 20 degraded (failed inputs named) · 2 cannot run.
- `scripts/opsbot-core cycle end --records N [--degraded] [--summary TEXT]` — Pin the watermark to this cycle's check time (refuses a future time, a backwards move, or no check since the lock); run `cycle.d/end/`; log `finished`; commit, push, release; print `next <s> <reason>` and, with `wake.files` set, the `wake` field with the monitor's deadline bounded by that next wake. With `loop.schedule: monitor`, the `wake` field holds the one schedule Monitor call (exits on a wake-file line or `cycle due`), and nothing else schedules the next cycle. With `sleep` set, a `sleep` field may replace `wake`, as at `cycle begin`. When the memory review is due, one `memory` line says so with the command to run, and a `routines` field names each other due routine; neither blocks the cycle.
- `scripts/opsbot-core check --peek` — Run every heartbeat script and the `routines` input as a check does (each script also gets `OPSBOT_PEEK=1`) and print the count of new items per input. Records, logs and commits nothing; the watermark and seen keys are untouched, so the next check sees the same items. Exit 0 · 10 · 20 · 2 as `check`.
- `scripts/opsbot-core next-delay` — Seconds until the next cycle and why, from the cycle log and the cadence table. With `loop.schedule: monitor`, never over 1740 (29 min), and the reason says when that cap applied.

### Cold start

- `scripts/opsbot-core start [--continue] [--dry-run] [-- <extra claude args>]` — Launch the bot's Claude Code session with the flags opsbot.json implies: permission mode (default auto), model, autocompact window, autocompact forced on, auto memory in the repo (`autoMemoryDirectory` set to `memory.dir` as an absolute path, created when missing; off with `memory: false`), and `loop.prompt` as the first message. `--continue` resumes the last session in this checkout. A bot's `bin/start` shim calls this.
- `scripts/opsbot-core cold-start [--write]` — Print the reground pack: the rule card, the kit's sections (house style, delegation, what the session log says, the live wake to arm), each `wake.d/` section, the last 48 hours of the cycle log (with one line when the memory review is due and a few naming the other due routines), the untrusted-memory line; the routines section rides when the bot has a routine definition. `--write` also makes sure `.scratch/` exists and is git-excluded, writes the pack to `.scratch/opsbot-core/reground.md`, sets the pending flag and records the session log's path for `cycle` and `nudge`.
- `scripts/opsbot-core gate check` — PreToolUse body: exit 0 when nothing is pending or this call reads the pack whole; otherwise deny (exit 2).

### State

- `scripts/opsbot-core lock status | lock release [--abandon]` — Show the writer lock, or release it (another live process's only with `--abandon`).
- `scripts/opsbot-core outage record <kind> [--note TEXT] [--started ISO] [--ended ISO] | outage end | outage list` — Record, close or list outages: failed-turn, refused, plan-limit, session-ended, stopped.
- `scripts/opsbot-core log tail [--n N]` — The last N cycle-log lines (default 10).

### Memory

- `scripts/opsbot-core memory status` — The repo's auto-memory directory (`memory.dir`): memory files, their bytes, the `MEMORY.md` index's size, the oldest unreviewed file's age, the last review, and whether one is due (`review_days` after the last run of the `memory-review` routine, or, never reviewed, after the oldest file).
- `scripts/opsbot-core memory review --begin | memory review --done [--note TEXT]` — `--begin` snapshots the directory under `.git/` and prints the worksheet: one row per file (name, frontmatter `type`, bytes, age, changed since the last review), the protocol, and the path of `references/memory-review.md`. `--done` diffs against the snapshot, records a run of the `memory-review` routine and logs `memory-review` with `kept`, `updated`, `removed` (folded or pruned) and `added`; say in `--note` what was folded where.
- `scripts/opsbot-core memory import <path> [--dry-run]` — Copy memory files from another directory (Claude Code's default location) into `memory.dir`: never overwrites (a different file of the same name is a reported clash), merges `MEMORY.md` index lines without duplicates, reads nothing but `<path>`. The next cycle commits them.

### Routines

- `scripts/opsbot-core routines [due [--all]]` — The routines due now (definitions in `routines.dir` at HEAD, plus the built-in `memory-review` while memory is on): id, title, schedule, since when, last run. `--all` lists every routine with its state, last run, next due time and source. Exit 1 when a definition or run record is invalid (named).
- `scripts/opsbot-core routines view <id>` — One routine: schedule, source (a file at HEAD, or built in), state, last run, and its instructions, the definition's body.
- `scripts/opsbot-core routines history <id>` — The routine's runs in order with outcome, days since the one before and any missed stretch or slots; then the time since the last and whether it is due.
- `scripts/opsbot-core routines done <id> --notes TEXT [--outcome done|partial|skipped|blocked] [--checked ITEM]... [--handed-to WHO] [--at ISO]` — Record one run under `routines.runs_dir` (`YYYY/MM/<id>.md`), committed with the next cycle; prints when the routine is next due. Refuses an unknown or inactive routine, empty notes, an unknown outcome or a future `--at`. Never touches the definitions.
- `scripts/opsbot-core routines validate [--head]` — Parse every definition (working tree, or HEAD) and run record and name each problem: unparseable file, unknown key, bad or mismatched id, duplicate id, bad cadence, both or neither of interval and slot, a slot without days, bad time, day or `since`.

### Liveness (run by system timers)

- `scripts/opsbot-core watchdog [--dry-run]` — When no cycle has logged within `watchdog_minutes`, tell the operator once per outage through `escalate.d/` and record it. Stands down while the bot sleeps.
- `scripts/opsbot-core nudge [--now [--reason TEXT]] [--dry-run]` — Re-issue `loop.prompt` to the named agent when the loop is quiet, unlocked, past cooldown and idle. `--now` (for listeners) skips the quiet test. A `working` agent whose own session log shows its turn ended (background work only) is prompted anyway, with a note. While the bot sleeps only `--now` acts, and it wakes it.
- `scripts/opsbot-core sleep tick [--dry-run]` — The sleep timer's tick (only with `sleep` set; a no-op while awake). Going down: types `/compact` once the session is idle. Asleep: wakes it with `<loop.prompt> (woken: <reason>)` on an operator message, a wake-file line, the due time, `max_minutes`, or a `check --peek` exit of 10 or 20. A wake no `cycle begin` answers within `watchdog_minutes` is told once through `escalate.d/`. Exit 1 when the runtime or the operator could not be reached.
- `scripts/opsbot-core infra install|uninstall|status [--dry-run]` — Render the watchdog and nudge timers, one unit per `monitor.d/` script, and with `sleep` set the sleep timer, from `opsbot.json`; `status` names stale units and the sleep state.

### Setup

- `scripts/opsbot-core hook install|uninstall|status [--scope project|global] [--dir PATH]` — Register the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks; project scope by default.
- `scripts/opsbot-core hooks list [--point P]` — Every script that will run at each lifecycle point, in order, with its source.
- `scripts/opsbot-core settings validate [--head]` — Refuse an `opsbot.json` with an unknown key, a missing required key, a cadence over the cap, or a `memory.dir` or `routines` directory outside the repo; a `.claude/settings.json` that sets auto memory itself; and any invalid routine definition.

<!-- END GENERATED: command-reference -->
