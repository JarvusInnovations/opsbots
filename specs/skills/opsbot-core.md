# Skill: opsbot-core

The loop. Installing this skill into a bot's repo gives it the cycle, the check
framework, the cycle log, the lock, outage accounting, the cadence, cold start with the
read-gate, and the liveness units, as one bundled AXI CLI plus the prose that explains
the protocol. Everything else (sheets, guards, channels, delivery) is another skill.

## Installs

```
.agents/skills/opsbot-core/
  SKILL.md                 protocol prose + generated command reference
  scripts/opsbot-core      bash shim → scripts/opsbot-core.mjs (committed bundle, node ≥ 20)
  templates/opsbot.json    the settings file template
  templates/*.service|timer  systemd user units for watchdog, nudge, monitors and the sleep timer
```

The bot's own files the skill reads and writes:

| Path | What |
| --- | --- |
| `opsbot.json` | the settings file; committed; the only place any loop *value* is set |
| `opsbot.d/` | the lifecycle directories; every executable in them is picked up (see below) |
| `logs/cycle.jsonl` | one line per cycle outcome; committed. With `sleep` set it also holds `{at, outcome: "sleep", by, quiet_since, due}` and `{at, outcome: "wake", reason, latency_s, slept_from, woken_at}` |
| `logs/intake/seen` | typed seen keys; committed |
| `logs/intake/watermark` | one UTC ISO line; committed |
| `logs/outages.jsonl` | outage events `{at, outcome: "outage"\|"outage-end", kind, started, ended, note}`; committed with the next cycle; readers also accept outage lines found in `logs/cycle.jsonl`, where an earlier bot wrote them |
| `.git/opsbot-cycle.lock` | the writer lock; never committed |
| `.git/opsbot-{watchdog,nudge,nudge-now}` | the watchdog's told-once marker and the nudge cooldowns; never committed |
| `.git/opsbot-sleep` | present while the bot is going down, asleep, or woken and not yet answered: when it was decided and by which command, quiet since when, the earliest due time and what it is, each wake file's line count at the decision, when the sleep began and whether it compacted, the sleep timer's last look, the wake (when, why, when the event was, whether the prompt landed) and whether an unanswered wake was escalated; removed by `cycle begin`; never committed; ignored while `sleep` is absent from `opsbot.json` |
| `.scratch/` | the bot's scratch directory for files written to look at and throw away; `cold-start --write` creates it and adds a `.scratch/` line to the repository's `info/exclude` (`git rev-parse --git-path info/exclude`, so a worktree checkout works), never to `.gitignore`; never committed |
| `.scratch/opsbot-core/reground.md` + `reground.pending` | the cold-start pack and its flag; inside the working directory, so reading the pack needs no permission beyond the checkout |

## Settings (`opsbot.json`)

| Key | Meaning |
| --- | --- |
| `name`, `mark` | the bot's name (`[a-z][a-z0-9-]*`, used in unit names and cache paths) and the emoji mark every message opens with |
| `timezone` | IANA zone for the cadence hours and every human-facing time; default `UTC` |
| `rule_card` | repo path of the rule card the cold-start pack opens with, read at `HEAD`; optional |
| `gate_word` | optional; capital letters only; the check flags its presence as a whole word, never judges it |
| `loop.prompt` | the exact loop prompt, including any cold-cache suffix the operator uses; with `loop.schedule: "monitor"` it must not start with a slash command (`settings validate` refuses one), since every wake would re-read that command's body |
| `loop.schedule` | `self` (default) or `monitor`: how the session schedules its next cycle. `self` is the self-paced call with the loop prompt. `monitor` is one bounded `Monitor` the session arms at the end of every cycle, which exits on a new line in any wake file or when the next cycle is due; see *The schedule monitor* below |
| `loop.autocompact` | the window (`750k`, `600000`); unset, it follows `loop.mode`: `750k` for a strategist, `300k` for a dispatcher (every call reads the whole window from cache, so a loop that mostly watches pays for a context it does not use); `start` sets it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the session's environment and its `--settings` `env`, the one control Claude Code honors (the `--autocompact` flag and `autoCompactWindow` were ignored on two bots; the env var works on a third) |
| `loop.mode` | `strategist` (default) or `dispatcher` ([principles](../principles.md#the-loops-class-follows-its-work-strategist-or-dispatcher)): picks the model `start` passes when `loop.model` is unset (`fable` or `opus`), the window when `loop.autocompact` is unset (`750k` or `300k`), a dispatcher's quiet cadence when it has `wake.files` (below), and which `references/pack/NN-mode-<mode>.md` section rides the pack |
| `loop.session_name` | the main session's name, the bot's `name` by default: `start` sets it with `--name`, so the session is recognizable in the picker and the terminal title, and resumes by it when no session id has been recorded yet. One word. A name that matches no session, or several, opens Claude Code's picker in front of the operator instead of resuming the wrong one |
| `loop.model`, `loop.permission_mode` | what `start` passes as `--model` and `--permission-mode` (default `auto`); the only place the launch flags are set |
| `cadence` | `{hot, warm, quiet_working, quiet, night, cap}` in seconds, plus `working_hours` (`days` as ISO weekday numbers 1–7, `start`, `end` as `HH:MM`) and `night_hours` (`start`, `end`, a span that may cross midnight) in the bot's timezone; every key optional, defaulting to the architecture's table (working hours Monday–Friday 09:00–17:00, night 22:00–07:00); for a dispatcher with `wake.files`, unset `quiet_working` and `quiet` default to `cap`, because its streams wake it and the timer only keeps the cache warm |
| `lock_max_minutes` | after which a lock is abandoned |
| `liveness` | `{watchdog_minutes, nudge_minutes, nudge_cooldown_minutes, wake_cooldown_minutes, interval_minutes}`: the stop limit (60), the quiet limit before a nudge (50; 35 with `loop.schedule: "monitor"`), the nudge's cooldown (50; 35 with `monitor`), the cooldown of `nudge --now` (10), and how often the watchdog and nudge timers fire (10; the nudge runs half an interval after the watchdog) |
| `sleep` | optional and, until a week's trial on a working bot is read, a trial setting; absent, the bot never sleeps. `{after_minutes, probe_minutes, max_minutes, compact}`: how long the loop must be quiet before it sleeps (60), how often the outside probe looks at the streams while it sleeps (10; 60 at most, so the compaction on the way down lands while the one-hour cache is warm), the longest one sleep may last (480), and whether the session is compacted on the way down (`true`). Requires `loop.schedule: "monitor"`; see *Sleep* below |
| `runtime` | `{adapter: "herdr", agent: "<name>"}`; the adapter supplies `idle` and `prompt`. The herdr adapter finds the bot's pane by that name first and, when the name is missing (a renamed pane, a restarted herdr), by the one agent whose cwd is the bot's checkout; it prompts the pane, not the name |
| `streams.<name>` | per-stream values a heartbeat script reads (postures, ids, lookbacks); the script is found by name in `opsbot.d/heartbeat.d/`, not listed here |
| `repo_sync` | `pull-on-clean` or `never-pull` |
| `host` | optional; belongs to the `opsbot-host` skill (display, VNC and bridge ports); `settings validate` accepts it as an object and does not look inside |
| `commit_paths` | optional; repo-relative files the check's commit and the `cycle end` commit also take when they exist and have changes (a baseline an adapter updates, an append-only log a helper script writes between cycles); a listed file that does not exist is skipped |
| `wake.files` | optional; the files a `monitor.d/` listener appends one line per event to. The core prints, in the cold-start pack and at every `cycle begin` and `cycle end`, the state of each (armed until when, or not armed) and the exact bounded `Monitor` call that arms it; see *The live wake* below. With `loop.schedule: "monitor"` all of them share the one schedule monitor |

`settings validate` refuses a file with an unknown key, a missing required key, or a
cadence value over the cap, or a `loop.prompt` that starts with `/` when `loop.schedule` is
`monitor`, or a `sleep` without `loop.schedule: "monitor"`. Required: `name`, `mark`, `loop.prompt`, `runtime.agent`. A
key named `//` is a comment and is allowed at any level, since JSON has no comments.
`streams.<name>` objects are the heartbeat scripts' own and are not checked inside.
When `.claude/settings.json` sets `autoCompactWindow`, `settings validate` refuses it
unless it equals `loop.autocompact` (one value, one place).

## Session drift

`start` sets the model and the compaction window when it launches the session, from
`loop.mode` (or `loop.model` and `loop.autocompact`). A session started any other way has
neither. `cycle begin` runs inside the session, so it checks both: the window in its own
environment (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) and the model on the last reply in the session
log. When either differs it prints a `session` field naming the difference and the line that
fixes it at the next restart (`start --continue`), once per session and difference; later
cycles print nothing, so a quiet cycle stays small. The bot cannot change either from inside:
it tells its operator once. Outside a session (`CLAUDECODE` unset) nothing is checked.

## Commands

| Command | Does | Exit |
| --- | --- | --- |
| *(none)* | home: bot name, bin path, last cycle outcome and age, lock state, next wake, counts of failed inputs and open outages, and with `sleep` set the sleep state (`awake`, going down, `asleep since HH:MMZ, next look HH:MMZ, wake by HH:MMZ`, or woken and waiting); three help lines | 0 |
| `check` | runs every script in `heartbeat.d/`, aggregates, records seen keys, logs, commits; prints the digest or one line | 0 nothing new · 10 new · 20 degraded · 2 cannot run |
| `cycle begin` | refuses while another writer holds the checkout; takes the lock; records a `stopped` outage if overdue; runs `cycle.d/begin/`; runs `check`; on 0 releases and prints the closing line. With `loop.schedule: "monitor"`, on 0 and on 30 it also prints a `wake` field: the schedule monitor's state and the one `Monitor` call to make now | as `check`; 30 wait |
| `cycle end --records N [--degraded] [--summary TEXT]` | runs `cycle.d/end/`; pins the watermark to this cycle's check time; appends `finished`; commits with `--only`; pushes; releases; prints whatever `cycle.d/end/` scripts printed (due promises, owed fixes), then `next <s> <reason>`; with `loop.schedule: "monitor"`, then a `wake` field with the schedule monitor's state and the one `Monitor` call to make now, and no self-paced guidance | 0 · 1 refused (nothing written; the lock released) or could not commit (the lock kept) |
| `check --peek` | runs every script in `heartbeat.d/` and prints the count of new items per input; records nothing, logs nothing, commits nothing, and leaves the watermark and the seen keys alone, so the cycle that follows sees the same items. Each script also gets `OPSBOT_PEEK=1`: an adapter that keeps state of its own (a baseline it updates) must leave that state alone when it is set, or the check that follows misses what the peek saw | 0 nothing new · 10 new · 20 degraded · 2 cannot run |
| `sleep tick [--dry-run]` | the sleep timer's one command, a no-op unless `.git/opsbot-sleep` exists and `sleep` is set. Going down: once the session is idle by the nudge's test (the runtime's `idle` or `done`, or `working` with the session log showing the turn ended), types `/compact` through the adapter when `sleep.compact` is set, and marks the sleep begun. Asleep: wakes the session, typing `<loop.prompt> (woken: <reason>)` through the adapter, when the operator wrote to the session since the decision, when a wake file has a line past the count taken at the decision, when the recorded due time has passed, when `max_minutes` since the decision is up, or when `check --peek` exits 10 or 20 (tested in that order, the peek last and only once the sleep has begun); otherwise records its look and does nothing. Any of these while going down is a wake, not a compaction. A busy session is woken at a later tick; one that cannot be reached, or sits at a dialog, is recorded as woken unsent and tried again. A wake not followed by a `cycle begin` within `watchdog_minutes` is told to the operator once through `escalate.d/` and recorded as a `stopped` outage from the wake. `--dry-run` types and writes nothing | 0 · 1 could not reach the runtime, or could not tell the operator |
| `next-delay` | reads the log and the cadence table; prints `<seconds> <reason>`. With `loop.schedule: "monitor"` no delay passes 1 740 seconds (29 minutes: the delay plus the monitor's one-minute margin stays inside the harness's 30-minute limit), and a capped reason says so: `night (capped at 29 min: a monitor's limit)` | 0 |
| `start [--continue] [--dry-run] [-- <extra>]` | launches `claude` with the flags `opsbot.json` implies: permission mode, model, autocompact window, `autoCompactEnabled: true` via `--settings`, and `loop.prompt` as the first message; `--continue` resumes the session that last ran a cycle here, by id (`--resume <id>`, recorded at every `cycle begin` in `.git/opsbot-loop-session`), and by `loop.session_name` when none is recorded; it never takes the directory's most recent session (a person's session opened in the bot's checkout would be that, and get the loop). Every start passes `--name <loop.session_name>`; the bot's `bin/start` shim is two lines calling this | exit code of `claude` |
| `cold-start [--write] [--transcript <jsonl>]` | prints the pack: the rule card; the kit's own sections (`references/pack/*.md` shipped with the skill, in order, whole: house writing style, delegation rubric); then, when the SessionStart hook payload on stdin names a `transcript_path` (or `--transcript` does), a "Before this start" section read from the bot's own session log since its last compaction through `agent-recall-axi` (bundled; the kit's own text reader is the fallback when the library cannot read the log): the operator's messages verbatim (the highest-authority record of intent; the loop prompt excluded, since the nudge and the bot's wakeups type it), newest kept whole within their share and the rest counted with the exact command that prints them; the last tool calls with their status as data; and the bot's last statements flagged as its own claims, each layer with its own share so one long message cannot crowd out the others, capped at 4 000 bytes; then every script in `wake.d/` in order (each prints one section); then the 48 h log summary and the untrusted-memory line; `--write` first makes sure `.scratch/` exists and is excluded, then writes the pack file and sets pending there | 0 |
| `gate check` | the PreToolUse body: exit 0 when nothing is pending or the pending pack was read whole; otherwise prints the deny reason and exits 2 | 0 · 2 |
| `lock status|release` | shows or releases the lock (release refuses another live process's lock without `--abandon`) | 0 · 1 |
| `outage record <kind> [--note] [--started] [--ended]` / `outage end [--ended]` / `outage list` | `failed-turn · refused · plan-limit · session-ended · stopped`; times default to now; end closes the open one | 0 |
| `watchdog [--dry-run]` | if no cycle has logged within `watchdog_minutes`, escalates once per outage through `escalate.d/` and records it; records the end when cycles resume. While `.git/opsbot-sleep` exists it says asleep and escalates nothing (the sleep timer watches a wake), but still records the end of an outage that cycles have closed | 0 · 1 could not escalate (no script, or every one failed) |
| `nudge [--now [--reason TEXT]] [--dry-run]` | if quiet past `nudge_minutes`, no lock, cooldown passed, and the runtime reports idle, re-issues `loop.prompt` verbatim through the runtime adapter; `--now` skips the quiet test and has its own shorter cooldown | 0 · 1 |
| `infra install|uninstall|status [--dry-run]` | renders and enables the watchdog and nudge timers, plus one service or timer per script in `monitor.d/`, plus, only when `sleep` is set, the sleep timer (`sleep tick` every `probe_minutes`), with this repo's paths; `status` compares each installed unit with what `install` would render now and says which are stale, and with `sleep` set prints the sleep state as home does | 0 · 1 |
| `hook install|uninstall|status` | registers the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks, project scope by default | 0 |
| `hooks list [--point P]` | every script that will run at each lifecycle point, in order, with its source | 0 |
| `log tail [--n N]` | the last N cycle lines, one per row | 0 |
| `settings validate [--head]` | validates the working-tree `opsbot.json` (or the committed one) | 0 · 1 |
| `--version` | the bare version, answered before the command graph loads | 0 |

Every command prints TOON on stdout, errors on stdout with a `help` line, nothing on
stdout that is not data. Two outputs are text by nature and print as text: `cold-start`
(the pack is what the session reads) and `gate check`'s deny reason, which it also
writes to stderr because that is where Claude Code reads a PreToolUse refusal.

## Lifecycle directories (`opsbot.d/`)

Like `/etc/*.d` on Linux: the core does not keep a list of what contributes to each
lifecycle point; it runs every executable it finds, in lexical order (`NN-name`), and a
kit skill or the bot's own `bin/` extends the loop by dropping a script in. Non-executable
files and dotfiles are ignored. Every script gets the same environment: `OPSBOT_ROOT`,
`OPSBOT_CONFIG` (the path to `opsbot.json`), `OPSBOT_NAME`, `OPSBOT_MARK`, `OPSBOT_HOOK`
(which point it is being run for) and, where it applies, `OPSBOT_SINCE`, `OPSBOT_SEEN`,
`OPSBOT_WATERMARK`. `OPSBOT_CONFIG` points at a snapshot of `opsbot.json` as committed
at `HEAD`, kept in the git directory, so a script reads what was reviewed.
`OPSBOT_SINCE` is the watermark less a 30-minute margin (24 hours back with no
watermark), `OPSBOT_SEEN` the path of the seen-key file, `OPSBOT_WATERMARK` the
watermark itself (empty with none). During `check --peek` a heartbeat script also gets
`OPSBOT_PEEK=1`. A heartbeat script that exits non-zero has its
first stderr line reported as the reason; the items it printed before failing are
still reported. The core drops an item whose key is already seen, so a script may
over-report its window. A `monitor.d/` unit also gets `OPSBOT_CORE`, the absolute path of the core's
shim, so it can run `$OPSBOT_CORE nudge --now`; its `OPSBOT_CONFIG` is the working-tree
file, since a unit outlives any one commit.

| Directory | When | Contract |
| --- | --- | --- |
| `heartbeat.d/` | every `check` | a stream adapter: prints NDJSON items `{key, at, conv, kind: "group"\|"dm", from, text, ...}`; `key` is the typed seen key; optional `keys` is an array of more seen keys the item stands for (one digest row for a group of events); optional `report: false` marks the item's keys seen without showing it (the bot's own messages); exit 0 with no lines = nothing new; non-zero = this input failed, reported as degraded by the script's name |
| `monitor.d/` | always on | a long-running watcher or a timed probe; `infra install` renders it as a user service (`monitor.d/<name>`) or timer (`monitor.d/<name>@<interval>`); it appends one line per event to a file named in `wake.files` (the session's monitor wakes on it) and also runs `<core> nudge --now` (the backstop) |
| `cycle.d/begin/` | after the lock, before `check` | housekeeping that must run first (a repo sync, a cache warm); non-zero aborts the cycle as degraded |
| `cycle.d/end/` | after records, before the commit | what to show at the close: due promises, fixes not yet told, anything the operator should see this cycle; stdout is appended to the closing line |
| `wake.d/` | every cold start | one section of the reground pack each (what is owed, open escalations, …); each capped to its share of the byte budget |
| `due.d/` | when a sleep is being decided | prints one line per thing due, `<ISO-8601 time> <what>` (a promise, the start of working hours for a bot with routines there); the earliest is the sleep's wake time; a script that exits non-zero, or a line that does not open with a time, keeps the bot awake, since what is due cannot be known |
| `escalate.d/` | when the core must reach the operator | receives the message on stdin; every script runs (a chat DM, a push notification); the core needs at least one or `watchdog` reports itself unable to escalate |

The core runs nothing from these directories that the bot's repo did not put there; it ships one adapter as a template to copy (`templates/heartbeat.d/50-peer-sessions`, below) and test fixtures. A channel skill
installs its adapter into `heartbeat.d/` and its listener into `monitor.d/` ([opsbot-slack](opsbot-slack.md) is the first); the record
skill installs `wake.d/20-owed` and `cycle.d/end/20-due`; a bot's own script goes in
the same way. `opsbot-core hooks list` shows what will run at each point and in what
order.

## Peer sessions

A bot may hand a body of work to a long-lived peer session: a dev foreman beside a project
lead keeps its own warm context of a codebase across days, which a subagent per task cannot.
The bot gives instructions by message and learns what happened from the peer's session log,
read as a stream. `templates/heartbeat.d/50-peer-sessions` is that adapter; a bot copies it
into `opsbot.d/heartbeat.d/` and names its peers:

```json
"streams": { "peers": { "sessions": [
  { "name": "dev", "session": "<session id>", "project": "<project dir name>" }
] } }
```

Each `check` it reads every peer's log through `agent-recall-axi` since `OPSBOT_SINCE` and
prints items: every message the operator typed to the peer, verbatim; the peer's own
statements only when they change state (`state_pattern` replaces the default match: opened,
merged, filed, blocked, waiting on, decided, handed off, failed); and one item when a newer
session in the peer's `project` looks like its successor. Keys carry the event's stable id
(`peer:<name>:<event id>`), so the window's overlap never repeats an item, and the id opens the
whole entry with `agent-recall-axi show`. The adapter sends the peer nothing and never keeps
its cache warm; both are the operator's call. A peer that cannot be read fails the input.

## Rules the commands enforce

- The watermark moves only forward, only from the clock, only to a time at or before
  the check that this cycle ran; a degraded cycle leaves it.
- Seen keys are recorded at report time, so a cycle that dies after reporting does not
  re-report.
- The check reads `opsbot.json` and the rule card at `HEAD`.
- One writer: begin refuses on a live lock, a rebase or merge in progress, or
  `index.lock`.
- A degraded input never yields "nothing new".
- An item is new when its `key` or any entry of its `keys` is not yet seen; when it is reported, all of them are recorded. A `keys` value that is not an array of non-empty strings makes the line a bad line.
- An item with `report: false` has its keys recorded as seen and is never shown or counted as new; a check whose only items are `report: false` is nothing new. The log counts them per input as `quiet`, only when there are any. Any other `report` value is ignored.
- `commit_paths` are added to the explicit `--only` list of the check's commit and the `cycle end` commit, never anything else. `settings validate` refuses a non-array, an empty or non-string entry, an absolute path, a `..` segment, and a path under `.git/` or `.claude/`.
- `cycle end` refuses a future time, a backwards move, or no check since the lock.
- The cold-start pack's `wake.d/` sections share a budget of their own (6 000 bytes) and are truncated with "… N more lines". The rule card, the kit's sections and the session-log section are whole and outside it: a long rule card never takes room from what the bot owes. Keeping the rule card short is the bot's job; the kit does not cut it.
- House rules that must be in front of every session (how to write, when to delegate, how to read the digest, where scratch files go) ship inside the skill as `references/pack/*.md` and ride the pack, so they are updated by `npx skills update` and never copied into a bot's CLAUDE.md. `OPSBOT_PACK_DIR` overrides the directory.
- The digest is read whole, never filtered, and a stream item's `reply` field (the channel skill computes it: the thread when the message is threaded, else the message itself) is where the answer goes. Why: a bot that trimmed its digest to the text answered two questions in a third thread; the columns are the addresses.
- The gate denies every tool while the pending flag is set and the pack has not been
  read whole; a read with an offset or limit does not clear it.
- `.scratch/` is set up at every `cold-start --write`, the one command every session passes
  through: the directory is created when missing and the exclude line added when missing,
  so running it twice changes nothing. Why there: the pack was written under `~/.cache`, and
  on a fresh bot the gate's required read stopped at a permission prompt for a path outside
  the working directory; the only grant that cleared it covered far more than one file.
- The pack's earlier home, `~/.cache/<bot>/` (`$XDG_CACHE_HOME` when set), is honored once:
  while its pending flag is set and the new one is not, the gate holds for a whole read of
  the old pack, which clears it. `cold-start --write` removes the old flag. The old pack file
  is left where it is.
- `nudge` never creates a second loop; it prompts the one named agent.
- `nudge` trusts the runtime's `idle` and `blocked`, but not its `working` alone: the herdr
  adapter reads the terminal title, and Claude Code keeps the title's spinner while
  background work (a subagent, a monitor) runs after the turn has ended. On `working`,
  `nudge` reads the bot's own session log (the path the runtime names, else the pointer
  `cold-start` wrote to `.git/opsbot-session`); a `system/turn_duration` entry after the
  last assistant entry means the turn ended, and the prompt is sent with a note saying so.
  No log to read, or a turn still open, stays a refusal.

## The live wake

Between cycles a stream's event reaches the model by two paths that do not depend on each
other, in this order:

1. **In-band, first.** The session arms one bounded `Monitor` per file in `wake.files`: a
   poller that prints the new lines once and exits, with a deadline no later than the loop's
   own next wake (`cycle end` prints it bounded that way) and never past the harness's
   30-minute cap. The harness delivers the notification whether or not background work is
   running. Because the monitor exits on the first arrival or at its deadline, it cannot
   become a loop that re-arms itself; the pack's rules are: arm it again at the end of every
   cycle when it is not armed and when it reports an expiry with nothing delivered, never two
   on one file, never a longer deadline, never a different command.
2. **Out-of-band, the backstop.** The listener's `nudge --now`, which survives the session
   and covers a session that never armed (a fresh start, a compaction that dropped the rule).

Every surface prints the same lines (`wake.ts`): the state of each file read from the
session log (the last `Monitor` call on that file, its deadline, and whether a later
notice already ended it), then the exact call to arm. The cold-start pack carries them as
the last kit section, titled so the session arms before anything else; `cycle begin` and
`cycle end` carry them as a `wake` field. Without a session log the state is `unknown` and
the call is printed as the thing to do.
- The bundle emits resolved paths, never bare command names.

### The schedule monitor

With `loop.schedule: "monitor"` one monitor is both the schedule and the live wake. It
replaces the per-file monitors and the self-paced call.

- **One call.** At the end of every cycle the session arms exactly one bounded `Monitor`,
  described as `<bot> schedule`. Its command baked in the seconds until the next cycle is
  due (`end=$(( $(date +%s) + N ))`) and polls every 2 seconds. It exits when a new line
  appears in any file in `wake.files`, printing the new lines, each prefixed with the
  file's basename and cut to 300 characters; or when the deadline passes, printing one
  line, `cycle due`. The `timeout_ms` is the deadline plus a 60-second margin, so the
  command ends itself and the harness never kills it. With no `wake.files` it is only the
  timer.
- **The due time.** N is `next-delay`, capped at 1 740 seconds so that N plus the margin
  stays inside the harness's 30-minute limit.
- **What prints it.** `cycle begin` on exit 0 or 30 and `cycle end` print a `wake` field:
  the state (`armed until HH:MMZ`, or not armed) and the exact
  `Monitor({ command, description, timeout_ms })` call to make now. When a monitor is
  armed but due later than the next cycle (a cycle the monitor did not start), the line
  says to stop it and arm the new one. No self-paced guidance is printed in this mode.
- **The state.** Read from the session log: the last `Monitor` call with the schedule
  description, armed until its call time plus its baked seconds, ended by a later notice
  naming it.
- **The pack.** The cold-start pack's live-wake section is always present in this mode.
  It gives the state and the rules: the monitor is your schedule and your live wake; when
  it delivers `cycle due` or an event line, run `cycle begin`; at the end of every cycle arm
  the one monitor `cycle end` prints, exactly as printed; never call ScheduleWakeup and
  never start `/loop`; never two monitors, never a longer deadline; if you find none armed
  (after a start, a compaction, an error), arm it by running `cycle begin`. With `sleep` set
  it adds two rules: a `sleep` field means arm nothing and end the turn; a wake from sleep is
  the loop prompt followed by `(woken: <reason>)`, answered with `cycle begin`. A pack
  written while `.git/opsbot-sleep` exists (the compaction on the way down) gives the sleep
  state in place of the monitor's and says to arm nothing until the loop prompt arrives.
  The dispatcher mode section says the same in prose.
- **The backstop.** The nudge re-issues `loop.prompt`, which in this mode is a plain
  message, not a slash command. Its defaults tighten to 35 minutes, so a session whose
  monitor was not re-armed is noticed within one missed wake and a margin.

### Sleep

A loop that mostly watches spends most of its calls finding nothing. On one reviewed
dispatcher, 77 of every 100 calls were quiet ticks, each re-reading the whole context. With
`sleep` set, a bot that has been quiet long enough stops ticking: it compacts, makes no
further call, and is woken from outside the model only when there is something to do.

- **Going down.** `cycle end` and a `cycle begin` that finds nothing decide it: the last
  cycle that found anything, or the operator's last message, is `after_minutes` or more ago
  (with neither, the first cycle the log holds); the last check was not degraded; and nothing
  `due.d/` prints falls within the next `after_minutes`. The operator's message is read from
  the session log; the loop prompt, which the nudge and the sleep timer type, is not the
  operator. The command writes `.git/opsbot-sleep` (when it was decided, and the earliest
  time something is due) and prints a `sleep` field in place of the `wake` field: arm
  nothing, schedule nothing, end the turn. The log gets a `sleep` entry, committed with the
  cycle (`cycle begin` makes its own `chore(cycle): sleep` commit); a commit that fails
  means no sleep.
- **Compacting.** The session cannot compact itself. The sleep timer does it: at its next
  tick, with the session idle, it types `/compact` through the runtime adapter while the
  cache is still warm. The SessionStart hook writes the cold-start pack as after any
  compaction. No call follows, so the smaller context is written to the cache only at the
  wake, once.
- **Asleep.** The nudge and the watchdog stand down: `nudge` without `--now` does nothing
  and `watchdog` does not count the silence. `nudge --now` wakes, and its cooldown does not
  hold back the first wake of a sleep. The sleep timer is the only clock. Every
  `probe_minutes` it reads the wake files and runs `check --peek`, which costs no model
  call.
- **Waking.** Any of: a new line in a wake file (a listener's `nudge --now` wakes at once
  and is not held back by sleep), a peek that finds something or finds a stream failing,
  the recorded due time, `max_minutes`, or the operator typing into the session. The wake
  types `loop.prompt` with the reason. `cycle begin` removes `.git/opsbot-sleep`, logs a
  `wake` entry with the reason and the seconds since the event, and the loop runs as usual.
  A cycle that wakes to nothing new may decide a new sleep at once: the stretch is still
  quiet.
- **Readers.** A `sleep`…`wake` span in the log is intended silence. The stopped-outage test
  at `cycle begin` counts only the time since the wake; the 48-hour summary's longest gap
  skips the span and adds a line, `slept N times, M min in all`.
- **Never asleep unseen.** A bot can sleep at most `max_minutes` without one full cycle. A
  wake the session does not answer becomes an outage through `escalate.d/`, as a stopped
  loop does today. `infra status` and the home view say `asleep since HH:MMZ, next look
  HH:MMZ`.
- **What it costs.** Each wake after more than an hour writes the compacted context to the
  cache at the write price, about the cost of four quiet ticks at a 300k window, so
  `after_minutes` under 30 buys little. Each sleep is one more compaction than the bot
  would have had; the cold-start pack is what carries it across, and a bot whose pack is
  thin should fix that before it sleeps.
- **Only with the schedule monitor.** `settings validate` refuses `sleep` unless
  `loop.schedule` is `monitor`: the prompt is then a plain message the timer can type, and
  there is no self-paced loop to end.

## Principles

**Inherited** from `../principles.md`: the record beats the session (everything above
is a committed file); a guard in code beats a rule in prose (begin, end, gate and
settings all refuse); the schedule is not the bot's to keep (watchdog and nudge are
system timers); a failed check is said out loud (exit 20, named inputs); start slim,
leave room (the runtime is an adapter; the streams, monitors and pack sections are whatever is in `opsbot.d/`).

**Local**: *one value, one place.* Anything the launch line, a unit file or a hook needs
is read from `opsbot.json` at the moment it is needed. Nothing is rendered into a second
file without a `--check` that proves the two still agree.
