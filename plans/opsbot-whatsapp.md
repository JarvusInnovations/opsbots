---
status: done
done: 2026-11-15
pr: 98
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

- [x] The reader prints one item per kept message and per reaction on the bot's own message, with every field in the spec; own messages, edits, revokes and state events are not items; a stopped account fails the input after the items
- [x] The cursor advances, the overlap re-reads, and a missing cursor file starts from the daemon's most recent events
- [x] `listen_to: operators` drops a non-operator's item and keeps a peer's in its chat
- [x] Each destination class is decided as the table says, including a participant with no known number being `unknown`, and `unknown` never cached
- [x] The screen outcomes and exit codes 0, 1, 2, 3, 4 and 6 each have a test; a file to an external chat is refused unless allowed
- [x] The loop guard refuses at the turn limit and the hourly cap, lets one operator-mention draft through, and refuses an unreadable chat
- [x] The waker nudges per wake line, marks read only after the key is seen, never for a dropped event, and logs no text
- [x] `install --dry-run` writes nothing; `status` reports every row in the spec against the stub, including the scope rows
- [x] opsbot-slack's tests still pass unchanged

## Risks

- whatsapp-axi's output is TOON for people; the scripts need a stable machine form. If the CLI
  has none, talk to the daemon's socket (HTTP over a Unix socket, JSON) directly from the node
  scripts, and say so in the README.

## Notes

- The machine form is whatsapp-axi's `--json-out=<path>` (its `specs/cli.md`): the daemon's
  response body, unchanged, written to a file. Each script has one helper that names a fresh file
  in a private temporary directory (0700), reads it, removes it, and removes the directory on
  exit. Standard output, the TOON view, is never read. A non-zero exit with no readable file is a
  failure whose reason is the exit code. The Risk above is settled this way, not by the socket.
- Shapes read, from whatsapp-axi's merged `--json-out` work: `events` `{events, latest_seq, after}`;
  `chat view` `{chat: {…, participants}}`; `read` `{chat, messages, more}`; `message view`
  `{chat, message}`; `send`/`send-file` `{id, chat, t}`; `settings show` `{settings: {…}}`;
  `groups` `{groups}`; `daemon status` `{service, daemon}`; `doctor` `{doctor: [rows]}`. Each is
  parsed in one small function per command.
- Readings taken where the spec is open, narrowest first:
  - A reaction item carries `reaction` (the emoji) and `text: ""`; its `id` and `reply` are the
    message reacted to. Whether that message is the bot's comes from the read itself, else from
    `whatsapp-axi message view`; `not_found` means not the bot's.
  - `reply_to` is `{id, from, text}` and `media` `{type, mime, name, size}`, the listed keys only.
  - The latest `state` event read decides the failure, so a later `connected` clears a stop.
  - The cursor does not move when a whatsapp-axi call failed, nor under `OPSBOT_PEEK=1`.
  - A peer's item carries `gate_word_void: "from a peer bot"` rather than `"not an operator"`.
  - Who is an operator, for listening: the daemon's `operator` mark or a number in `operators`.
    For the destination class: a number in `operators` only.
  - "The daemon is not connected" is `chat view`'s `not_connected` error; no extra status call.
  - The waker nudges for every wake line, as the spec says, edits and dropped events included
    (the session's own monitor wakes on them anyway); it marks read only what the reader prints.
    It also stops nudging once the key is seen, as opsbot-slack's listener does. It starts at
    the end of the wake file and creates the file (0600) when it is missing, so the unit does not
    restart in a loop before the daemon's first line.
  - A file to an `external` or `unknown` chat is refused whether or not a screen is set, exit 3
    with `screen: "block"`; with no caption nothing is screened.
  - The loop guard, as opsbot-slack's: a run refuses only when it holds a peer, so the bot's own
    messages alone are not a loop. The hourly cap counts this bot's posts to that chat. An
    operator mention is `@<number>` in the draft, or an operator in a kept message's mention list.
    `post` adds no `--mention`.
  - `--reply <id>` is passed to whatsapp-axi as the ref `<chat>/<id>`, never a bare id.
  - `status`: "new enough" means `doctor` wrote a `--json-out` file (`--version` prints a bare
    number and is reported). Whether the account exists comes from `doctor`'s `no such account`
    row, since `accounts` takes no `--json-out`. The wake file, operators, `read_receipts`, scope
    and overrides come from `settings show`. A `screen.policy.internal` key is reported: it is
    Slack's class and screens nothing here.
- Built against the trusted-circle revision of the spec: classes `operator-dm`, `trusted`,
  `external`, `unknown`; `listen_to: trusted`; `from_trusted` and `gate_word_void` on
  non-operator items.
- Pointers: `specs/architecture.md` already names the skill, and the root README's skill list and
  install lines now do. `specs/README.md`'s index has no row for it; specs are not edited here.

## Follow-ups

- `specs/README.md`: add the `skills/opsbot-whatsapp.md` row to the index.
- `post` could pass `--mention` for an operator's `@<number>`, so asking the operator notifies
  them; it needs the spec to say so.

## After this plan

Not part of the validation, since it needs a live account: on a bot linked to its own number,
a mention in a `tagged` group wakes the session and the blue ticks follow the check; a post to an
operator's direct chat goes out; `opsbot-whatsapp status` against a real daemon shows every row,
the scope rows among them.
