---
status: in-progress
depends: [opsbot-slack]
specs:
  - specs/skills/opsbot-slack.md
  - specs/architecture.md
issues: [77]
---

# Plan: one post command that classifies the destination and screens the draft

## Why

A bot's reply in a shared channel is read by everyone there. Until now nothing stood between a
draft and the post except the session's own judgment, and the bot posted by calling
`slack-axi draft <reply> "…"` and `slack-axi draft send` itself. There was no single path to
put a check in.

## Scope

In: `opsbot-slack post` and `opsbot-slack classify` (a node script beside the bash command),
the destination classes, the optional screen with its settings and told-once escalation, the
decision log, a `status` row for the screen, a reference screen command and two policy starting
points in `templates/screen/`, the reader's comment pointing at the new command, tests, the
spec, SKILL.md and README.

Out: the send guard's other refusals in [architecture](../specs/architecture.md#guards)
(length, ids, the persona's word list, unread inbound), a provenance rule, and invalidating the
class cache on a membership event (the app does not subscribe to `member_joined_channel`; the
cache is short instead).
