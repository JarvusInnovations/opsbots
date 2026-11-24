# Behavior: the loop's log lives on its own branch

> Planned: `plans/log-branch-core.md`, `plans/log-branch-ledgers.md`,
> `plans/log-branch-migrate.md`. A bot opts in with `log.branch` until the migration plan
> makes it the only writer.

## Rule

Everything the loop writes that no person edits is written to a branch of its own,
`opsbot/log` by default, which is never checked out: what each cycle checked and found, what
it posted, what its scripts did, and what its checks remember between runs. The branch people
read and work on carries the bot's program and its records, and no commit made by a cycle for
its own bookkeeping.

The test for which side a file belongs on: **would a person ever open it to change it?** If
not, it is the loop's, and it goes on the log branch.

> Why: on an adopting bot, 1,731 of 1,749 commits ahead of the main branch were cycle commits,
> 717 of them "nothing new". A bot whose repo people also work in needed a second branch and a
> rebase-and-promote script to keep those commits off main, and that script failed three ways
> in one day.

## What is on the log branch

Written through gitsheets, bound to the branch, so there is no working tree, no submodule and
no second clone:

| Sheet | One record per | Path |
| --- | --- | --- |
| `cycles` | line the loop logs: a check's result, a cycle's end, a sleep, a wake | `cycles/YYYY/MM/DD/HH/<mmss>-<outcome>` |
| `seen` | key reported to the session | `seen/YYYY/MM/DD/<key hash>` |
| `posts/<channel>` | post attempt | `posts/<channel>/YYYY/MM/DD/<hhmmss>-<hash>` |
| `outages` | outage a check accounted for | `outages/YYYY/MM/DD/<hhmmss>-<kind>-<start or end>` |
| `routines` | routine run | `routines/<routine>/YYYY/MM/DD/<hhmmss>-<hash>` |
| `ledgers/<name>` | action a script took (a label applied, a mail sent, a row written) | `ledgers/<name>/YYYY/MM/DD/<hhmmss>-<hash>` |
| `state/<name>` | baseline a check compares against (one record, replaced) | `state/<name>` |

The first three and `outages` and `routines` are the kit's. A bot declares its own `ledgers`
and `state` names in `opsbot.json` under `log.ledgers` and `log.state`, each with the fields
a record must carry.

- **Scripts never touch the branch themselves.** A hook or skill script writes with
  `opsbot-core log append <ledger>` (a JSON record on stdin) or `opsbot-core log state set
  <name>`, and reads with `opsbot-core log read <sheet> [--since <time>] [--filter …]` and
  `opsbot-core log state get <name>`. Writes made during a cycle ride that cycle's commit.
  A write made outside a cycle (a person running a script by hand) is its own commit.
- **A ledger record that changes later is a record, not a log line.** A ledger is
  append-only. Something a script goes back and edits (a request that is opened and then
  closed) belongs in a sheet on the program branch, with a recall if it must come back.
- **Another bot's log is read from its branch.** A bot that needs another bot's ledger
  fetches that bot's log branch and reads it with `opsbot-core log read --repo <path or
  remote>`; it never depends on a file in the other bot's working tree.

- **Time is in the path.** Every record is filed by when it happened, so a read of a day or
  an hour walks only that part of the tree. The record also carries its time (`at`): gitsheets
  requires a record to hold every field its path is built from. Quiet cycles, the bulk of the
  volume, write no record at all (see "Quiet cycles"), so nothing is gained by keeping the
  time out of the body.
- **An outage is one event per second, kind and edge.** Two records of the same kind of
  outage starting (or ending) in the same second, from two watchers that saw the same thing,
  are one record: the later one replaces the earlier. Nothing is lost, because they describe
  the same moment.
- **A cycle is one commit, however many records it writes.** Records made between a check and
  the cycle's end, or by a script outside a cycle, wait in a pending file under the git
  directory and are written with the next log commit.
- **What stays on the program branch:** everything a person reads or edits there, including
  the bot's records (`tasks`, `work`, any sheet with a recall) and its memory files. Only the
  loop's own log moves. A separate data branch for records is a later question, if a bot's
  records grow to need one.

## Provenance: the second parent

A log commit's first parent is the previous log commit. On the first log commit after the
program's head moved, a second parent names the program commit the cycle ran on. The branch's
root is a setup commit that holds only the sheet configs (gitsheets gives a root commit no
additional parent), so the first log commit after it is the first to carry one. The log branch then shows, in the graph itself, the points where the program
changed under the loop: this truth was built on top of the world of that truth. Every log
commit between two such points ran on the same program. The program branch never points back.

A second parent here means lineage, not a merge, as it does in the other tools of this family
that use git as a content-addressed store with their own interface on top. Nothing merges
into or out of the log branch, so no command that reads a second parent as "merged" is ever
run on it.

## Watermark

The watermark is a trailer on the log commit, `Watermark: <ISO time>`, with
`Check: full|fast` and `Program: <commit>` (the program commit the cycle ran on) beside it.
The `Program` trailer is on every log commit, so deciding whether the program's head moved
needs only the tip. The newest log commit's trailer is the watermark a cold start
resumes from. It is always in git: no cycle advances the watermark anywhere else.

## Quiet cycles

A run of cycles that found nothing is one commit, amended as it grows.

- A quiet cycle whose branch tip is already an **open quiet commit** replaces that commit
  with one that has the same parents, the new `Watermark`, and `Quiet-Cycles: <n>` one
  higher, with `Quiet-Since: <ISO time>` unchanged. Its tree is the same as before: a quiet
  cycle changes no record. Every trailer is written again on the replacement.
- A quiet commit also carries `Quiet-Until: <ISO time>`, when its newest cycle ran, and
  `Since: <ISO time>`, the start of the window a fast check reuses. A fast check does not
  move `Watermark`, so `Quiet-Until` is what shows the run was alive. With any
  `cycle.d/begin/` script run, it carries `Hook-Times: <name>=<seconds>, …`, its newest
  cycle's times ([Hook times](../skills/opsbot-core.md#hook-times-and-skipping-a-hook)).
- A quiet commit is replaced only by a quiet check of the same `Check` kind on the same
  `Program`. A fast run and a full run, or runs on two program commits, are separate commits.
- A quiet cycle whose tip is anything else adds a new quiet commit with `Quiet-Cycles: 1`.
- A quiet commit is **sealed**, and never amended again, when a cycle that found something
  commits on top of it, or when the hour turns, whichever comes first. The next quiet cycle
  then starts a new one. So a day of nothing is at most 24 commits, each saying how many
  cycles it stands for and through when.
- The watchdog and `next-delay` read the tip's trailers. A quiet run is alive as of its
  `Watermark`.

## Pushing

The log branch is pushed at `cycle end` with a plain push, never forced. An open quiet commit
is not pushed: the push sends the branch up to the newest sealed commit (gitsheets' push to a
named commit), so a commit that has
reached the remote is never rewritten. At most the current hour's quiet run exists only on
the host. The log has one writer, so a refused push means another host is running the same
bot: that is a failed check, said out loud.

## What this removes

- `chore(cycle): …` commits on the program branch.
- The `commit_paths` setting, entirely: every file it listed (cycle log, seen keys, post logs,
  action ledgers, baselines, outages, routine runs) is on the log branch.
- The commit-then-roll-back paths in `check` and `cycle end`.
- Per-bot repo-sync hooks. With nothing of the loop's in the working tree, `cycle begin`
  fast-forwards the checkout itself (`repo_sync: pull`, the default; `never` to turn it
  off). A checkout that cannot fast-forward (a person's unpushed work, a diverged branch) is
  a heartbeat item naming the two commits, and the cycle goes on with what it has.
- For a bot whose repo people work in: the second "live" branch, its rebase, its promotion
  commit and its repair tool. Its checkout follows the default branch like any clone, and the
  few files it writes there itself (records, memory) are ordinary small commits.
- A dirty log file blocking a pull.

## Readers

Nothing reads `logs/*.jsonl` from the working tree any more. The watchdog, `next-delay`, the
sleep timer, the cold-start pack's "before this start", the fast-check window, the wake
backstop and the memory review read the tip's trailers and the `cycles` sheet. The channel
listeners ask `opsbot-core log seen <key>` instead of reading the seen file. A read of the
tip's trailers is one git call and opens no sheet.

## What it needs

- gitsheets with headless data branches on the host, installed by `opsbot-host`.
- gitsheets 2.15 or later, for its commit options: a push of a branch up to a named commit, a
  read of the tip commit with its trailers and parents, trailers and additional parents on a
  write's commit, replacing the branch tip when it is the commit the caller expects and has
  not been pushed, and a commit that changes no record, for a quiet cycle.
- A migration, `opsbot-core log migrate`: it writes the existing log files (everything
  `commit_paths` listed, plus the kit's own) to the log branch as its root, and prepares one
  commit on the program branch that removes those files and the `commit_paths` setting, for
  a person to merge. Until that commit is merged the loop keeps writing the old way; it
  never runs half in each.

## Tests

- A cycle commits to the log branch only; the program branch's head and working tree are
  unchanged after a cycle that changed no record.
- The root holds only the sheet configs. The second parent is the program commit, present on
  the first log commit after the root and on the first after the program's head moved, and on
  no other.
- Two records of one sheet made at the same minute and second of different hours are two
  files.
- A run of quiet cycles is one commit whose count and watermark grow; it is sealed by the
  hour and by a cycle that found something; a sealed or pushed commit is never rewritten.
- A cold start from a fresh clone resumes from the newest pushed trailer; the unpushed open
  quiet run is re-checked and reports nothing twice.
- The watchdog, `next-delay` and the sleep timer read liveness without a commit per cycle.
- A refused push fails the check and loses nothing.
- A ledger write and a state write made in a cycle land in that cycle's commit; one made
  outside a cycle is its own commit; neither changes the working tree.
- After the migration, a full cycle with ledger and baseline writes leaves `git status` clean
  on the program branch, and `cycle begin` fast-forwards a checkout that is behind.
- A checkout that cannot fast-forward is reported and does not stop the cycle.
- A second bot reads the first bot's ledger from its fetched log branch.
