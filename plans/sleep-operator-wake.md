---
status: in-progress
depends: [sleep-and-wake]
specs:
  - specs/skills/opsbot-core.md
issues: [125, 86]
---

# Plan: only a typed prompt wakes a sleeping loop as the operator

## Why

On an adopting bot a sleeping loop woke twice with "the operator wrote to the session" when
nobody had written: each time about one probe after a `/compact` typed by hand into the pane
(#125). #86 is the same shape with a local command (`/context`). The wake sends the session
looking for a message that does not exist and skews the sleep's numbers.

## Scope

In: which session-log rows `lastOperatorAt` (the sleep decision's quiet clock and `sleep
tick`'s first wake test) counts as the operator; the sleep timer recording what it types; a
fixture-replay test; the spec's *Sleep* section, `sleep tick` row and state-file row.

Out: #86's other two asks (the `agent_prompt_stalled` false failure after a compaction, and
saying whether a wake that found nothing slept again); a skill slash command counting as the
operator (it never did, in either form).

## Implements

- `specs/skills/opsbot-core.md`, *Sleep*, "What counts as the operator writing": only a typed
  prompt; not the loop prompt, not the timer's recorded `typed` texts, not a slash command in
  either form, not local-command output, a compaction summary, or a harness entry.
- `sleep tick` row: every text the timer types is recorded in `typed`.
- `.git/opsbot-sleep` row: `typed`.

## Approach

1. Reproduce from real session logs (read only, nothing copied): a typed `/compact` is logged
   as the tagged command record, which `humanMessages` already drops, and sometimes also as a
   plain user row with the bare text `/compact[ <args>]`, no tags, no `isMeta`, no `origin`,
   written a fraction of a second ahead of the record. In every log examined the bare row
   appears when the conversation's last turn had not ended (after a compaction, a `/branch`,
   an interrupted turn) and never for a `/compact` typed after an ended turn, which is what
   the timer types. That bare row passes every filter and is the operator's "message".
2. `readEvents` keeps `isMeta`, `isCompactSummary` and `origin.kind`; `humanMessages` drops a
   row that is meta, a compaction summary (string or blocks), or has a non-human origin.
3. `lastOperatorAt` also drops a text that is a slash command (`/name` then whitespace or the
   end) and any text the timer recorded typing.
4. `SleepState.typed`: `goDown` and `wake` append what they type; `cheapReason` passes it.

## Validation

- [ ] A fixture replay: the timer's `/compact` after an ended turn, then a hand-typed
      `/compact` logged with its bare row (and the compaction it causes) during sleep: the tick
      does not wake for the operator.
- [ ] The same fixture with a real typed message after it: the tick wakes with "the operator
      wrote to the session" at that message's time.
- [ ] A bare `/context`, a mid-turn `/compact`, a meta row, an array-content compaction
      summary and a task-notification origin row are not the operator; a text the timer
      recorded typing is not the operator.
- [ ] The sleep file records `typed` for the timer's `/compact` and its wake prompt.
- [ ] Every existing test passes unchanged.
- [ ] `bun run build`, `bun run type-check`, `bun run check` and `bun test` pass.

## Notes

## Follow-ups
