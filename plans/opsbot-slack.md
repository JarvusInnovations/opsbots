---
status: done
done: 2026-11-11
depends: [opsbot-core, live-wake]
specs:
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-core.md
  - specs/architecture.md
pr: 65
---

# opsbot-slack: the bot in Slack

## Scope

`skills/opsbot-slack/`: the first channel skill. A Slack app manifest for a bot user on Socket
Mode; `monitor.d/10-slack-listener` (records, reacts on arrival, nudges, reacts again once the
key is seen, logs every event type, reconnects); `heartbeat.d/20-slack-events` (items with
stable keys, `kind`, the `reply` address and thread context, and the optional `sender_lookup`
hook); `escalate.d/10-slack-dm` (one DM to the operator in the bot's name);
`scripts/opsbot-slack install` and `status`; SKILL.md and a person-facing README. The spec, the
kit README's skill list, and the architecture's channel row and listener paragraph.

Not here: a send guard (replies still go through `slack-axi draft` and `draft send`); a reader
for channels the bot is not addressed in (`25-slack-channels`: slack-axi's `read` prints
author names, not user ids, and a reply's parent only by row order, so an item could not carry
the sender id the gate word needs; left for a structured output mode).

## Validation

- [x] The listener's event classification, run through node against raw Events API events: a
      DM, a threaded DM, an @mention, a reaction on its message and a new member are kept with
      stable keys; its own messages, other bots, edits, reactions on others' messages and
      channel chatter outside its threads are dropped; a thread reply is kept only in a thread
      holding a recorded @mention.
- [x] The listener refuses to start on a missing, group-readable or non-`xapp-` token file,
      without printing it; `node --check` passes on both node scripts.
- [x] The reader against a fixture events file and a stand-in slack-axi: keys stable across
      runs; `reply` right for a top-level DM, a threaded DM, a channel mention and a thread
      reply; a stale line skipped; thread context parsed from a table made with the TOON
      encoder slack-axi uses; an unresolved sender kept as its id with a note.
- [x] `sender_lookup`: unset adds nothing; set, it is called once per sender with the profile
      on stdin and its keys merge without overriding; a failing one prints every item and exits
      1; a path outside the repo is refused. No events file exits 1.
- [x] The sink with a stand-in slack-axi: drafted once with the mark and sent once; non-zero and
      nothing sent when `escalate_dm` is unset, the message is empty, slack-axi is in human mode,
      or the draft or the send fails.
- [x] `opsbot-slack install --dry-run` writes nothing; `install` writes three executable scripts
      matching the templates and leaves `opsbot.json` alone; a second install changes nothing; a
      changed script is left without `--force` and replaced with it.
- [x] `opsbot-slack status`: rows for a missing token, an open one, a non-`xapp-` one, a
      present one; slack-axi in human and bot mode; `streams.slack`, `wake.files` and the
      listener's unit; exit 0 only when all are ok; the token never printed. Unknown flags and
      commands exit 2.
- [x] The manifest parses as YAML, has Socket Mode on, no email scope, and a comment on every
      scope.
- [x] Full suite passes; `tsc --noEmit` clean; bundle and SKILL.md `--check` clean.
- [ ] Installed on a running bot against a live workspace: not done here (the kit's tests never
      reach Slack).

## Notes

- 2026-11-11: distilled from a running bot's Slack setup, where the listener, the reader and
  the DM sink had run for days. Three lessons came with it, each now in the spec's rules:
  the app first lacked `app_mentions:read`, so @mentions did nothing until the listener
  logged every event type it received; an answer landed in the wrong thread until the reader
  computed a `reply` field; and a reaction added on arrival promised a read a busy agent had
  not done, so the second reaction now waits for the seen key.
- Generalized away: the source's sender check against a company directory became the
  `sender_lookup` hook; its people and thread sheet lookups were the bot's own and are gone;
  the bot's name in the thread reader became `bot_name`; the sink reads `opsbot.json` with
  node rather than python, and refuses to send outside bot mode.
- The tests run every script with PATH limited to the stand-in and the system, and with
  `OPSBOT_SLACK_AXI` naming the stand-in. Before that, an asdf node shim put the globally
  installed slack-axi ahead of the stand-in on a development host.
