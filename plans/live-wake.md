---
status: done
done: 2026-11-07
depends: []
specs:
  - specs/skills/opsbot-core.md
  - specs/architecture.md
pr: 26
---

# The live wake: a bounded session monitor first, the nudge as backstop

## Scope

The second bot's listener delivered three operator messages to its wake file and called
`nudge --now` every ten seconds for nine minutes; every call was refused as "working
(mid-turn)". The bot's turn had ended with a background subagent running, and the
runtime (herdr) reads the terminal title, whose spinner stays up while background work
runs. The messages waited for the loop's own ten-minute fallback wakeup.

This plan adds the in-band wake and softens the nudge's gate:

- `wake.files` in `opsbot.json`: the files a listener appends one line per event to.
- `wake.ts`: the bounded monitor (a poller that prints the new lines once and exits; a
  deadline no later than the loop's next wake and never past 30 minutes), the state read
  from the session log (last `Monitor` call on the file, its deadline, a later ending
  notice), and the lines every surface prints.
- The cold-start pack's last kit section, *The live wake*, with the state, the exact call
  and the standing rules; `cycle begin` and `cycle end` print the same as a `wake` field,
  the end's deadline bounded by the next wake.
- `cold-start` persists the SessionStart hook's `transcript_path` to
  `.git/opsbot-session`, so commands that run inside the session (`cycle`) and outside it
  (`nudge`) can read the bot's own log.
- `nudge`: on `working`, read the session log (the runtime's path when herdr names the
  session, else the pointer); a `system/turn_duration` entry after the last assistant entry
  means the turn ended and the prompt goes through, with a note. No log or an open turn
  stays a refusal.

## Not in scope

Arming the monitor from outside the session (impossible: the Monitor is a session tool).
Changing what the listener does. The herdr detection rule itself (its evidence is the
title; that is herdr's call).

## Validation

- [x] A log whose last turn ended (turn_duration after the last assistant entry) is
      `ended`; a log with a pending tool call is not; an empty log is ended.
- [x] The last `Monitor` on a file is found with its deadline; a later notice naming its
      description with an ending word marks it ended; armed/expired/ended states render.
- [x] The deadline is the next wake when sooner than 30 minutes, never under a minute.
- [x] `nudge --now` prompts a `working` agent whose log shows the turn ended (noting it) and
      refuses one that is mid-turn; falls back to the pointer `cold-start` wrote; with no
      log at all it stays quiet and says why.
- [x] `cold-start` prints the live-wake section with the exact call when `wake.files` is
      set, reports `armed … until` from a transcript, and prints nothing of it otherwise.
- [x] `cycle begin` and `cycle end` carry the `wake` field from the pointer; the end's
      deadline equals the next wake under the hot cadence (180 000 ms).
- [x] `settings validate` rejects a `wake.files` that is not a list of strings.
- [x] 105 tests pass; bundle and SKILL.md rebuilt and `--check` clean.

## Notes

- 2026-11-07: the architecture had chosen "nudge, never a session-bound monitor" after
  the first bots lost about a hundred hours to monitors and crons that re-armed themselves.
  The lesson holds; the answer is a monitor that cannot re-arm itself (it exits on the
  first arrival or at a bounded deadline) rather than no monitor. The nudge keeps its role.
- The harness delivers a Monitor notification during background work; a herdr prompt is
  refused then. That asymmetry is the whole reason the monitor goes first.
- The operator's recorded words: "why herdr instead of just monitor-based wake?" and
  "go ahead and build the monitor-first wake fix".
