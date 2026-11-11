---
status: done
done: 2026-11-11
depends: [opsbot-slack]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: hear replies in a thread the bot started

## Why

A bot running this listener posted a top-level message in a private channel. A person replied
under it without an @mention. The listener's journal shows the event arrived, but nothing was
recorded and the loop was not woken. The listener kept a plain thread reply only when the
events file already held an @mention, or a kept reply, in that thread. The bot's own messages
are never recorded, so a thread rooted on its own post was never its thread. The bot fixed its
installed copy; this brings the same fix to the kit's template.

## Scope

In: `templates/monitor.d/10-slack-listener`, its tests in `tests/slack.test.ts`, the spec, the
skill's SKILL.md and README, and the manifest's comments.

Out: thread replies in group DMs. The reply rule matches `channel_type` `channel` and `group`
only, so the `message.mpim` subscription still does not keep a group-DM thread reply. That was
true before this change and is left as it was.

## Implements

- `specs/skills/opsbot-slack.md`: the three reasons a thread reply without a mention is kept;
  the own-threads file beside the events file, its 90-day bound; the bot's own messages never
  items; the rule with its why.

## Approach

1. `settings().ownThreadsFile`: `slack-own-threads.jsonl` in the events file's directory.
2. `ownRoot(event)` picks out the bot's own top-level post in a channel or private channel. The
   listener appends `{conv, ts, recorded_at}` to the own-threads file and does nothing else with
   it. Its replies are not roots.
3. `rootIsMine(lines, conv, ts)` reads it back. The listener's `inMyThread` is now "a remembered
   root, or the existing mention rule".
4. `classify` also keeps a channel thread reply whose `parent_user_id` is `bot_user`.
5. `pruneRoots(lines, now, days)` drops roots whose Slack `ts` is older than 90 days. The
   listener runs it after each append and rewrites the file through a temp file and a rename
   only when something was dropped.

## Validation

- [x] The installed listener on the bot that found this was diffed against the kit template:
      the only differences are this fix.
- [x] A reply under the bot's own top-level post is kept, with key `slack:<conv>:<ts>:msg`
      and `thread_ts` set; only the top-level post is remembered as a root.
- [x] A reply whose `parent_user_id` is the bot is kept with no root on file; without
      `bot_user` it is not.
- [x] A reply in a thread the bot only replied in, with no mention, is dropped, and no root is
      remembered.
- [x] A root does not claim the same `ts` in another conversation, nor another thread.
- [x] The bot's own messages are never items, top-level or reply, in its own thread too.
- [x] Mention-thread behaviour unchanged: a reply in a thread holding a recorded @mention is
      kept; one that @mentions the bot is left to `app_mention`, here and under its own post.
- [x] The running listener, with Slack replaced by a preload that stubs `fetch` and
      `WebSocket` and with HOME in a temp dir, writes the own post to the own-threads file,
      prunes a 100-day-old root from it, and records the reply under the post.
- [x] `pruneRoots` keeps roots inside the window in order, and drops older ones and
      unparseable lines.
- [x] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass.
- [ ] A real Slack thread-reply event carries `parent_user_id`. Not seen yet; see Notes.

## Notes

- Ported from the bot's fix as it was, with one addition: the 90-day bound. The bot's own copy
  had none, and noted it would add one if the file grew. The bound is by the root's Slack `ts`,
  not by `recorded_at`, so it is the same rule however late the post was recorded.
- `parent_user_id` is a backstop. Slack's message-event reference does not document it; it
  appears in examples of `conversations.replies`. The remembered roots are the record. The
  field covers a root posted while the listener was down, and a root older than 90 days.
  Whether it arrives on Socket Mode thread-reply events is not yet confirmed: the bot's journal
  logs only an event summary.
- A Web API lookup per unknown thread reply was set aside: every thread reply in every channel
  the bot is in would cost a call, and a Slack outage would then drop replies.
- No scope or event change: `message.channels` and `message.groups` already deliver the bot's
  own posts and the replies.
- A bot that installed the earlier template sees its listener as `differs` in
  `opsbot-slack status` until it runs `opsbot-slack install --force` and restarts the unit.

## Follow-ups

- Tracked as: group-DM thread replies (`channel_type` `mpim`) are not kept by the reply rule,
  with or without this change.
- Tracked as: confirm `parent_user_id` on a real thread-reply event on the first bot that
  takes this version.
