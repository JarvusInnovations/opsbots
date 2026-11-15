---
status: planned
depends: [opsbot-slack, slack-post-screen, slack-peers]
specs:
  - specs/skills/opsbot-whatsapp.md
  - specs/architecture.md
---

# Plan: opsbot-whatsapp, the second channel skill

## Why

A bot with its own WhatsApp account, held by a whatsapp-axi daemon, keeps the messages its scope
allows, and nothing reads them: a person tagged the bot in a group and nothing happened. The
session needs the same three things it has for Slack: to be woken, to get the message as a
check item, and one guarded command to answer with.

## Scope

In: the skill directory (`SKILL.md`, `README.md`, `scripts/opsbot-whatsapp`,
`scripts/whatsapp-post.mjs`, the three templates), its tests, and the pointers to it in
`specs/architecture.md`, the root README and the skills index. Out: anything in whatsapp-axi
itself; the screen command (the bot's own, shared with opsbot-slack); files saved at record
time (the session downloads on demand).

## Implements

`specs/skills/opsbot-whatsapp.md`, all of it.

## Approach

1. The reader first: `events` to items, the cursor with overlap, `listen_to`, peers, the
   `state` failure.
2. The post command: classify from `chat view`, the loop guard, the screen (reuse
   opsbot-slack's screen and escalation code paths where they are shared, without changing
   opsbot-slack's behaviour), `send` and `send-file`, the decision log, exit codes.
3. The waker: follow the wake file, nudge, mark read once the key is seen.
4. The sink, `install`, `status`.
5. Tests against a stub `whatsapp-axi` that serves canned output; no test needs a daemon or an
   account.

## Validation

- [ ] The reader prints one item per kept message and per reaction on the bot's own message, with every field in the spec; own messages, edits, revokes and state events are not items; a stopped account fails the input after the items
- [ ] The cursor advances, the overlap re-reads, and a missing cursor file starts from the daemon's most recent events
- [ ] `listen_to: operators` drops a non-operator's item and keeps a peer's in its chat
- [ ] Each destination class is decided as the table says, including a participant with no known number being `unknown`, and `unknown` never cached
- [ ] The screen outcomes and exit codes 0, 1, 2, 3, 4 and 6 each have a test; a file to an external chat is refused unless allowed
- [ ] The loop guard refuses at the turn limit and the hourly cap, lets one operator-mention draft through, and refuses an unreadable chat
- [ ] The waker nudges per wake line, marks read only after the key is seen, never for a dropped event, and logs no text
- [ ] `install --dry-run` writes nothing; `status` reports every row in the spec against the stub, including the scope rows
- [ ] opsbot-slack's tests still pass unchanged

## Risks

- whatsapp-axi's output is TOON for people; the scripts need a stable machine form. If the CLI
  has none, talk to the daemon's socket (HTTP over a Unix socket, JSON) directly from the node
  scripts, and say so in the README.

## Notes

## Follow-ups
