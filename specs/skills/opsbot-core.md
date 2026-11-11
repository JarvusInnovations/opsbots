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
  templates/*.service|timer  systemd user units for watchdog and nudge
```

The bot's own files the skill reads and writes:

| Path | What |
| --- | --- |
| `opsbot.json` | the settings file; committed; the only place any loop *value* is set |
| `opsbot.d/` | the lifecycle directories; every executable in them is picked up (see below) |
| `logs/cycle.jsonl` | one line per cycle outcome; committed |
| `logs/intake/seen` | typed seen keys; committed |
| `logs/intake/watermark` | one UTC ISO line; committed |
| `logs/outages.jsonl` | outage events `{at, outcome: "outage"\|"outage-end", kind, started, ended, note}`; committed with the next cycle; readers also accept outage lines found in `logs/cycle.jsonl`, where an earlier bot wrote them |
| `.git/opsbot-cycle.lock` | the writer lock; never committed |
| `.git/opsbot-{watchdog,nudge,nudge-now}` | the watchdog's told-once marker and the nudge cooldowns; never committed |
| `~/.cache/<bot>/reground.md` + `reground.pending` | the cold-start pack and its flag (`$XDG_CACHE_HOME` when set) |

## Settings (`opsbot.json`)

| Key | Meaning |
| --- | --- |
| `name`, `mark` | the bot's name (`[a-z][a-z0-9-]*`, used in unit names and the cache path) and the emoji mark every message opens with |
| `timezone` | IANA zone for the cadence hours and every human-facing time; default `UTC` |
| `rule_card` | repo path of the rule card the cold-start pack opens with, read at `HEAD`; optional |
| `gate_word` | optional; capital letters only; the check flags its presence as a whole word, never judges it |
| `loop.prompt` | the exact loop prompt, including any cold-cache suffix the operator uses |
| `loop.autocompact` | the window (`750k`, `600000`); unset, it follows `loop.mode`: `750k` for a strategist, `300k` for a dispatcher (every call reads the whole window from cache, so a loop that mostly watches pays for a context it does not use); `start` sets it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the session's environment and its `--settings` `env`, the one control Claude Code honors (the `--autocompact` flag and `autoCompactWindow` were ignored on two bots; the env var works on a third) |
| `loop.mode` | `strategist` (default) or `dispatcher` ([principles](../principles.md#the-loops-class-follows-its-work-strategist-or-dispatcher)): picks the model `start` passes when `loop.model` is unset (`fable` or `opus`), the window when `loop.autocompact` is unset (`750k` or `300k`), a dispatcher's quiet cadence when it has `wake.files` (below), and which `references/pack/NN-mode-<mode>.md` section rides the pack |
| `loop.model`, `loop.permission_mode` | what `start` passes as `--model` and `--permission-mode` (default `auto`); the only place the launch flags are set |
| `cadence` | `{hot, warm, quiet_working, quiet, night, cap}` in seconds, plus `working_hours` (`days` as ISO weekday numbers 1–7, `start`, `end` as `HH:MM`) and `night_hours` (`start`, `end`, a span that may cross midnight) in the bot's timezone; every key optional, defaulting to the architecture's table (working hours Monday–Friday 09:00–17:00, night 22:00–07:00); for a dispatcher with `wake.files`, unset `quiet_working` and `quiet` default to `cap`, because its streams wake it and the timer only keeps the cache warm |
| `lock_max_minutes` | after which a lock is abandoned |
| `liveness` | `{watchdog_minutes, nudge_minutes, nudge_cooldown_minutes, wake_cooldown_minutes, interval_minutes}`: the stop limit (60), the quiet limit before a nudge (50), the nudge's cooldown (50), the cooldown of `nudge --now` (10), and how often the watchdog and nudge timers fire (10; the nudge runs half an interval after the watchdog) |
| `runtime` | `{adapter: "herdr", agent: "<name>"}`; the adapter supplies `idle` and `prompt`. The herdr adapter finds the bot's pane by that name first and, when the name is missing (a renamed pane, a restarted herdr), by the one agent whose cwd is the bot's checkout; it prompts the pane, not the name |
| `streams.<name>` | per-stream values a heartbeat script reads (postures, ids, lookbacks); the script is found by name in `opsbot.d/heartbeat.d/`, not listed here |
| `repo_sync` | `pull-on-clean` or `never-pull` |
| `host` | optional; belongs to the `opsbot-host` skill (display, VNC and bridge ports); `settings validate` accepts it as an object and does not look inside |
| `commit_paths` | optional; repo-relative files the check's commit and the `cycle end` commit also take when they exist and have changes (a baseline an adapter updates, an append-only log a helper script writes between cycles); a listed file that does not exist is skipped |
| `wake.files` | optional; the files a `monitor.d/` listener appends one line per event to. The core prints, in the cold-start pack and at every `cycle begin` and `cycle end`, the state of each (armed until when, or not armed) and the exact bounded `Monitor` call that arms it; see *The live wake* below |

`settings validate` refuses a file with an unknown key, a missing required key, or a
cadence value over the cap. Required: `name`, `mark`, `loop.prompt`, `runtime.agent`. A
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
| *(none)* | home: bot name, bin path, last cycle outcome and age, lock state, next wake, counts of failed inputs and open outages; three help lines | 0 |
| `check` | runs every script in `heartbeat.d/`, aggregates, records seen keys, logs, commits; prints the digest or one line | 0 nothing new · 10 new · 20 degraded · 2 cannot run |
| `cycle begin` | refuses while another writer holds the checkout; takes the lock; records a `stopped` outage if overdue; runs `cycle.d/begin/`; runs `check`; on 0 releases and prints the closing line | as `check`; 30 wait |
| `cycle end --records N [--degraded] [--summary TEXT]` | runs `cycle.d/end/`; pins the watermark to this cycle's check time; appends `finished`; commits with `--only`; pushes; releases; prints whatever `cycle.d/end/` scripts printed (due promises, owed fixes), then `next <s> <reason>` | 0 · 1 refused (nothing written; the lock released) or could not commit (the lock kept) |
| `next-delay` | reads the log and the cadence table; prints `<seconds> <reason>` | 0 |
| `start [--continue] [--dry-run] [-- <extra>]` | launches `claude` with the flags `opsbot.json` implies: permission mode, model, autocompact window, `autoCompactEnabled: true` via `--settings`, and `loop.prompt` as the first message; `--continue` resumes the last session in this checkout; the bot's `bin/start` shim is two lines calling this | exit code of `claude` |
| `cold-start [--write] [--transcript <jsonl>]` | prints the pack: the rule card; the kit's own sections (`references/pack/*.md` shipped with the skill, in order, whole: house writing style, delegation rubric); then, when the SessionStart hook payload on stdin names a `transcript_path` (or `--transcript` does), a "Before this start" section read from the bot's own session log since its last compaction through `agent-recall-axi` (bundled; the kit's own text reader is the fallback when the library cannot read the log): the operator's messages verbatim (the highest-authority record of intent; the loop prompt excluded, since the nudge and the bot's wakeups type it), newest kept whole within their share and the rest counted with the exact command that prints them; the last tool calls with their status as data; and the bot's last statements flagged as its own claims, each layer with its own share so one long message cannot crowd out the others, capped at 4 000 bytes; then every script in `wake.d/` in order (each prints one section); then the 48 h log summary and the untrusted-memory line; `--write` also writes the pack file and sets pending | 0 |
| `gate check` | the PreToolUse body: exit 0 when nothing is pending or the pending pack was read whole; otherwise prints the deny reason and exits 2 | 0 · 2 |
| `lock status|release` | shows or releases the lock (release refuses another live process's lock without `--abandon`) | 0 · 1 |
| `outage record <kind> [--note] [--started] [--ended]` / `outage end [--ended]` / `outage list` | `failed-turn · refused · plan-limit · session-ended · stopped`; times default to now; end closes the open one | 0 |
| `watchdog [--dry-run]` | if no cycle has logged within `watchdog_minutes`, escalates once per outage through `escalate.d/` and records it; records the end when cycles resume | 0 · 1 could not escalate (no script, or every one failed) |
| `nudge [--now [--reason TEXT]] [--dry-run]` | if quiet past `nudge_minutes`, no lock, cooldown passed, and the runtime reports idle, re-issues `loop.prompt` verbatim through the runtime adapter; `--now` skips the quiet test and has its own shorter cooldown | 0 · 1 |
| `infra install|uninstall|status [--dry-run]` | renders and enables the watchdog and nudge timers, plus one service or timer per script in `monitor.d/`, with this repo's paths; `status` compares each installed unit with what `install` would render now and says which are stale | 0 · 1 |
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
watermark itself (empty with none). A heartbeat script that exits non-zero has its
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
| `escalate.d/` | when the core must reach the operator | receives the message on stdin; every script runs (a chat DM, a push notification); the core needs at least one or `watchdog` reports itself unable to escalate |

The core runs nothing from these directories that the bot's repo did not put there; it ships one adapter as a template to copy (`templates/heartbeat.d/50-peer-sessions`, below) and test fixtures. A channel skill
installs its adapter into `heartbeat.d/` and its listener into `monitor.d/`; the record
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
- House rules that must be in front of every session (how to write, when to delegate, how to read the digest) ship inside the skill as `references/pack/*.md` and ride the pack, so they are updated by `npx skills update` and never copied into a bot's CLAUDE.md. `OPSBOT_PACK_DIR` overrides the directory.
- The digest is read whole, never filtered, and a stream item's `reply` field (the channel skill computes it: the thread when the message is threaded, else the message itself) is where the answer goes. Why: a bot that trimmed its digest to the text answered two questions in a third thread; the columns are the addresses.
- The gate denies every tool while the pending flag is set and the pack has not been
  read whole; a read with an offset or limit does not clear it.
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

## Principles

**Inherited** from `../principles.md`: the record beats the session (everything above
is a committed file); a guard in code beats a rule in prose (begin, end, gate and
settings all refuse); the schedule is not the bot's to keep (watchdog and nudge are
system timers); a failed check is said out loud (exit 20, named inputs); start slim,
leave room (the runtime is an adapter; the streams, monitors and pack sections are whatever is in `opsbot.d/`).

**Local**: *one value, one place.* Anything the launch line, a unit file or a hook needs
is read from `opsbot.json` at the moment it is needed. Nothing is rendered into a second
file without a `--check` that proves the two still agree.
