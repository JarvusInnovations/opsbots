---
name: opsbot-core
description: >-
  The loop for an ops bot: run one cycle at a time (cycle begin → act → cycle end), check every
  stream without the model, keep the cycle log, watermark and seen keys on a log branch, account for
  outages, pace the next wake, reground after a start or compaction behind a read-gate, and keep
  the loop alive with a watchdog and a nudge. Use when running, starting, debugging or setting up
  an ops bot's cycle; when a session starts or compacts in a bot repo; when the loop has stopped,
  a lock is stuck, a check is degraded, or the timers need installing. Triggers: "cycle begin",
  "run a cycle", "the loop stopped", "cold start", "reground", "next wake", "watchdog", "nudge",
  "opsbot.json", "opsbot.d", "heartbeat script", "log migrate", "log branch".
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
   the next wake for those seconds and stop. A checkout still set up for the old log files
   is refused, exit 2, naming `log migrate` (see *Moving a bot to the log branch*). Otherwise
   it takes the lock, fast-forwards a clean checkout that is behind its remote
   (`repo_sync`), records an outage if the last one was abandoned or the loop was stopped,
   runs `opsbot.d/cycle.d/begin/`, and runs the check. A wake from a wake file that names its inputs runs a **fast check**
   (see *A fast cycle* below); `cycle begin --full` forces the full one.
   - **Exit 0, nothing new.** One line ending `next <seconds> <reason>`. The check already
     logged it to the log branch and advanced the watermark; the lock is released. Schedule the wake
     and stop.
   - **Exit 10, new.** The digest: every item whole, tagged with its conversation and
     `GROUP` or `DM`. A `gate_word: present` line flags the configured word; it is never
     judged here. `present, does not count: <why>` means the adapter said the item's author
     cannot give it (another bot's message): it approves nothing.
   - **Exit 20, degraded.** The failed inputs by name, then what could be read. Never treat
     it as nothing new: tell the operator, in their channel, what could not be read.
2. **Act.** Do the work the items ask for, through the bot's own tools. Anything longer than
   a cycle is acknowledged first.
3. **`scripts/opsbot-core cycle end --records <n>`** (add `--degraded` when an input failed).
   It pins the watermark to the time of this cycle's check, never to now, so anything that
   arrived mid-cycle is read next time. It refuses a future time, a backwards move, or a
   cycle with no check since the lock was taken. It runs `opsbot.d/cycle.d/end/`, logs
   `finished`, writes the cycle to the log branch as one commit, pushes it, releases the lock, and
   prints the closing line, what the end scripts printed (due promises, fixes not yet told),
   and `next <seconds> <reason>`. When a wake file gained lines while you worked it prints
   `arrived: <n> on <file>` and `next 0 arrived` and no `wake` field: run `cycle begin`
   again in the same turn and arm nothing. When the work of a cycle is one command, chain
   `cycle end` after it in the same call (`<the command> && scripts/opsbot-core cycle end
   --records 1`), and end the turn with one status line or nothing: the terminal is a log,
   not a channel (see *The console, and the record*).
4. **Wake.** `loop.schedule` in `opsbot.json` says how. There is one clock either way:
   never create a cron or a second loop. The nudge is the only thing that restarts a
   stopped loop.
   - **`self`** (the default). Schedule the next wake with the session's own self-pacing
     call, using the loop prompt verbatim.
   - **`monitor`**. `cycle begin` (on 0 or 30) and `cycle end` print a `wake` field with one
     `Monitor` call, `Monitor({ command: "<path>/opsbot-core wake wait --until <epoch>",
     description: "<bot> schedule", timeout_ms: … })`. Make it exactly as printed. The
     poller is the core's own `wake wait`. It exits on a new line in a wake file or
     with `cycle due` when the next cycle is due; either way, run `cycle begin`. It starts
     from where the last check read to, so a line that arrived after that check began, while
     you worked or before you armed it, is delivered the moment it is armed. Never call
     ScheduleWakeup and never start `/loop`; the loop prompt is a plain message. Never two
     monitors. If none is armed (after a start, a compaction, an error), run `cycle begin`.
5. **Sleep** (only with `sleep` set, which needs `loop.schedule: monitor`). After
   `after_minutes` with nothing found and no message from the operator, and nothing from
   `opsbot.d/due.d/` due within that long, `cycle begin` or `cycle end` prints a `sleep`
   field in place of `wake`. Then arm no monitor, schedule nothing, and end the turn. The
   sleep timer compacts the idle session and wakes it later by typing the loop prompt with
   `(woken: <reason>)` after it: a wake-file line, a stream that `check --peek` finds new or
   failing, the due time, `max_minutes`, or a prompt the operator typed into the session (a
   slash command typed there, such as `/compact` or `/context`, is not one). Treat the wake
   as any other: read the pack if the gate asks, then run `cycle begin`.

### A fast cycle

A wake from a chat line should be answered in seconds, not after every other input has been
read. An entry of `wake.files` may name the `heartbeat.d/` scripts that read it:
`{ "file": "<path>", "inputs": ["20-slack-events"] }` (a bare path names none; the channel
skills' `install` prints the object form). `cycle begin` then runs a fast check when all of
these hold: a wake file has lines past the count the last check recorded, and every such file
names its inputs; the last full check began less than `check.full_minutes` ago (10; `0` turns
fast checks off); and the last check failed no input. Otherwise, and on `cycle due`, on
`--full`, and when an input it names is not installed, it runs the full check.

A fast check runs only the named inputs (not the `routines` input, not the other scripts), gives
them the `OPSBOT_SINCE` of the last full check, records seen keys, and leaves the watermark
alone: only a full check moves it, so an input that was skipped loses nothing, and the seen keys
drop what a fast check already reported. Its log line says `fast: true` with the inputs it ran;
every check a cycle runs logs `check: "fast"` or `check: "full: <why>"`. The digest carries one
more line, `fast: <inputs>; full check due <HH:MMZ>`. Only `cycle.d/begin/` scripts whose name
ends `.fast` run on a fast cycle: keep a repository sync un-suffixed and it runs at every full
check. The watchdog, the outage record, `next-delay` and the sleep timer count a fast cycle as a
cycle.

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
2. one section per `opsbot.d/wake.d/` script (what is owed, open escalations, …), then one
   per `cold-start` recall (the rows a record sheet puts back, below), each cut to its share
   of the wake budget (6 000 bytes across them all) with `… N more lines`
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
| `monitor.d/` | always on | a watcher (`<name>`, a service) or a probe (`<name>@5m`, a timer); wakes the loop with `$OPSBOT_CORE wake backstop` (detached, one at a time), which nudges only when the session's own monitor did not start a cycle |
| `cycle.d/begin/` | after the lock, before the check | housekeeping such as a repo sync; non-zero aborts the cycle as degraded. On a fast cycle only scripts named `*.fast` run |
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

`repo_sync` (optional) is `pull` (the default) or `never`. With `pull`, each full cycle's
`cycle begin` fetches the checkout's branch and fast-forwards it when the working tree is
clean and the branch is behind, so a bot needs no repo-sync hook of its own. A checkout that
cannot fast-forward (uncommitted changes, a person's unpushed commit, a diverged branch) is one
heartbeat item naming both commits, said once per remote head, and the cycle goes on with the
program it has. A fast cycle leaves it for the next full one.

`log` (optional) is `{branch, ledgers, state}`. The loop's own log is written to its own
branch, `log.branch` (default `"opsbot/log"`), through `gitsheets-axi` (2.15.0 or later), and
never to the working tree: each cycle that found or did something is one commit there with
`Program`, `Watermark` and `Check` trailers, a run of quiet cycles is one commit amended until
the hour turns, and the branch is pushed at `cycle end` up to its newest sealed commit. The
program branch gets a commit only for the memory files a cycle changed. A refused push of the
log is a failed check: another host is running the same bot.

A bot's scripts keep what they did and what they compare against on the branch too, never in a
file of their own. `log.ledgers` and `log.state` each map a name to the fields its record must
carry: `{"ledgers": {"labels": ["thread", "label"]}, "state": {"inbox": ["cursor"]}}`. A script
appends with `opsbot-core log append <ledger>` (a JSON record on stdin; `at`, an ISO time in
UTC, defaults to now; `ledger` and `hash` are the log's own fields), reads with `opsbot-core
log read ledgers/<ledger> [--since <time>] [--filter <clause>] [--json-out <path>]`, and keeps
a baseline with `opsbot-core log state set|get <name>`. A write made while a cycle holds the
checkout rides that cycle's commit; one made outside a cycle is its own commit. A ledger is
append-only: something a script edits later is a record on the program branch. `log read ...
--repo <path or remote>` reads another bot's log from its branch. The listeners ask
`opsbot-core log seen <key>`, and the post commands of opsbot-slack and opsbot-whatsapp write
their decision log to `posts/<channel>`.

`memory` (optional) is `{dir, review_days}`, defaults `memory` and `7`, or `false`. See
*Auto memory* below.

`routines` (optional) is `{dir}`, default `routines`. Each run is a record of the log branch's
`routines` sheet. See *Routines* below.

`record` (optional) is `{recall: [...]}`: the recalls that put a record sheet's rows back in
front of the session. See *The console, and the record* below.

## State it keeps

| Path | What |
| --- | --- |
| the log branch (`opsbot/log`) | never checked out: `cycles` (one record per line the loop logs: a check that found something `{at, outcome, inputs, new, failed}`, a finish `{at, outcome: "finished", records, degraded}`, a sleep, a wake), `seen`, `outages`, `routines`, `posts/<channel>`, `ledgers/<name>` and `state/<name>`; a quiet run is a commit's trailers, not records; the watermark is the tip's `Watermark` trailer. `opsbot-core log read` and `log tail` read it |
| `.git/opsbot-log-pending.json`, `.git/opsbot-log-cache.json` | what waits for the next log commit, and the records already read; never committed |
| `.git/opsbot-cycle.lock` | the writer lock `{pid, session, started}`, never committed |
| `memory/` (`memory.dir`) | the session's auto memory: `MEMORY.md` and one file per memory; committed with the cycles |
| `.git/opsbot-memory-review.json` | the snapshot a memory review diffs against; never committed |
| `routines/` (`routines.dir`) | the routine definitions, one markdown file each; read at `HEAD`; changed only through review |
| `.git/opsbot-sleep` | while going down, asleep, or woken and not yet answered; removed by `cycle begin`; never committed. The log gets `sleep` and `wake` lines, and its readers treat the span between them as intended silence |

## Moving a bot to the log branch

A bot that kept its log in files (the kit's `logs/` files, and its own files listed in the old
`commit_paths` setting) moves once, with `scripts/opsbot-core log migrate`. Until the commit it
prepares is merged into the bot's checkout, this release refuses to run the loop (exit 2, naming
the command), so nothing is ever written to both places.

1. Update the kit (`npx skills update`). A bot more than one release behind is refused with the
   release to update to first: update to it, let one full cycle run, then update to this one.
2. `scripts/opsbot-core log migrate --dry-run`. It prints, per file, its lines and where they go.
   It stops (exit 1) until every tracked file under `logs/` that no setting names, and every data
   file a hook names, is assigned with `--assign <path>=ledger[:<name>]|state[:<name>]|ignore|keep`.
3. `scripts/opsbot-core log migrate` (with the same `--assign` flags). It writes every line to the
   log branch (a line it cannot place is a record of ledger `unparsed`, with its file, line and
   why), and prepares `opsbot/log-migrate` from HEAD: one commit that removes the files and the
   settings only they needed, sets `log.branch`, and declares the ledgers and baselines it moved.
   Nothing changes on the current branch. Run again, it writes nothing twice.
4. Do what it prints: push both branches, open and merge the pull request, then in the bot's
   checkout discard the log files' local changes (their lines are on the branch) and
   `git pull --ff-only`. The next `cycle begin` writes to the log branch.
5. Change the bot's hooks that wrote files to `log append` and `log state set`, and delete any
   repo-sync hook of its own.

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
writing style (`10-writing.md`: tone, shape, Slack mrkdwn, email, records, logs), that the
terminal is a log and not a channel (`12-console.md`), that what must outlive a compaction
goes in a sheet with a recall (`14-record.md`), the
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

## The console, and the record

Nobody reads a bot's terminal unless something is broken; people read its channels and its
repo. `12-console.md` in the pack says so to every session: end a turn with one status line
or nothing, say a thing where it will be read (the person's channel, or a record), never
narrate. `14-record.md` says where the rest goes: what the bot must still know after its next
compaction is a row in a gitsheet (`.gitsheets/<sheet>.toml`), never a free-text notes file
and never the memory directory, and every sheet has a recall.

A **recall** is code putting rows back in front of the session at the right moment. List them
in `opsbot.json`:

```json
"record": { "recall": [
  { "sheet": "work", "filter": "status=open", "at": "cold-start", "title": "In progress" },
  { "sheet": "promises", "filter": ["status=open", "due<=today"], "at": "cycle-end", "title": "Due" },
  { "sheet": "promises", "filter": "status=open", "at": "item", "title": "Promised to them" }
] }
```

| Key | Meaning |
| --- | --- |
| `sheet` | a sheet in the repo's `.gitsheets/` (required) |
| `filter` | one `gitsheets-axi query` filter clause as a string, or several as a list (they all must hold); the forms are gitsheets-axi's own: `k=v`, `k!=v`, `k<v`, `k>v`, `k<=v`, `k>=v`, `k~regex`, `"k in (a,b)"`, `k:present`, `k:empty`. A clause whose value is `today` (`due<=today`) gets the date in the bot's `timezone`, `YYYY-MM-DD`. Two clauses in one string are refused: write a list |
| `at` | `cold-start` (a section of the pack, after the `wake.d/` sections and inside their budget), `cycle-end` (a `recall` field in `cycle end`'s output, only when there are rows), or `item` (a `recall` field on each new check item whose `from` or `conv` equals a row's `match` field) (required) |
| `title` | the heading; default the sheet's name |
| `fields` | the columns to print; default the sheet's first four, in the order its config declares them |
| `limit` | most rows shown (per item, for `item`); default 20, then `… N more:` and the command that lists them all |

The core runs each recall as `gitsheets-axi query <sheet> --filter <clause>... --json-out=<a
temporary file>`, reads that file (never the TOON on stdout), and removes it. A recall never
writes. gitsheets reads the sheet configs and records from the committed tree, so commit a new
sheet before its recall can run. `OPSBOT_GITSHEETS_AXI` names another binary. A recall whose
sheet is missing or whose query fails prints one line saying so in its place, never an empty
section, and `settings validate` refuses it: an unknown key, an `at` other than the three, a
filter that is not gitsheets-axi clauses, a sheet not under `.gitsheets/`, an `item` recall on
a sheet whose schema declares no `match`, and a query that fails. A `cycle-end` recall runs at
`cycle end`, as `cycle.d/end/` scripts do, not on a quiet `cycle begin`.

`scripts/opsbot-core record status` lists every sheet with the recalls that name it and its
open-row count by each recall's filter; a sheet no recall names is flagged, because nothing
would ever show the session one of its rows again.

**Adopting it.** The kit ships no sheets of its own. `templates/sheets/work.toml` (what the bot
is in the middle of: `title`, `status`, `next`, `waiting_on`, `updated`) and
`templates/sheets/promises.toml` (`to`, `what`, `due`, `status`, `settled_by`, and `match`
for the item recall) are starting points: copy one to `.gitsheets/`, adjust it, commit it, add
the recall entry from the comment at its top to `record.recall`, run `settings validate`, and
check `record status`. Moving an existing notes file into a sheet is the bot's own migration.

## Auto memory

Claude Code's auto memory is a folder of small notes the model writes on its own: an index,
`MEMORY.md`, loaded at every session start, and one file per memory. A bot keeps that folder
in its repo, so it is versioned, reviewable, and moves with the bot.

- `start` passes `autoMemoryEnabled: true` and `autoMemoryDirectory` (the absolute path of
  `memory.dir`) in its one `--settings` object, and creates the directory when it is
  missing. `memory: false` turns auto memory off instead. No setting leaves it at Claude
  Code's default location, so launch the bot with `start`. For people's own sessions in the
  bot's checkout, `.claude/settings.json` may set `autoMemoryDirectory` to the same
  directory (relative or absolute); `settings validate` refuses any other directory, naming
  both.
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
  [--handed-to WHO]`. The run is a record of the log branch's `routines` sheet and rides the
  next log commit. `routines history <id>` shows the runs and the missed stretches.
- **Definitions are governed.** A change to `routines/` changes what the bot does, so it goes
  through the same review as the rule card. The core reads definitions at `HEAD` and never
  writes to `routines/`; the bot never edits them on its own.
- The definitions are gitsheets markdown records. `templates/gitsheets/routines.toml` is an
  optional sheet config to install under `.gitsheets/` for querying them with gitsheets; the
  runs are read with `opsbot-core log read routines`.
- **Built in:** `memory-review` (every `memory.review_days`, instructions
  `references/memory-review.md`) exists while memory is on. A `routines/memory-review.md`
  overrides it.

<!-- BEGIN GENERATED: command-reference -->

### The cycle

- `scripts/opsbot-core cycle begin [--full]` — Refuse while another writer holds the checkout (exit 30, `wait · … · next <s>`); take the lock; record outages; run `cycle.d/begin/`; run the check. A wake from a wake file whose `wake.files` entry names its inputs (`{file, inputs}`) runs a fast check: only those inputs, the last full check's window, the watermark left alone, only `cycle.d/begin/` scripts named `*.fast`, and a `fast` field naming the inputs and when the next full check is due; a quiet deadline, a full check older than `check.full_minutes` (10; 0 turns fast checks off), a failed last check or `--full` runs the full check. Exit 0 nothing new (lock released), 10 new, 20 degraded (lock kept until `cycle end`). With `wake.files` set, a `wake` field says whether the live-wake monitor is armed and prints the call that arms it. With `loop.schedule: monitor`, on 0 and 30 the `wake` field holds the schedule monitor's state and the one Monitor call to make now. With `sleep` set, a nothing-new begin that finds the loop quiet for `after_minutes` prints a `sleep` field in place of `wake`: arm nothing, end the turn. A begin that finds `.git/opsbot-sleep` removes it and logs the wake.
- `scripts/opsbot-core check [--no-commit]` — Run every `opsbot.d/heartbeat.d/` script and the core's `routines` input (one item per due routine occurrence), record seen keys, log, commit. With an `item` recall, a new item whose `from` or `conv` equals a row's `match` field carries those rows in a `recall` field. Exit 0 nothing new · 10 new (digest) · 20 degraded (failed inputs named) · 2 cannot run.
- `scripts/opsbot-core cycle end --records N [--degraded] [--summary TEXT]` — Pin the watermark to this cycle's check time (refuses a future time, a backwards move, or no check since the lock); run `cycle.d/end/`; log `finished`; commit, push, release; print `next <s> <reason>` (or, when a wake file gained lines since this cycle's check, `arrived: <n> on <file>` and `next 0 arrived` with no `wake` field: run `cycle begin` again at once) and, with `wake.files` set, the `wake` field with the monitor's deadline bounded by that next wake. With `loop.schedule: monitor`, the `wake` field holds the one schedule Monitor call (exits on a wake-file line or `cycle due`), and nothing else schedules the next cycle. With `sleep` set, a `sleep` field may replace `wake`, as at `cycle begin`. Each `cycle-end` recall with rows prints them in a `recall` field (a recall that cannot run is one line there). When the memory review is due, one `memory` line says so with the command to run, and a `routines` field names each other due routine; neither blocks the cycle.
- `scripts/opsbot-core check --peek` — Run every heartbeat script and the `routines` input as a check does (each script also gets `OPSBOT_PEEK=1`) and print the count of new items per input. Records, logs and commits nothing; the watermark and seen keys are untouched, so the next check sees the same items. Exit 0 · 10 · 20 · 2 as `check`.
- `scripts/opsbot-core wake wait --until <epoch seconds>` — The schedule monitor's poller, run by the one `Monitor` call `cycle begin` and `cycle end` print and by nothing else. From the line counts the last check recorded, polls every 2 s; prints the new lines of any wake file (each prefixed with the file's basename, cut to 300 characters, at most 20) or `cycle due` when the time passes, and exits 0. Refuses a time more than 1800 s ahead (exit 2).
- `scripts/opsbot-core wake backstop --key <key> --at <ISO time> [--grace <seconds>] --reason <text>` — The listeners' one wake routine, so no listener carries its own; a listener runs it detached, one at a time, and logs its line. Waits `--grace` (default 20 s) for a check begun after `--at` or the key seen on the log branch; waits out a cycle already running and looks again; skips the wait while the bot is asleep; then runs `nudge --now`, again every 10 s, until its outcome is `woke` or `cooldown`, a newer check begins, the key is seen, or 30 minutes pass. Prints one line, `backstop:` with `woken by monitor`, `nudged after <n>s`, `nudged after cycle`, `already woken`, `asleep: nudged` or `gave up`, and exits 0; its progress notes go to stderr. Exit 2 on a missing key, time or reason.
- `scripts/opsbot-core next-delay` — Seconds until the next cycle and why, from the cycle log and the cadence table. With `loop.schedule: monitor`, never over 1740 (29 min), and the reason says when that cap applied.

### Cold start

- `scripts/opsbot-core start [--continue] [--dry-run] [-- <extra claude args>]` — Launch the bot's Claude Code session with the flags opsbot.json implies: permission mode (default auto), model, autocompact window, autocompact forced on, auto memory in the repo (`autoMemoryDirectory` set to `memory.dir` as an absolute path, created when missing; off with `memory: false`), and `loop.prompt` as the first message. `--continue` resumes the last session in this checkout. A bot's `bin/start` shim calls this.
- `scripts/opsbot-core cold-start [--write]` — Print the reground pack: the rule card, the kit's sections (house style, the console and the record, delegation, what the session log says, the live wake to arm), each `wake.d/` section, then each `cold-start` recall's rows (both inside the wake budget), the last 48 hours of the cycle log (with one line when the memory review is due and a few naming the other due routines), the untrusted-memory line; the routines section rides when the bot has a routine definition. `--write` also makes sure `.scratch/` exists and is git-excluded, writes the pack to `.scratch/opsbot-core/reground.md`, sets the pending flag and records the session log's path for `cycle` and `nudge`.
- `scripts/opsbot-core gate check` — PreToolUse body: exit 0 when nothing is pending or this call reads the pack whole; otherwise deny (exit 2).

### State

- `scripts/opsbot-core lock status | lock release [--abandon]` — Show the writer lock, or release it (another live process's only with `--abandon`).
- `scripts/opsbot-core outage record <kind> [--note TEXT] [--started ISO] [--ended ISO] | outage end | outage list` — Record, close or list outages: failed-turn, refused, plan-limit, session-ended, stopped.
- `scripts/opsbot-core log tail [--n N]` — The last N cycle-log lines (default 10).
- `scripts/opsbot-core log append <ledger> | posts/<channel>` — Append the JSON record(s) on stdin to a ledger declared in `log.ledgers` (each must carry its declared fields) or to a channel's post log. Inside a cycle it rides the cycle's commit; outside, it is its own commit. Never the working tree.
- `scripts/opsbot-core log state get <name> [--json-out PATH] | log state set <name>` — Read a baseline, or replace it with the JSON object on stdin (a name declared in `log.state`, carrying its declared fields). An unchanged value writes nothing.
- `scripts/opsbot-core log read <sheet> [--since ISO] [--filter CLAUSE]... [--repo PATH|REMOTE] [--branch NAME] [--json-out PATH]` — Records of `cycles`, `seen`, `outages`, `routines`, `posts/<channel>` or `ledgers/<name>`, oldest first, staged ones included; `--since` walks only the days from then on; `--repo` fetches another bot's log branch (`opsbot/log`, or `--branch`) into a private copy under the git directory and reads it.
- `scripts/opsbot-core log seen <key>` — Exit 0 when the key was reported to the session (from the log branch and what is staged for it), 1 when not: the listeners ask this.
- `scripts/opsbot-core log migrate [--dry-run] [--assign PATH=ledger[:NAME]|state[:NAME]|ignore|keep]...` — Move a bot from the old log files to the log branch, once: every line of the kit's log files, the files the old settings listed, the post logs and the routine runs become records of the branch in one commit (each keeping its own time; a line it cannot place is a record of ledger `unparsed`), and `opsbot/log-migrate` is prepared from HEAD with one commit that removes those files and the settings only they needed and sets `log.branch`. Nothing on the current branch or in the working tree changes; it prints what to push and the pull request to open. `--dry-run` prints the counts per file and sheet and writes nothing. Stops (exit 1, nothing written) until every tracked file under `logs/` no setting names, and every data file a hook names, is assigned with `--assign`. Refuses (exit 2) a bot whose cycle log shows a release older than the one before this, naming the release to update to first.

### The record

- `scripts/opsbot-core record status` — Each sheet in `.gitsheets/` with the recalls that name it (`record.recall` in `opsbot.json`) and its open-row count by each recall's filter (`today` resolved in `timezone`); a sheet no recall names is flagged, and a recall that cannot run (a missing sheet, a failing query) says why. Runs `gitsheets-axi query` (or `OPSBOT_GITSHEETS_AXI`) and writes nothing.

### Memory

- `scripts/opsbot-core memory status` — The repo's auto-memory directory (`memory.dir`): memory files, their bytes, the `MEMORY.md` index's size, the oldest unreviewed file's age, the last review, and whether one is due (`review_days` after the last run of the `memory-review` routine, or, never reviewed, after the oldest file).
- `scripts/opsbot-core memory review --begin | memory review --done [--note TEXT]` — `--begin` snapshots the directory under `.git/` and prints the worksheet: one row per file (name, frontmatter `type`, bytes, age, changed since the last review), the protocol, and the path of `references/memory-review.md`. `--done` diffs against the snapshot, records a run of the `memory-review` routine and logs `memory-review` with `kept`, `updated`, `removed` (folded or pruned) and `added`; say in `--note` what was folded where.
- `scripts/opsbot-core memory import <path> [--dry-run]` — Copy memory files from another directory (Claude Code's default location) into `memory.dir`: never overwrites (a different file of the same name is a reported clash), merges `MEMORY.md` index lines without duplicates, reads nothing but `<path>`. The next cycle commits them.

### Routines

- `scripts/opsbot-core routines [due [--all]]` — The routines due now (definitions in `routines.dir` at HEAD, plus the built-in `memory-review` while memory is on): id, title, schedule, since when, last run. `--all` lists every routine with its state, last run, next due time and source. Exit 1 when a definition or run record is invalid (named).
- `scripts/opsbot-core routines view <id>` — One routine: schedule, source (a file at HEAD, or built in), state, last run, and its instructions, the definition's body.
- `scripts/opsbot-core routines history <id>` — The routine's runs in order with outcome, days since the one before and any missed stretch or slots; then the time since the last and whether it is due.
- `scripts/opsbot-core routines done <id> --notes TEXT [--outcome done|partial|skipped|blocked] [--checked ITEM]... [--handed-to WHO] [--at ISO]` — Record one run on the log branch's `routines` sheet (`routines/<routine>/YYYY/MM/DD/<hhmmss>-<hash>`), committed with the next log commit; prints when the routine is next due. Refuses an unknown or inactive routine, empty notes, an unknown outcome or a future `--at`. Never touches the definitions.
- `scripts/opsbot-core routines validate [--head]` — Parse every definition (working tree, or HEAD) and run record and name each problem: unparseable file, unknown key, bad or mismatched id, duplicate id, bad cadence, both or neither of interval and slot, a slot without days, bad time, day or `since`.

### Liveness (run by system timers)

- `scripts/opsbot-core watchdog [--dry-run]` — When no cycle has logged within `watchdog_minutes`, tell the operator once per outage through `escalate.d/` and record it. Stands down while the bot sleeps.
- `scripts/opsbot-core nudge [--now [--reason TEXT]] [--dry-run]` — Re-issue `loop.prompt` to the named agent when the loop is quiet, unlocked, past cooldown and idle. `--now` (for listeners) skips the quiet test. A `working` agent whose own session log shows its turn ended (background work only) is prompted anyway, with a note. While the bot sleeps only `--now` acts, and it wakes it. Every reply ends with `outcome:`, the word to test (the prose is for people): `woke` or `nudged` when the prompt was typed, `cooldown` when another nudge typed it moments ago or is typing it now (one nudge at a time holds the marker), `refused` for any other reason not to (lock, mid-turn, blocked, asleep, quiet), `cannot` (exit 1) when the runtime failed, `dry-run`.
- `scripts/opsbot-core sleep tick [--dry-run]` — The sleep timer's tick (only with `sleep` set; a no-op while awake). Going down: types `/compact` once the session is idle. Asleep: wakes it with `<loop.prompt> (woken: <reason>)` on an operator message (a typed prompt; a slash command such as a hand-typed `/compact`, and the timer's own keystrokes, are not one), a wake-file line, the due time, `max_minutes`, or a `check --peek` exit of 10 or 20. A wake no `cycle begin` answers within `watchdog_minutes` is told once through `escalate.d/`. Exit 1 when the runtime or the operator could not be reached.
- `scripts/opsbot-core infra install|uninstall|status [--dry-run]` — Render the watchdog and nudge timers, one unit per `monitor.d/` script, and with `sleep` set the sleep timer, from `opsbot.json`; `status` names stale units and the sleep state.

### Setup

- `scripts/opsbot-core hook install|uninstall|status [--scope project|global] [--dir PATH]` — Register the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks; project scope by default.
- `scripts/opsbot-core hooks list [--point P]` — Every script that will run at each lifecycle point, in order, with its source.
- `scripts/opsbot-core settings validate [--head]` — Refuse an `opsbot.json` with an unknown key, a missing required key, a cadence over the cap, or a `memory.dir` or `routines` directory outside the repo; a `.claude/settings.json` that sets `autoMemoryEnabled`, or an `autoMemoryDirectory` other than `memory.dir` (the same directory, relative or absolute, is accepted, so a session `start` did not launch shares the bot's memory); any invalid routine definition; and a `record.recall` entry with an unknown key, an `at` other than `cold-start`, `cycle-end` or `item`, a filter that is not gitsheets-axi clauses, a sheet missing from `.gitsheets/`, or a query that fails; and a log branch (`log.branch`, default `opsbot/log`) that names the branch checked out, or no `gitsheets-axi` 2.15.0 or later to write it; `log.ledgers` or `log.state` that is not names with lists of field names; and, naming `log migrate`, every setting only the old log files needed (the list of files each cycle committed, `routines.runs_dir`, and `repo_sync` `pull-on-clean` or `never-pull`).

<!-- END GENERATED: command-reference -->
