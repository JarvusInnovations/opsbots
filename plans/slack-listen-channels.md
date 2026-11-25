---
status: planned
depends: [opsbot-slack, slack-watch]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: listen_channels: hear everyone addressed in named channels

## Why

`streams.slack.listen_to: "operators"` is one switch for direct messages and channels. With it,
a teammate's @mention of the bot in a project channel, or their reply in the bot's thread, is
dropped (or only watched), with no receipt. A bot that works with a team in a few project
channels, but must take direct messages from its operator only, needs both.

## Scope

In: `templates/monitor.d/10-slack-listener` (the list, `heard`, the mark, the journal line, the
status row), `templates/heartbeat.d/20-slack-events` (the note and gate mark), `scripts/opsbot-slack`
(the install command's optional keys), the spec, SKILL.md, README, and `tests/slack.test.ts`.

Out: reactions and `team_join` in listed channels (they still follow `listen_to`); a membership
row for listed channels (Slack delivers an @mention only where the bot is a member, and the
mention itself says so); any change to peer rules, the watch list, or the post command.

## Implements

- `specs/skills/opsbot-slack.md`: *Channels where anyone is heard*; the `listen_channels`
  setting; the recorded line's and the item's new fields; the intercept note; the status row; the
  rule and its why.

## Approach

1. `listenChannels(raw)`: the usable channel ids and one problem per bad entry, like
   `watchList`. `settings()` gains `listenChannels`.
2. `heardWhy(item, opts)`: why `listen_to` keeps an item (`anyone`, `peer`, `operator`,
   `escalate_dm`, `channel`) or null; `heard()` is its boolean. `channel` applies only with
   `listen_to: "operators"`, to an `app_mention` or a kept channel reply in a listed channel,
   from someone who is neither a peer nor an operator.
3. The listener marks a `channel` item `from_operator: false` before recording and adds
   `heard in listen_channels` to its journal line. `watchItem` gets `listenChannels`, so an
   addressed message in a channel in both lists is recorded once, as addressed.
4. The reader adds `listen_note` and `gate_word_void` to an item marked `from_operator: false`.
5. `checkRows` gains the `listen_channels` row; the install command lists the key.

## Validation

- [ ] Under `listen_to: "operators"`, a non-operator's @mention and reply in the bot's thread in
      a listed channel are recorded, receipted, woken and read-reacted; marked
      `from_operator: false`; the journal says `heard in listen_channels`.
- [ ] The same person's DM, reaction, @mention in an unlisted channel, and a `team_join` are
      still dropped; an operator's item in a listed channel is not marked.
- [ ] With `listen_to: "anyone"` nothing changes (no mark).
- [ ] Peers and other apps are unchanged in a listed channel.
- [ ] A channel in both lists: an addressed message from anyone is recorded once, as
      addressed; an unaddressed one is a `watch` line.
- [ ] The reader prints `from_operator: false`, `listen_note` and `gate_word_void`.
- [ ] `status` shows `ok listen_channels` with the count, and `differs` for a bad value.
- [ ] `bun run type-check`, the slack tests and `bun run check` pass.

## Notes

## Follow-ups
