---
status: done
done: 2026-11-12
depends: [opsbot-slack, slack-own-threads]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: hear an operator's posts made through an app

## Why

A bot running this listener was tagged into a thread. Its operator replied there twice by
typing, and twice through an assistant that posts as the operator with the operator's own user
token. The typed replies were recorded and acknowledged. The two assistant replies reached the
listener (its journal logged `event message group <conv> <operator>`) and were dropped without a
trace. The listener dropped every message that carried a `bot_id`, and a post made with a user
token through an app carries the app's `bot_id` while its `user` is the person.

## Scope

In: `templates/monitor.d/10-slack-listener`, its tests in `tests/slack.test.ts`, the spec, and
the skill's SKILL.md and README.

Out: the heartbeat reader (`templates/heartbeat.d/20-slack-events`). It reads only the lines
the listener recorded and has no sender rule of its own, so it needed no change. The post
command, which already reads `operators` and `escalate_dm` for its destination classes.

## Implements

- `specs/skills/opsbot-slack.md`: "Posts through an app" (the five senders in order, the
  `bot_message` rule, no change without operators), the `bot_id` setting, `operators` in the
  settings table, and the rule with its why.

## Approach

1. `settings()` reads `bot_id`, `operators` and `escalate_dm`.
2. `sender(event, ids)` names the sender: `self` by `user`; `person` with no `bot_id` and no
   `bot_message` subtype; `operator` for a `bot_id` on a post whose `user` is an operator, or is
   anyone but the bot in `escalate_dm`; `self` again for the bot's own `bot_id` on a post with no
   user; else `bot`. The operator test comes before the own-`bot_id` test, so an operator's
   post through the bot's own app is still the operator's.
3. `classify` drops `self` and `bot` and treats `operator` like `person`. The DM, mention-thread
   and own-thread rules are unchanged. `ownRoot` uses the same `sender`.
4. `droppedAppPost(event, ids)` gives the journal line `dropped app post <conv> <user> <bot_id>`
   for a message or `app_mention` dropped as another bot's. Ids only, never the text.
5. The process learns its own bot id from the first message `bot_user` posts, when the
   setting is unset, and logs `own bot id <id>`.

## Validation

- [x] An operator's app post in a DM gives the same item as the same message typed.
- [x] An operator's app post replying in a thread holding a recorded @mention is kept; an
      operator's app `app_mention` is kept; nothing is logged as dropped.
- [x] An operator's app post replying under the bot's own top-level post is kept.
- [x] With no `operators`, anyone but the bot in `escalate_dm` counts as the operator; the same
      post in another DM does not.
- [x] An app post as a non-operator, in a mention thread and in a DM, is dropped with one line
      of ids each; the text is not in the line.
- [x] Another bot is dropped and logged: with its own user, as a `bot_message` with no user,
      and as a `bot_message` that claims an operator's `user`.
- [x] The bot's own posts are never items and never logged as drops, by `user` and by its own
      `bot_id` with no user; the latter is still remembered as a root. A post with another
      person's `user` and the bot's `bot_id` is not the bot's.
- [x] With no `operators` and no `escalate_dm`, every `bot_id` is dropped as before; all
      existing tests pass with their expectations unchanged.
- [x] The running listener, with Slack replaced by a preload that stubs `fetch` and
      `WebSocket` and HOME in a temp dir, learns its bot id, records the operator's app post,
      logs the foreign one without its text, and logs no drop for its own user-less post.
- [x] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass.

## Notes

- Slack's docs, read on 2026-11-12: `auth.test` returns `bot_id` only in its bot-token
  example; `bots.info` says `app_id` identifies whether a bot belongs to your app and that a bot
  tied to a bot user has a `user_id`; the `bot_message` subtype reference says such a message
  "has no associated user"; `chat.postMessage` says a user token "inherits the icon and username
  of the token owner". No official page says a user-token post carries `bot_id`. The observed
  event is the evidence, with one third-party write-up reporting the same, and a `bot_id` on such
  posts that differs from the bot's own.
- The listener has only the app-level token, so it cannot call `auth.test` for the bot's own
  `bot_id`. It takes the setting, else learns it from its own first post. Until then its posts
  are known by `user`, which a modern app's bot-token post always carries.
- `app_id` was set aside as the test for the bot's own posts: an operator could post through
  the bot's own app with a user token, and that post is the operator's.

## Follow-ups

None.

## After this plan

Not part of the validation, since it needs live Slack: on the first bot that takes this
version, an operator's assistant post in a thread the bot is in is recorded, and a foreign
bot's post shows its `dropped app post` line in the journal. Also whether Slack delivers an
`app_mention` for an @mention posted through an app with a user token.
