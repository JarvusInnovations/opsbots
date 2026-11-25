---
status: done
done: 2026-11-25
pr: 140
depends: [opsbot-slack, slack-peers, slack-classify-via-audience]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: a watch list: record every message in named channels

## Why

The listener drops every channel message that is not a DM, an @mention, or a reply in a thread
the bot was mentioned in or started. A bot whose job is to follow a few project channels has to
poll them with `slack-axi read` at each check. That is late, and it misses a reply posted in an
older thread, since a read of recent history does not show one.

## Scope

In: `templates/monitor.d/10-slack-listener`, `templates/heartbeat.d/20-slack-events`,
`scripts/opsbot-slack` and `scripts/slack-post.mjs` (the status rows), the manifest's comment,
the spec, SKILL.md and README, and `tests/slack.test.ts` and `tests/slack-post.test.ts`.

Out: saving a watched message's files; reactions and edits in watched channels; a group DM
(`mpim`) as a watched conversation; any change to peer rules, the intercept or the loop guard.

## Implements

- `specs/skills/opsbot-slack.md`: *Watched channels* (what is recorded, watching is reading,
  addressed first, peers and other bots, the wake, the reader, status); the `watch` and
  `watch_wake_seconds` settings; the watch file; the reader's `kind: "watch"`; the manifest's
  channel message events; the status command's rows; the rule and its why.

## Approach

1. `watchList(raw)`: the usable channel ids and one problem per bad entry. `settings()` gains
   `watch`, `watchWakeSeconds` (default 60) and `watchFile` (`slack-watch.jsonl` beside the
   events file).
2. `watchItem(event, opts)`: the `watch` line for a `message` event in a watched channel, or
   null. Null for the bot's own, a subtype other than `file_share` or another app's
   `bot_message`, a message `classify` keeps and `listen_to` hears, and an @mention whose
   `app_mention` will be heard. `from_peer` for a peer, `from_bot` for any other app.
3. The listener records a watched-only message to the watch file with no reaction, no intercept
   and no file save, and runs a debounced wake: one line on the events file
   (`{watch_wake, convs, note, at, recorded_at}`, no key) and one `wake backstop`, at most once
   per `watch_wake_seconds`, with a trailing wake for messages that arrived in between.
4. The watch file is pruned to 14 days at start and at most hourly after an append.
5. The reader reads the watch file after the events file, skips keys already seen, adds
   `watch_note`, and asks `slack-axi cite` once per channel for the permalinks.
6. `checkRows` gains the `watch` row; `slack-post.mjs watch-check` and `opsbot-slack status`
   give one `watch-channel` row per channel the bot is not a member of.

## Validation

- [x] Every message in a watched channel, by a person, another app or a peer outside its
      channel, a top-level post or a reply in an old thread, is a `watch` line with key
      `slack:<conv>:<ts>:msg`; the bot's own, edits, deletes and joins are not.
- [x] A message also addressed to the bot is recorded once, as addressed, in either order of
      `app_mention` and `message`; a non-operator's @mention under `listen_to: "operators"` is
      recorded as `watch`.
- [x] A watched-only message gets no reaction; an addressed one still gets the receipt.
- [x] The wake is debounced: a burst of watched messages runs one backstop and appends one
      wake line, then one more after the window; `watch_wake_seconds: 0` wakes on each.
- [x] A watched line never makes a thread the bot's.
- [x] The reader prints `kind: "watch"`, `reply`, `watch_note`, sender and thread context, a
      permalink from `slack-axi cite`, skips seen keys, and fails the input when `watch` is set
      and the watch file is missing.
- [x] `status` shows the `watch` row (ok or differs) and a `watch-channel` row per channel the
      bot is not in.
- [x] `bun run type-check`, `bun test` and `bun run check` pass, apart from failures that
      exist on the base branch too.

## Notes

- Watched lines live in their own file, not the events file. Two reasons: a line in a
  `wake.files` file wakes the session at once (the monitor, and `cycle end`'s arrival check), so
  debouncing needs the lines elsewhere; and a watched line in the events file would make every
  thread look like the bot's to `threadIsMine`.
- The debounce is leading and trailing: the first watched message wakes at once, later ones in
  the window share one wake at its end, so none waits for the next timed cycle.
- Another app's post in a watched channel is recorded (`from_bot`), where the listener dropped
  it before. A watched item asks for no answer, so it starts no run between bots; the peer rules
  and the loop guard are unchanged.
- The reader skips watched keys already in the seen file before any lookup. Without that, a busy
  channel would cost a thread read and a permalink for every message in the window at every
  check.
- Not verified without a live Slack connection: that Socket Mode delivers `message` events for
  every post in a channel the bot is in (the manifest already subscribes to `message.channels`
  and `message.groups`); the order of `app_mention` and `message` for one @mention (the code
  does not depend on it); and the output of `slack-axi cite` against a real workspace (tested
  with a stand-in in the format slack-axi 1.6.0's source prints).

## Follow-ups

- Tracked as: confirm on the first bot that sets `watch` that a busy channel gives at most one
  wake per window in the journal, and that permalinks resolve.
