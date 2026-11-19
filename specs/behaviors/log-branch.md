# Behavior: the loop's log lives on its own branch

> Draft, on a planning PR. Decisions still open are marked **Open**.

## Rule

The loop's own log (what each cycle checked, what it found, what it posted) is written to a
branch of its own, `opsbot/log` by default, which is never checked out. The branch people
read and work on carries the bot's program and its records, and no cycle commits.

> Why: on an adopting bot, 1,731 of 1,749 commits ahead of the main branch were cycle commits,
> 717 of them "nothing new". A bot whose repo people also work in needed a second branch and a
> rebase-and-promote script to keep those commits off main, and that script failed three ways
> in one day.

## What is on the log branch

Written through gitsheets, bound to the branch, so there is no working tree, no submodule and
no second clone:

| Sheet | One record per | Path |
| --- | --- | --- |
| `cycles` | cycle that found or did something | `cycles/YYYY/MM/DD/HH/<mmss>-<outcome>` |
| `seen` | key reported to the session | `seen/YYYY/MM/DD/<key hash>` |
| `posts/<channel>` | post attempt | `posts/<channel>/YYYY/MM/DD/<mmss>-<hash>` |

- **Time is in the path, never in the body.** Two cycles with the same outcome and counts are
  the same blob.
- **What stays on the program branch:** everything a person reads or edits there, including
  the bot's records (`tasks`, `work`, any sheet with a recall) and its memory files. Only the
  loop's own log moves. A separate data branch for records is a later question, if a bot's
  records grow to need one.

## Provenance: the second parent

A log commit's first parent is the previous log commit. On the first log commit after the
program's head moved, and on the branch's root, a second parent names the program commit the
cycle ran on. The log branch then shows, in the graph itself, the points where the program
changed under the loop: this truth was built on top of the world of that truth. Every log
commit between two such points ran on the same program. The program branch never points back.

A second parent here means lineage, not a merge, as it does in the other tools of this family
that use git as a content-addressed store with their own interface on top. Nothing merges
into or out of the log branch, so no command that reads a second parent as "merged" is ever
run on it.

## Watermark

The watermark is a trailer on the log commit, `Watermark: <ISO time>`, with
`Check: full|fast` beside it. The newest log commit's trailer is the watermark a cold start
resumes from. It is always in git: no cycle advances the watermark anywhere else.

## Quiet cycles

A run of cycles that found nothing is one commit, amended as it grows.

- A quiet cycle whose branch tip is already an **open quiet commit** replaces that commit
  with one that has the same parents, the new `Watermark`, and `Quiet-Cycles: <n>` one
  higher, with `Quiet-Since: <ISO time>` unchanged. Its tree is the same as before: a quiet
  cycle changes no record.
- A quiet cycle whose tip is anything else adds a new quiet commit with `Quiet-Cycles: 1`.
- A quiet commit is **sealed**, and never amended again, when a cycle that found something
  commits on top of it, or when the hour turns, whichever comes first. The next quiet cycle
  then starts a new one. So a day of nothing is at most 24 commits, each saying how many
  cycles it stands for and through when.
- The watchdog and `next-delay` read the tip's trailers. A quiet run is alive as of its
  `Watermark`.

## Pushing

The log branch is pushed at `cycle end` with a plain push, never forced. An open quiet commit
is not pushed: the push sends the branch up to the newest sealed commit, so a commit that has
reached the remote is never rewritten. At most the current hour's quiet run exists only on
the host. The log has one writer, so a refused push means another host is running the same
bot: that is a failed check, said out loud.

## What this removes

- `chore(cycle): …` commits on the program branch, and `commit_paths` for the loop's logs.
- For a bot whose repo people work in: the second "live" branch, its rebase, its promotion
  commit and its repair tool. Its checkout follows the default branch like any clone, and the
  few files it writes there itself (records, memory) are ordinary small commits.
- A dirty log file blocking a pull.

## What it needs

- gitsheets with headless data branches on the host, installed by `opsbot-host`.
- Three things gitsheets does not offer on a write today, to be added there first: trailers
  on the commit, additional parents on the commit, and replacing the branch tip (an amend)
  when the tip is the commit the caller expects. Also a commit that changes no record, for a
  quiet cycle.
- A migration: at the first cycle after an update, the existing `logs/` content becomes the
  log branch's root, and the files leave the program branch in one commit a person merges.

## Tests

- A cycle commits to the log branch only; the program branch's head and working tree are
  unchanged after a cycle that changed no record.
- Two cycles with the same outcome produce one blob.
- The second parent is the program commit, present on the root and on the first log commit
  after the program's head moved, and on no other.
- A run of quiet cycles is one commit whose count and watermark grow; it is sealed by the
  hour and by a cycle that found something; a sealed or pushed commit is never rewritten.
- A cold start from a fresh clone resumes from the newest pushed trailer; the unpushed open
  quiet run is re-checked and reports nothing twice.
- The watchdog, `next-delay` and the sleep timer read liveness without a commit per cycle.
- A refused push fails the check and loses nothing.
