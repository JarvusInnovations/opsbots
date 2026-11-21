---
status: done
done: 2026-11-20
pr: TBD
depends: [slack-peers]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: a peer named by bot id alone, as a webhook's posts are

## Why

The spec's sender rules already say a peer is recognised by `bot_id` when the event carries no
`user`, which is the shape of a post through a Slack incoming webhook. But the listener's
settings check refused a peer entry with no `user`, and the post command's guard kept only
peers with a `user`. So an adopting bot could not hear a peer that posts through a webhook,
although the matching code existed.

## Scope

In: the listener (settings, sender, peer rules, status row), the post command's peer list and
thread-sender sort, the heartbeat reader, their tests, the spec's "Peer bots" table, a
clarification paragraph and its validation sentence, the opsbot-slack SKILL.md and README.

Out: any change to how a `user` peer is heard or guarded.

## Implements

- `specs/skills/opsbot-slack.md`, "Peer bots": `user` or `bot_id` (at least one) in the table;
  the paragraph on a peer named by `bot_id` alone (whoever holds the webhook; a shared webhook
  is told apart by the text in the session's protocol; `from` is the `bot_id`); validation
  refuses a peer with neither.

## Approach

1. `peerList`: a peer needs `user`, `bot_id` or both; a missing one is stored as `""`; one with
   neither is refused. A `user` that is given is still checked against `bot_user` and
   `operators`; a `bot_id` equal to the bot's own is still refused.
2. `peerOf` never matches a peer with an empty `user` by user, and never takes one of the bot's
   own bot ids (the setting or one learned at run time) as a peer's, so the bot's own post is
   still `self`. `sender`, `classify`, `peerSkip`, `peerItem` and `droppedPeer` pass `botIds`.
3. `peerItem`: `from` is the event's user, else the peer's user, else its bot id.
4. Status (`--check`): the peer row names a peer by its user, else its bot id.
5. The post command: a peer entry counts for the guard with a user or a bot id; a `bot_id` equal to
   its own `bot_id` is dropped from the peer; a draft's @mention is tested only against a peer
   that has a user. `senderKind` (and so the cached `threads.senders`) sorts a webhook post as
   the peer's.
6. The reader: an item whose `from` is a peer's bot id gets no `slack-axi user` lookup and no
   `sender_lookup` call (there is no user), so no `from_note` either.

## Validation

- [x] Settings accept a `bot_id`-only peer and refuse one with neither `user` nor `bot_id`; the
      status row names the peer by its bot id, or differs with the fix.
- [x] A webhook-shaped event (no `user`, the peer's `bot_id`, `subtype: bot_message`) in the
      peer's channel that mentions the bot is kept with `from_peer`, `from` its bot id, and is
      never intercepted.
- [x] The same event in another channel, or with no mention outside the bot's threads, is dropped
      with a journal line and never the text; a reply in a thread the bot started is kept.
- [x] Another bot's `bot_id` is dropped, in the peer's channel too; a post with a `user` is never
      the `bot_id`-only peer's.
- [x] The bot's own `bot_id` is refused as a peer at validation; one learned at run time is still
      `self`, never a peer, never a drop line.
- [x] The loop guard counts the webhook peer's posts (`peer_turns`), caches its senders as
      `p:<name>`, and counts its threads in `peer_posts_per_hour`; another bot's `bot_id` does
      not count; the bot's own `bot_id` listed as a peer's does not make its own run a loop.
- [x] The reader marks the item `from_peer` with `gate_word_void`, without a user lookup.
- [x] Every existing test passes unchanged.
- [x] `bun run build`, `bun run type-check`, `bun run check` and `bun test` pass.

## Notes

- `skills/opsbot-slack/scripts/slack-post.mjs` is hand-written, not generated: `build-cli.ts`
  bundles only the core and host CLIs.

## Follow-ups

None.

## After this plan

Not part of the validation, since it needs live Slack: a real incoming webhook's post reaching
the listener with no `user`, `subtype: bot_message` and the webhook's `bot_id`; and whether
`conversations.replies` returns that `bot_id` on the webhook's messages in a thread.
