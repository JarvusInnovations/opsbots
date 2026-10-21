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
| `opsbot.json` | the settings file; committed; the only place any loop value is set |
| `logs/cycle.jsonl` | one line per cycle outcome; committed |
| `logs/intake/seen` | typed seen keys; committed |
| `logs/intake/watermark` | one UTC ISO line; committed |
| `logs/outages.jsonl` | outage events; committed |
| `.git/opsbot-cycle.lock` | the writer lock; never committed |
| `~/.cache/<bot>/reground.md` + `.pending` | the cold-start pack and its flag |

## Settings (`opsbot.json`)

| Key | Meaning |
| --- | --- |
| `name`, `mark` | the bot's name and the emoji mark every message opens with |
| `loop.prompt` | the exact loop prompt, including any cold-cache suffix the operator uses |
| `loop.autocompact` | the window; the launch command reads it from here |
| `cadence` | `{hot, warm, quiet_working, quiet, night, cap}` in seconds, plus `working_hours` (`days`, `start`, `end`) and `night` (`start`, `end`) in the bot's timezone |
| `lock_max_minutes` | after which a lock is abandoned |
| `liveness` | `{watchdog_minutes, nudge_minutes, nudge_cooldown_minutes}` |
| `runtime` | `{adapter: "herdr", agent: "<name>"}`; the adapter supplies `idle` and `prompt` |
| `streams[]` | `{id, adapter, posture, ...adapter args}`; see the adapter contract |
| `escalate.command` | an executable the core calls with a message on stdin to reach the operator |
| `repo_sync` | `pull-on-clean` or `never-pull` |

`settings validate` refuses a file with an unknown key, a missing required key, or a
cadence value over the cap.

## Commands

| Command | Does | Exit |
| --- | --- | --- |
| *(none)* | home: bot name, bin path, last cycle outcome and age, lock state, next wake, counts of failed inputs and open outages; three help lines | 0 |
| `check` | runs every stream adapter, aggregates, records seen keys, logs, commits; prints the digest or one line | 0 nothing new · 10 new · 20 degraded · 2 cannot run |
| `cycle begin` | refuses while another writer holds the checkout; takes the lock; records a `stopped` outage if overdue; runs `check`; on 0 releases and prints the closing line | as `check`; 30 wait |
| `cycle end --records N [--degraded] [--summary TEXT]` | pins the watermark to this cycle's check time; appends `finished`; commits with `--only`; pushes; releases; prints due items if a `due.command` is configured, then `next <s> <reason>` | 0 · 1 |
| `next-delay` | reads the log and the cadence table; prints `<seconds> <reason>` | 0 |
| `cold-start [--write]` | prints the pack in order: rule card, owed (via `owed.command` if configured), 48 h log summary, the untrusted-memory line; `--write` also writes the pack file and sets pending | 0 |
| `gate check` | the PreToolUse body: exit 0 when nothing is pending or the pending pack was read whole; otherwise prints the deny reason and exits 2 | 0 · 2 |
| `lock status|release` | shows or releases the lock (release refuses another live process's lock without `--abandon`) | 0 · 1 |
| `outage record <kind> [--note]` / `outage end` / `outage list` | `failed-turn · refused · plan-limit · session-ended · stopped`; end closes the open one | 0 |
| `watchdog` | if no cycle has logged within `watchdog_minutes`, escalates once per outage and records it; records the end when cycles resume | 0 |
| `nudge [--now]` | if quiet past `nudge_minutes`, no lock, cooldown passed, and the runtime reports idle, re-issues `loop.prompt` through the runtime adapter; `--now` skips the quiet test | 0 · 1 |
| `infra install|uninstall|status` | renders and enables the two systemd user timers from the templates with this repo's paths | 0 · 1 |
| `hook install|uninstall|status` | registers the SessionStart (`cold-start --write`) and PreToolUse (`gate check`) hooks, project scope by default | 0 |
| `log tail [--n N]` | the last N cycle lines, one per row | 0 |

Every command prints TOON on stdout, errors on stdout with a `help` line, nothing on
stdout that is not data.

## The stream adapter contract

A stream adapter is any executable. The check calls it as
`<adapter> --since <ISO> --seen <path> --config <json>` and reads NDJSON on stdout, one
item per line: `{key, at, conv, kind: "group"|"dm", from, text, ...}`. `key` is the typed
seen key. Exit 0 with no lines means nothing new; non-zero means the input failed and
the check reports it as degraded by name. The check never reads a stream itself; the
channel skills ship the adapters.

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
leave room (the runtime and the streams are adapters).

**Local**: *one value, one place.* Anything the launch line, a unit file or a hook needs
is read from `opsbot.json` at the moment it is needed. Nothing is rendered into a second
file without a `--check` that proves the two still agree.
