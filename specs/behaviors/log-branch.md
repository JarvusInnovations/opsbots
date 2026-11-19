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
| `quiet` | hour, counting the cycles that found nothing | `quiet/YYYY/MM/DD/HH` |
| `seen` | key reported to the session | `seen/YYYY/MM/DD/<key hash>` |
| `posts/<channel>` | post attempt | `posts/<channel>/YYYY/MM/DD/<mmss>-<hash>` |

- **Time is in the path, never in the body.** Two cycles with the same outcome and counts are
  the same blob.
- **What stays on the program branch:** everything a person reads or edits there, including
  the bot's records (`tasks`, `work`, any sheet with a recall) and its memory files. Only the
  loop's own log moves. A separate data branch for records is a later question, if a bot's
  records grow to need one.

## Provenance: the second parent

A log commit's first parent is the previous log commit. Its second parent is the program
commit the cycle ran on. The log branch then says, in the graph itself, which program each
cycle was built on: this truth was built on top of the world of that truth. The program
branch never points back.

A second parent here means lineage, not a merge, as it does in the other tools of this family
that use git as a content-addressed store with their own interface on top. Nothing merges
into or out of the log branch, so no command that reads a second parent as "merged" is ever
run on it.

- **Open:** on every log commit, or only on the first after the program's head moved (the
  graph then shows the points where the program changed under the loop, and nothing else).

## Watermark

The watermark is a trailer on the log commit, `Watermark: <ISO time>`, with
`Check: full|fast` beside it. The newest log commit's trailer is the watermark a cold start
resumes from.

## Quiet cycles

A cycle that found nothing writes no commit. It updates a local file under the git dir: the
exact watermark, and the liveness stamp the watchdog reads. The next commit, or the hourly
`quiet` record, carries the newest watermark in its trailer.

So the watermark in git can be behind the truth by up to an hour of quiet cycles. A cold
start from git alone then re-checks that hour, and the seen keys drop what was already
reported: nothing is missed and nothing is reported twice.

- **Open:** hourly `quiet` records (written here), or a commit for every cycle, with the
  identical blob doing the saving and the watermark exact in git at all times.

## Pushing

The log branch is pushed at `cycle end` with a plain push, never forced. The log is
append-only and has one writer, so a refused push means another host is running the same
bot: that is a failed check, said out loud.

## What this removes

- `chore(cycle): …` commits on the program branch, and `commit_paths` for the loop's logs.
- For a bot whose repo people work in: the second "live" branch, its rebase, its promotion
  commit and its repair tool. Its checkout follows the default branch like any clone, and the
  few files it writes there itself (records, memory) are ordinary small commits.
- A dirty log file blocking a pull.

## What it needs

- gitsheets with headless data branches on the host, installed by `opsbot-host`.
- Two things the gitsheets CLI does not offer today, to be added there first: trailers on a
  write's commit, and an additional parent on a write's commit.
- A migration: at the first cycle after an update, the existing `logs/` content becomes the
  log branch's root, and the files leave the program branch in one commit a person merges.

## Tests

- A cycle commits to the log branch only; the program branch's head and working tree are
  unchanged after a cycle that changed no record.
- Two cycles with the same outcome produce one blob.
- The second parent is the program commit the cycle ran on.
- A cold start from a fresh clone resumes from the newest trailer; an hour of quiet cycles
  lost with the local file is re-checked and reports nothing twice.
- The watchdog, `next-delay` and the sleep timer read liveness without a commit per cycle.
- A refused push fails the check and loses nothing.
