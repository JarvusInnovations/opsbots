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
| `loop.autocompact` | the window; the launch command reads it from here |
| `cadence` | `{hot, warm, quiet_working, quiet, night, cap}` in seconds, plus `working_hours` (`days` as ISO weekday numbers 1–7, `start`, `end` as `HH:MM`) and `night` (`start`, `end`) in the bot's timezone; every key optional, defaulting to the architecture's table (working hours Monday–Friday 09:00–17:00, night 22:00–07:00) |
| `lock_max_minutes` | after which a lock is abandoned |
| `liveness` | `{watchdog_minutes, nudge_minutes, nudge_cooldown_minutes, wake_cooldown_minutes, interval_minutes}`: the stop limit (60), the quiet limit before a nudge (50), the nudge's cooldown (50), the cooldown of `nudge --now` (10), and how often the watchdog and nudge timers fire (10; the nudge runs half an interval after the watchdog) |
| `runtime` | `{adapter: "herdr", agent: "<name>"}`; the adapter supplies `idle` and `prompt` |
| `streams.<name>` | per-stream values a heartbeat script reads (postures, ids, lookbacks); the script is found by name in `opsbot.d/heartbeat.d/`, not listed here |
| `repo_sync` | `pull-on-clean` or `never-pull` |

`settings validate` refuses a file with an unknown key, a missing required key, or a
cadence value over the cap. Required: `name`, `mark`, `loop.prompt`, `runtime.agent`. A
key named `//` is a comment and is allowed at any level, since JSON has no comments.
`streams.<name>` objects are the heartbeat scripts' own and are not checked inside.
When `.claude/settings.json` sets `autoCompactWindow`, `settings validate` refuses it
unless it equals `loop.autocompact` (one value, one place).

## Commands

| Command | Does | Exit |
| --- | --- | --- |
| *(none)* | home: bot name, bin path, last cycle outcome and age, lock state, next wake, counts of failed inputs and open outages; three help lines | 0 |
| `check` | runs every script in `heartbeat.d/`, aggregates, records seen keys, logs, commits; prints the digest or one line | 0 nothing new · 10 new · 20 degraded · 2 cannot run |
| `cycle begin` | refuses while another writer holds the checkout; takes the lock; records a `stopped` outage if overdue; runs `cycle.d/begin/`; runs `check`; on 0 releases and prints the closing line | as `check`; 30 wait |
| `cycle end --records N [--degraded] [--summary TEXT]` | runs `cycle.d/end/`; pins the watermark to this cycle's check time; appends `finished`; commits with `--only`; pushes; releases; prints whatever `cycle.d/end/` scripts printed (due promises, owed fixes), then `next <s> <reason>` | 0 · 1 refused (nothing written; the lock released) or could not commit (the lock kept) |
| `next-delay` | reads the log and the cadence table; prints `<seconds> <reason>` | 0 |
| `cold-start [--write]` | prints the pack: the rule card, then every script in `wake.d/` in order (each prints one section), then the 48 h log summary and the untrusted-memory line; `--write` also writes the pack file and sets pending | 0 |
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
over-report its window.

| Directory | When | Contract |
| --- | --- | --- |
| `heartbeat.d/` | every `check` | a stream adapter: prints NDJSON items `{key, at, conv, kind: "group"\|"dm", from, text, ...}`; `key` is the typed seen key; exit 0 with no lines = nothing new; non-zero = this input failed, reported as degraded by the script's name |
| `monitor.d/` | always on | a long-running watcher or a timed probe; `infra install` renders it as a user service (`monitor.d/<name>`) or timer (`monitor.d/<name>@<interval>`); it wakes the loop by running `<core> nudge --now` |
| `cycle.d/begin/` | after the lock, before `check` | housekeeping that must run first (a repo sync, a cache warm); non-zero aborts the cycle as degraded |
| `cycle.d/end/` | after records, before the commit | what to show at the close: due promises, fixes not yet told, anything the operator should see this cycle; stdout is appended to the closing line |
| `wake.d/` | every cold start | one section of the reground pack each (what is owed, open escalations, …); each capped to its share of the byte budget |
| `escalate.d/` | when the core must reach the operator | receives the message on stdin; every script runs (a chat DM, a push notification); the core needs at least one or `watchdog` reports itself unable to escalate |

The core ships nothing in these directories except test fixtures. A channel skill
installs its adapter into `heartbeat.d/` and its listener into `monitor.d/`; the record
skill installs `wake.d/20-owed` and `cycle.d/end/20-due`; a bot's own script goes in
the same way. `opsbot-core hooks list` shows what will run at each point and in what
order.

## Rules the commands enforce

- The watermark moves only forward, only from the clock, only to a time at or before
  the check that this cycle ran; a degraded cycle leaves it.
- Seen keys are recorded at report time, so a cycle that dies after reporting does not
  re-report.
- The check reads `opsbot.json` and the rule card at `HEAD`.
- One writer: begin refuses on a live lock, a rebase or merge in progress, or
  `index.lock`.
- A degraded input never yields "nothing new".
- `cycle end` refuses a future time, a backwards move, or no check since the lock.
- The cold-start pack is capped at a byte budget; lists are truncated with "… N more".
- The gate denies every tool while the pending flag is set and the pack has not been
  read whole; a read with an offset or limit does not clear it.
- `nudge` never creates a second loop; it prompts the one named agent.
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
