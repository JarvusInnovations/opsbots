---
status: done
pr: 128
depends: [log-branch-core]
specs:
  - specs/behaviors/log-branch.md
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-whatsapp.md
  - specs/skills/opsbot-google.md
---

# Ledgers, state and post logs on the log branch

## Scope

Everything else the loop writes that no person edits: post logs, bot-declared action ledgers
and check baselines, and the commands scripts use to write and read them. Out of scope:
moving an existing bot's files (`log-branch-migrate`).

## Implements

`specs/behaviors/log-branch.md`: the `posts`, `ledgers` and `state` sheets, "Scripts never
touch the branch themselves", "Another bot's log is read from its branch", "Readers" (the
listeners).

## Approach

1. **Settings.** `log.ledgers` and `log.state` in `opsbot.json`, each a name with the fields a
   record must carry; `settings validate` checks them and generates the sheet configs.
2. **Commands.** `opsbot-core log append <ledger>`, `log state get|set <name>`, `log read
   <sheet> [--since] [--filter] [--repo]`, `log seen <key>`. Inside a cycle (the cycle lock is
   held by the caller's cycle) writes are staged and ride the cycle's commit; outside one each
   write is its own commit.
3. **Channel skills.** `opsbot-slack post` and `opsbot-whatsapp post` write the `posts` sheet
   through the log module, including the replay check on a retry id. The listeners ask
   `log seen` instead of reading the seen file.
4. **Cross-bot read.** `log read --repo <path or remote>` fetches that repo's log branch into
   a private ref and reads it.

## Validation

- [x] A ledger append and a state set made during a cycle are in that cycle's commit; made
      outside a cycle, each is its own commit; neither touches the working tree.
- [x] A record missing a declared field is refused with the field named.
- [x] A post, a blocked post and a replayed post each leave the record the post log left
      before, and a retry with the same id still cannot send twice.
- [x] The Slack and WhatsApp listeners drop an already-seen event with no file in the working
      tree.
- [x] `log read --repo` returns another repo's ledger records from its fetched log branch.
- [x] `log read --since` over a day of records walks only that day's partitions.

## Notes

- **Validation evidence.** Box 1: `tests/log-ledgers.test.ts` "a ledger append and a state set
  in a cycle ride its commit…". Box 2: "a record missing a declared field is refused…". Box 3:
  `tests/whatsapp.test.ts` "a post, a blocked post and a replayed post each leave the record the
  file log left" and "accepted means sent", and `tests/slack-post.test.ts`, which has the same two
  tests without the replay. Box 4: `tests/slack.test.ts` "with log.branch the ack asks the core's
  `log seen`" and `tests/whatsapp.test.ts` "with log.branch the read receipt asks…". Box 5:
  "log read --repo reads another bot's ledger…". Box 6: "log read --since over a day walks only
  that day's partitions": a record file nobody can parse is planted on another day, and the
  `--since` read succeeds while the whole-sheet read fails on that file.
- **One sheet per kind, not per name.** `ledgers`, `posts` and `state` are fixed kit sheets.
  The ledger or channel name is a path field (`ledger`, `channel`), and the state name is the
  record's `name`. The kit checks the declared fields when it writes, and names any field that
  is missing. Because nothing is generated per name, `settings validate` stays read-only and
  writes no sheet configs. A branch made before these sheets existed gets the config in the
  same commit as the first record that needs it.
- **Record shapes.** A ledger record is the script's object plus `at` (its own UTC ISO time, or
  now), `ledger` and `hash` (sha256 of the canonical record, 12 hex). `ledger` and `hash` are
  reserved. An identical record in the same second is the same file. A post record is the old
  file line plus `channel` and `hash`. A state record is `{name, at, value}`, with the
  baseline under `value` so its fields cannot collide with the log's. A value equal to the
  current one writes nothing, so a check that re-sets an unchanged baseline keeps its cycle
  quiet. TOML holds no nulls, so a null field in a file line is absent on the branch.
- **"Inside a cycle"** means the cycle lock is present, its process is not known to be gone, and
  it is younger than `lock_max_minutes`. `judgeLock`'s same-session rule is left out, because a
  script the cycle runs is in that session. Outside a cycle the write goes through
  `commitStaged`, which also takes anything already staged. It is not pushed until the next
  `cycle end`.
- **Posts.** Slack has no retry id, so there is no Slack replay to keep. The WhatsApp guarantee is
  whatsapp-axi's `--id`, and it holds even when the log write fails. A failed log write after a
  send keeps the post's exit and JSON and adds a stderr warning (as the file writer did). If
  the loop guard cannot read the branch, it refuses (`peer_guard: hourly`): more guard, never
  less. The ledger and state commands refuse without `log.branch`. Post logs without it are
  unchanged.
- **`--repo`.** gitsheets-axi takes only a branch name, so the other repo's branch is fetched into
  a bare repo at `<git dir>/opsbot-peers/<id>.git` and read there. The default branch is
  `opsbot/log`, and `--branch` names another.
- **`log seen`** exits 0 for seen and 1 otherwise. The listeners treat any failure as not yet
  seen.
- **Not changed:** opsbot-google writes nothing to the repo's log (its state is in `~/.cache`).
  The behavior passages of the Slack and WhatsApp skill specs that describe `logs/intake/seen`
  are left for `log-branch-migrate`'s docs step.
- **Cost, measured** (local bare remote, load ~15, medians of 7): a busy cycle (`begin` + `end`)
  takes 0.8 s with the files and 4.5 s on the branch. With a post and two ledger appends it
  takes 5.6 s: `end` 4.0 s (posts and ledgers are one more upsert each, two ledgers sharing
  one), plus 0.8 s for the three staged appends together (one opsbot-core start each, no
  gitsheets call).

## Follow-ups

- Deferred to `log-branch-migrate`: write `commit_paths` baselines as `state` records
  (`{name, value}`), post-log files as `posts/<channel>` records with their own `at`, and
  unparsed lines as ledger `unparsed` in the `ledgers` sheet. Migrate writes these through the
  log module directly, not through `log append`'s declared-name check. Also update the
  listener passages in the skill specs.
