---
status: done
done: 2026-11-14
pr: 91
depends: [opsbot-slack, slack-own-threads, slack-operator-app-posts, slack-post-screen]
specs:
  - specs/skills/opsbot-slack.md
  - specs/skills/opsbot-core.md
---

# Plan: peer bots in a shared channel, without a loop

## Why

The listener drops every message that carries a `bot_id` unless an operator wrote it, because
two bots that answer each other never stop. An operator now runs two bots that should work
together in one shared channel: one hands a piece of work to the other, or the two agree a rule
change. That needs a deliberate exception, bounded in code.

## Scope

In: the listener, the heartbeat reader, the post command, `opsbot-slack status`, the core's
digest rendering of the gate word, their tests, both specs, the opsbot-slack SKILL.md and
README, and one line of the core SKILL.md.

Out: the escalation sink and the manifest. The guard's thread read needs `channels:history`
and `groups:history`, which the manifest already asks for.

## Implements

- `specs/skills/opsbot-slack.md`: "Peer bots" (the setting, when a peer's message is kept, what
  its item carries, the loop guard, what peers do not change, validation); the peer sender in
  "Posts through an app"; `peers`, `peer_receipt_emoji`, `peer_turns` and `peer_posts_per_hour`
  in the settings; the guard as step 3 of posting, exit 6 and the log's `peer` and `peer_guard`;
  the status rows; the token-reading rule; two rules with their why.
- `specs/skills/opsbot-core.md`: an item's optional `gate_word_void`, and the check's
  `present, does not count: <why>`.

## Approach

1. The listener reads `peers` through `peerList` (refusing one equal to `bot_user`, an operator
   or the bot's own `bot_id`, with no name or a repeated one, no channels, or a channel that is
   not `C…` or `G…`). `sender` names a peer second, right after the bot itself by user, so a peer
   is never a person or an operator.
2. `peerItem` keeps a peer's `message` or `app_mention` only in its channels, only on an @mention
   or in a thread the bot is in (the existing thread tests), marked `from_peer`. `droppedPeer`
   logs the rest. A peer's mention may arrive as both an `app_mention` and a channel message; the
   second, with the same key, is not recorded.
3. `heard` passes a peer item; `matchIntercept` never takes one; the receipt is
   `peer_receipt_emoji`.
4. The reader adds `peer_note` and `gate_word_void: "from a peer bot"` to a peer's item; the
   core's digest prints `gate_word: present, does not count: <why>` for such an item and does
   not print the field itself.
5. The post command's `peerGuard`: in a peers' channel, read a reply's thread with
   `conversations.replies` (pages of 200, at most 10), sort each sender, and refuse (exit 6) a
   run of `peer_turns` bot messages holding a peer with no person between, past
   `peer_posts_per_hour` posts to peers in that channel from `post_log`, or a thread it cannot
   read. A draft that @mentions an operator gets through once per run. Senders, never text, are
   cached 20 seconds, and the bot's own post is added to the cached thread.
6. `opsbot-slack status`: a `peers` row from the listener's `--check`, and a `peer-channels` row
   from `slack-post.mjs peers-check` (slack-axi audience's `is_member` per channel).

## Validation

- [x] A peer's @mention in a listed channel is kept and marked `from_peer`.
- [x] The same peer in an unlisted channel, a DM and a group DM is dropped, one line of ids
      each, never the text.
- [x] A peer's top-level post without a mention is dropped; so is its reaction.
- [x] A peer's reply under the bot's own post, in a mention thread, and with `parent_user_id`
      the bot, is kept; in another thread it is dropped.
- [x] A peer's @mention arriving twice is recorded once; one that arrives only as a channel
      message is kept.
- [x] An unknown bot is still dropped, in a peer's channel too; a person's mention there is
      unchanged.
- [x] A peer passes `listen_to: "operators"`; it is never intercepted; its `bot_id` with no
      user is still the peer.
- [x] A gate word in a peer's message: the reader's item carries `gate_word_void`, and the check
      prints `gate_word: "present, does not count: from a peer bot"`, never `present`.
- [x] Validation: a peer equal to `bot_user` or an operator, the bot's own `bot_id`, empty or
      missing channels, a DM channel, a repeated name, no name are refused, said at start and
      never heard; the status row is ok or differs with what is wrong.
- [x] The running listener (Slack stubbed by a preload) reacts `robot_face` to a peer, records
      it once, wakes once, and logs the unlisted-channel drop without the text.
- [x] The turn limit: with five bot turns after a person's root, the sixth posts and the
      seventh is refused, exit 6, nothing sent, logged with `peer_guard: "turns"`, one thread
      read for both; a peer root counts; `peer_turns` is read.
- [x] A person's message and an operator's post through an app reset the count; other apps
      neither count nor reset; a run of the bot alone is not a loop.
- [x] A draft that @mentions an operator gets through once per run; a second is refused.
- [x] The hourly cap refuses the third post with `peer_posts_per_hour: 2`; another channel and a
      post with no peer are not limited; a post more than an hour old no longer counts.
- [x] A thread that cannot be read refuses the reply as `unreadable`; a long thread is read page
      by page.
- [x] A thread with no peer, and a conversation outside the peers' channels, post as before with
      no `peer` and no thread read; `--dry-run` runs the guard and posts nothing.
- [x] A channel with a peer in it is still `internal`.
- [x] Status: `peer-channels` is ok when the bot is a member, differs (exit 1) when not, and
      absent without peers.
- [x] With no `peers`, every existing test passes with its expectations unchanged.
- [x] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass; the suite also
      passes under `env -i` with a fresh HOME and a PATH of only bun's and node's directories and
      the system's.

## Notes

- Slack's docs, read 2026-11-14: `conversations.replies` needs `channels:history` or
  `groups:history` on a bot token, returns the earliest messages first, pages with
  `response_metadata.next_cursor` and `has_more`, and recommends at most 200 a page. It is Web API
  tier 3. The May 2025 change to tier 1 (one request a minute, 15 messages) applies to
  commercially distributed apps outside the Marketplace; "internal customer-built applications
  are not impacted", which is what a bot's own app is.
- The page documents `user` on returned messages but not `bot_id` or `subtype`; the guard reads
  `bot_id` as the listener's events carry it. When it is absent, a bot's message with its `user`
  is still sorted by `user`.
- The guard reads the post token itself, as `auth.test` does: `slack-axi thread` prints names and
  permalinks, not user or bot ids.
- Whether Slack sends an `app_mention` for another bot's post is not settled in its docs, so a
  peer's mention is also taken from the channel message, deduplicated by key.
- The way out of a refused run (one draft that @mentions an operator) was added so the pack's
  "ask the operator in the same thread" can be followed after the guard trips.

## Follow-ups

None.

## After this plan

Not part of the validation, since it needs live Slack: on two bots that take this version and
list each other in one shared channel, a mention from one is recorded by the other with 🤖; a
run of bot turns stops at `peer_turns`; Slack's `conversations.replies` on the bot token returns
`bot_id` on bot messages; whether an `app_mention` arrives for the peer's post or only the
channel message; and the `peer-channels` status row against a real `slack-axi audience`
(`is_member`).
