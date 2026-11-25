---
status: planned
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

- [ ] Every message in a watched channel, by a person, another app or a peer outside its
      channel, a top-level post or a reply in an old thread, is a `watch` line with key
      `slack:<conv>:<ts>:msg`; the bot's own, edits, deletes and joins are not.
- [ ] A message also addressed to the bot is recorded once, as addressed, in either order of
      `app_mention` and `message`; a non-operator's @mention under `listen_to: "operators"` is
      recorded as `watch`.
- [ ] A watched-only message gets no reaction; an addressed one still gets the receipt.
- [ ] The wake is debounced: a burst of watched messages runs one backstop and appends one
      wake line, then one more after the window; `watch_wake_seconds: 0` wakes on each.
- [ ] A watched line never makes a thread the bot's.
- [ ] The reader prints `kind: "watch"`, `reply`, `watch_note`, sender and thread context, a
      permalink from `slack-axi cite`, skips seen keys, and fails the input when `watch` is set
      and the watch file is missing.
- [ ] `status` shows the `watch` row (ok or differs) and a `watch-channel` row per channel the
      bot is not in.
- [ ] `bun run type-check`, `bun test` and `bun run check` pass, apart from failures that
      exist on the base branch too.

## Notes

## Follow-ups
