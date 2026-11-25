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

- [x] Under `listen_to: "operators"`, a non-operator's @mention and reply in the bot's thread in
      a listed channel are recorded, receipted, woken and read-reacted; marked
      `from_operator: false`; the journal says `heard in listen_channels`.
- [x] The same person's DM, reaction, @mention in an unlisted channel, and a `team_join` are
      still dropped; an operator's item in a listed channel is not marked.
- [x] With `listen_to: "anyone"` nothing changes (no mark).
- [x] Peers and other apps are unchanged in a listed channel.
- [x] A channel in both lists: an addressed message from anyone is recorded once, as
      addressed; an unaddressed one is a `watch` line.
- [x] The reader prints `from_operator: false`, `listen_note` and `gate_word_void`.
- [x] `status` shows `ok listen_channels` with the count, and `differs` for a bad value.
- [x] `bun run type-check`, the slack tests and `bun run check` pass.

## Notes

- The mark is `from_operator: false`, written only on an item this list kept, never `true` on
  anything. An operator's item carries no mark, as before, and with `listen_to: "anyone"` nobody
  is marked: that bot already treats everyone alike, and adding the field there would change
  every item it reads. The reader adds `listen_note` and `gate_word_void`, the same shape as a
  peer's `peer_note` and `gate_word_void`.
- `heard()` is now a boolean over `heardWhy()`, which returns why an item passes `listen_to`;
  the listener uses the reason for the mark and the journal line, so the two cannot disagree.
- An intercept rule of kind `mention` or `reply` can be triggered by anyone in a listed channel,
  as with `listen_to: "anyone"`; the default kind, `dm`, cannot. The status intercept row says so.
- No membership row for listed channels: Slack delivers an @mention only in a channel the bot is
  in, so the person mentioning it is asked to invite it.
- Not verified without a live Slack connection: that Socket Mode delivers a non-operator's
  `app_mention` and thread replies in a listed channel as it does an operator's (the listener
  sees the same events either way; only `listen_to` decided before), and how an `app_mention` in
  a group DM arrives (the spec says not to list a group DM).

## Follow-ups

- Tracked as: confirm on the first bot that sets `listen_channels` that a teammate's @mention
  gets the receipt and read reactions and the bot answers it without treating it as the
  operator's instruction.
