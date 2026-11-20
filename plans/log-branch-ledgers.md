---
status: in-progress
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

- [ ] A ledger append and a state set made during a cycle are in that cycle's commit; made
      outside a cycle, each is its own commit; neither touches the working tree.
- [ ] A record missing a declared field is refused with the field named.
- [ ] A post, a blocked post and a replayed post each leave the record the post log left
      before, and a retry with the same id still cannot send twice.
- [ ] The Slack and WhatsApp listeners drop an already-seen event with no file in the working
      tree.
- [ ] `log read --repo` returns another repo's ledger records from its fetched log branch.
- [ ] `log read --since` over a day of records walks only that day's partitions.
