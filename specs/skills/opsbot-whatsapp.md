# Skill: opsbot-whatsapp

The bot in WhatsApp, as its own account: a waker that nudges the session when a message is
kept, a heartbeat reader that turns kept events into check items, an escalation sink, one
command that installs and checks them, and the one command a bot posts with. It is the second
channel skill (`opsbot-<channel>` in [architecture](../architecture.md#the-composition)) and
follows [opsbot-slack](opsbot-slack.md) wherever the two surfaces allow.

It is built on [whatsapp-axi](https://github.com/JarvusInnovations/whatsapp-axi): a daemon per
account holds the session, decides what is kept (its *scope*), and serves a CLI. This skill
never talks to WhatsApp itself and holds no credential. What the bot can read in a group is the
daemon's scope, set by the operator with `whatsapp-axi scope`; the skill reads only what the
daemon kept.

## Installs

```
skills/opsbot-whatsapp/
  SKILL.md                                  when to use it, setup in order, the pieces, the rules
  README.md                                 for a person: the account, linking, scopes, what it can see
  scripts/opsbot-whatsapp                   bash, no build step: install, status, post, classify
  scripts/whatsapp-post.mjs                 node 22, no dependencies: post and classify, run by the above
  templates/monitor.d/20-whatsapp-waker     node 22, no dependencies
  templates/heartbeat.d/25-whatsapp-events  node 22, no dependencies
  templates/escalate.d/20-whatsapp-dm       bash, calls node for opsbot.json
```

`opsbot-whatsapp install` copies the three scripts into the bot's `opsbot.d/`. The screen
command and policy files are the bot's own and are shared with opsbot-slack when it has both:
the contract is the same ([opsbot-slack, the screen](opsbot-slack.md#the-screen)).

Outside the repo, on the bot's user:

| Path | What |
| --- | --- |
| whatsapp-axi's own files | the account's session, settings and kept messages; never read by this skill except through the CLI |
| `~/.cache/<bot>/whatsapp-wake.jsonl` | the daemon's wake file (`whatsapp-axi settings set wake_file`): one line per kept event, with no content. The session's monitor wakes on it |
| `whatsapp-cursor`, beside the wake file | the reader's cursor: the highest event `seq` it has printed |
| `whatsapp-classes.json`, beside the wake file | the post command's cache: `{chats: {<chat>: {class, why, at}}}`; a failed lookup is never cached |

In the repo:

| Path | What |
| --- | --- |
| `logs/whatsapp-posts.jsonl` (`post_log`) | one line per post attempt |
| `.git/opsbot-whatsapp-screen` | the screen's told-once marker, as in opsbot-slack |

## Settings (`streams.whatsapp` in `opsbot.json`)

| Key | Meaning | Default |
| --- | --- | --- |
| `account` | the whatsapp-axi account name | required |
| `operators` | the operator's phone numbers in E.164 form; must match the account's own operator list | required |
| `escalate_chat` | the chat the sink posts to: an operator's direct chat | required for the sink |
| `wake_file` | the daemon's wake file; must also be in `wake.files` | `~/.cache/<bot>/whatsapp-wake.jsonl` |
| `listen_to` | `anyone`, `trusted` or `operators`: whose kept messages become items ([The trusted circle](#the-trusted-circle)) | `anyone` |
| `mark_read` | `seen` marks a message read once its item is in the seen keys; `off` never marks | `seen` |
| `trusted` | phone numbers of the people the operator trusts with the bot ([The trusted circle](#the-trusted-circle)) | none |
| `peers` | other bots heard as peers: `[{name, user, chats}]`, `user` a phone number, `chats` the group ids where it is heard | none |
| `peer_turns`, `peer_posts_per_hour` | the loop guard's limits, as in opsbot-slack | `6`, `20` |
| `screen` | the screen, same keys and contract as opsbot-slack | unset: nothing is screened |
| `post_log` | the post command's decision log; with `log.branch` set in opsbot.json it is unused: each line is a record of `posts/whatsapp` on the log branch, written with `opsbot-core log append posts/whatsapp` and counted for the loop guard with `opsbot-core log read`. A line that cannot be written after the send is a warning on stderr and the post still reports what happened | `logs/whatsapp-posts.jsonl` |
| `wake_grace_seconds` | how long the waker waits for the session's own monitor before it nudges; `0` nudges at once | `20` |
| `lookback` | how many events before the cursor the reader re-reads | `200` |

`OPSBOT_WHATSAPP_AXI` in the environment names another whatsapp-axi binary for every piece.

## The pieces

`install` prints the `wake.files` entry in its object form, naming `heartbeat.d/25-whatsapp-events` as the
input that reads the file, so a wake from it runs a fast check
([opsbot-core](opsbot-core.md#a-fast-cycle)).

**The daemon does the listening.** There is no listener here. What reaches the bot is decided
by the account's scope in whatsapp-axi: in a group in `tagged` scope, a message that mentions
the account, the parent of such a reply, replies down from it, and replies to the account's own
messages; in a `full` group, everything; direct messages from operators, or from anyone when
the operator set that. The README states this, and that the daemon receives every message of a
group it is in and discards the rest unwritten.

**`monitor.d/20-whatsapp-waker`.** Follows the wake file. For each new line it gives the session's own
monitor the first chance, exactly as the Slack listener does (`wake_grace_seconds`, default 20;
no wait while the bot is asleep), and then runs
`$OPSBOT_CORE nudge --now --reason whatsapp`, again every 10 seconds while the nudge reports
the agent busy, until it wakes or `ack_timeout_minutes` (30) pass. With `mark_read: seen` it
then waits for the event's key to appear in `logs/intake/seen` and runs `whatsapp-axi mark-read`
for that message: the blue ticks mean the session has the item, by construction, as the second
reaction does in Slack. It logs `read` only when the answer's `failed` is 0 and at least one
message was `marked` or `already_marked`: an exit 0 alone is not a mark. Otherwise it logs
`mark failed: <reason>`, never text, and tries again at the next seen-check, at most three times. It never reads message content: it resolves a wake line's `seq` to a key
with `whatsapp-axi events --after <seq-1> --limit 1`, using only the chat, id and sender marks.
It marks nothing for an event the reader would drop (`listen_to`, a peer rule). It logs one
line per wake line, never text. It exits non-zero, so the unit restarts, when the wake file
cannot be read.

**`heartbeat.d/25-whatsapp-events`.** Runs `whatsapp-axi events --after <cursor - lookback>`
and prints one item per `message` event, and one per `reaction` on the account's own message:
`{key, at, chat, chat_name, kind, from, from_operator, text, id, kept_by, reply_to?, media?,
reply, from_peer?, peer_note?, gate_word_void?}`.

- `key` is `whatsapp:<chat>:<id>:msg` or `whatsapp:<chat>:<id>:<emoji>:<user>`. The core's seen
  keys drop repeats, which is what makes the overlap safe.
- `kind` is `dm` or `group`. `from` is the sender's name, or number when there is no name.
- `reply_to` is the quoted parent as whatsapp-axi gives it (`id`, `from`, `text`).
- `media` is the descriptor (`type`, `mime`, `name`, `size`); the session fetches the file with
  `whatsapp-axi download` when it needs it.
- `reply` is `<chat> --reply <id>`, the arguments `opsbot-whatsapp post` takes before the text.
- The account's own messages, `edit` and `revoke` events, and `state` events are not items. A
  `state` event other than `connected` or `connecting` fails the input with one line naming the
  state, after the items are printed.
- With `listen_to: operators`, an item whose sender is not an operator is not printed; with
  `trusted`, one whose sender is neither an operator nor in `trusted`. A peer rule keeps a
  peer's either way.
- An item from anyone but an operator carries `from_operator: false` and
  `gate_word_void: "not an operator"`; one from a trusted person also carries
  `from_trusted: true`.
- It then writes the highest `seq` it saw to the cursor file. Exit 1 when whatsapp-axi fails or
  the daemon is not running; items already read are printed first.

**`escalate.d/20-whatsapp-dm`.** The message on stdin, prefixed with `OPSBOT_MARK`, is sent to
`escalate_chat` with `whatsapp-axi send`. It is the kit's own path to the operator and is never
screened. Exit 1 with one line on stderr when it cannot send.

## The trusted circle

WhatsApp has no workspace, so nothing in its data says who is "inside". The operator says so,
with one list: `trusted` is the people who know the operator runs a bot and whom the operator
trusts to use it. For one person's assistant that is a circle of friends making plans with it;
for a company's bot it is the staff.

Being trusted means two things, and only these:

- **The bot hears you.** With `listen_to: trusted`, a kept message from a trusted person
  becomes an item, wakes the session and gets a read receipt, as the operator's does. With
  `operators` only the operator's does; with `anyone`, everyone's.
- **A chat of only trusted people is its own class.** The post command classifies such a chat
  `trusted`, and the screen checks the draft against `screen.policy.trusted`, a policy the bot
  writes for that audience: what may be said among these people and what may not.

Being trusted never means authority. A trusted person's message is not the operator's word: it
cannot give the gate word, approve anything, or change what the bot may do. The bot's own rules
decide what it will do for them.

A sender whose phone number the daemon does not know is not trusted.

## Peer bots

Other bots are people as far as WhatsApp is concerned, so nothing drops them by default, and
two bots that answer each other never stop. A bot that shares a group with another bot lists it
in `peers`. A peer's message is an item only in that peer's `chats`; it carries `from_peer`,
`peer_note` and `gate_word_void`, exactly as in
[opsbot-slack](opsbot-slack.md#peer-bots); it passes `listen_to: operators`; it never counts
as the operator's word. A message from a number that is neither an operator, trusted, nor a
peer is an ordinary person's.

**The loop guard**, in the post command, in code: for a post into a chat listed for a peer,
read the chat's recent kept messages with `whatsapp-axi read`, count back from the newest to
the newest message from someone who is neither the bot nor a peer, and refuse at `peer_turns`
or more (exit 6); refuse at `peer_posts_per_hour` posts to that chat in the last hour, counted
from `post_log`; refuse when the chat cannot be read. A draft that mentions an operator is let
through once per run. Only kept messages are counted, which is all the bot can see; in a
`tagged` group that is the thread the bots are in.

## Posting (`opsbot-whatsapp post`)

`opsbot-whatsapp post <chat> [--reply <id>] [--file <path>] [--retry-id <send id>] [--dry-run]
[<text> | -]` is the only way a bot
posts to WhatsApp. Its first arguments are the reader's `reply` column, whole. In order, it:

1. refuses bad usage: no chat, an empty text with no file;
2. classifies the destination (below);
3. runs the loop guard when the chat is a peer's;
4. screens the draft when the settings name a policy for that class. A file's caption is the
   draft; the file itself is not screened, and a file to an `external` or `unknown` class is
   refused unless `screen.files_external` is `true`;
5. posts through `whatsapp-axi send` or `send-file` with `--id <send id>`. The send id is 32
   uppercase hex characters from the system's random source, new for each post attempt. With
   `--retry-id <id>` (16 to 48 characters of `0-9A-F`, else exit 2) that id is used instead, so
   a retry cannot send twice. When whatsapp-axi answers `already_sent: true`, the post reports
   `posted: true, replayed: true` and any `warning`, and nothing is sent again;
6. appends one line to `post_log`, whatever happened at 2 to 5;
7. prints one JSON object on stdout and exits with its code.

`--dry-run` does 1 to 4 and 6. `opsbot-whatsapp classify <chat>` does step 2 alone. The text is
plain: WhatsApp's own light formatting passes through, nothing is converted.

### Destination classes

Decided in code from `whatsapp-axi chat view <chat>`, which asks WhatsApp for the participants
at that moment and marks each as the account itself, an operator, or a contact. Never from the
model or the text.

| Class | Decided when | Screened with |
| --- | --- | --- |
| `operator-dm` | a direct chat whose other party is an operator | nothing |
| `trusted` | a group whose every participant is the bot, an operator, a `trusted` number or a listed peer; or a direct chat with a `trusted` number | `screen.policy.trusted` |
| `external` | any other participant; or a direct chat with anyone else | `screen.policy.external` |
| `unknown` | the lookup failed, the daemon is not connected, or a participant has no known phone number | as `external` |

- A participant WhatsApp shows only by its hidden id, with no phone number the daemon knows, is
  never assumed trusted: the class is `unknown`.
- Being in the account's address book does not make someone trusted. Only `operators`,
  `trusted` and `peers` count.
- The classes are `operator-dm`, `trusted`, `external` and `unknown`. There is no `internal`:
  that is Slack's word for a workspace's own members, and WhatsApp has no such thing. A bot on
  both channels may point `policy.trusted` at the same file as its Slack `policy.internal`, or
  at a different one.
- The class is cached per chat for `screen.cache_seconds`; `unknown` is never cached.
- The screen's contract, outcomes, told-once marker and exit codes 3 and 4 are opsbot-slack's,
  unchanged. Exit 1 is whatsapp-axi refusing or failing the send, with its
  error code passed through (`FIRST_CONTACT`, `RATE_LIMITED`, `DUPLICATE_TEXT`, `NOT_CONNECTED`,
  `DAEMON_NOT_RUNNING`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`). **An unknown outcome is its own
  result**, still exit 1: `{posted: "unknown", code: "OUTCOME_UNKNOWN", send_id, error, retry,
  next}`. The message may have gone out. `retry` is the exact same post with
  `--retry-id <send_id>`; when the text came on stdin it ends in `-`, and `next` says to send
  the same text again. A bot never posts it again without `--retry-id`. The loop guard's hourly
  count includes `"unknown"` posts. Exit 6 is the
  loop guard. There is no exit 5: the daemon holds one account, so there is no second identity
  to post as.

### The decision log

One line per attempt: `{at, chat, reply_to?, class, why, screen, reason?, error?, code?, peer?,
peer_guard?, draft_sha256, file?, send_id?, retry?, posted, id?, replayed?, warning?,
dry_run?}`. `posted` is `true`, `false` or `"unknown"`. `send_id` is on every line that reached
the send; `retry: true` marks a `--retry-id` post. `file` is the base name and size. Never the
draft, never the passage.

## Commands (`scripts/opsbot-whatsapp`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--dry-run] [--force]` | copies the three scripts into `opsbot.d/`, as opsbot-slack's install does; prints the `streams.whatsapp` block, the `wake.files` entry and the `whatsapp-axi settings set wake_file` command to run. Never writes `opsbot.json` and never changes the account's scope or operators | 0 · 2 |
| `status` | one row each with `ok`, `missing` or `differs` and the fix: whatsapp-axi present and new enough (its `doctor --json-out` file has a `checks` array); the account exists; its daemon installed, running and `connected` (else the state and the first failing check); one `differs` row per failing `doctor` check, with `whatsapp-axi doctor --account <account>` as the fix (skipped checks and the all-accounts hooks row are ignored); the account's `wake_file` equals the setting and is in `wake.files`; the account's operators equal `operators`; `read_receipts` is `on-read` when `mark_read` is `seen`; the account scope and each per-chat override, printed so the operator sees what the bot can read; each script present and matching its template; the waker unit active; `escalate_chat` set and an operator's direct chat; with `screen`, the command and policies usable; with `peers`, each peer usable and the bot a member of each listed chat | 0 · 1 |
| `post …` | [Posting](#posting-opsbot-whatsapp-post) | 0 · 1 · 2 · 3 · 4 · 6 |
| `classify <chat>` | `{chat, class, why, cached}` | 0 · 2 |

## Rules

- The skill holds no credential and never talks to WhatsApp. Why: the daemon is the one place
  the session lives, and its scope is the one place "what can this bot read" is decided.
- The operator sets scopes and operators in whatsapp-axi; `install` and `status` only report
  them. Why: widening what a bot reads is a person's decision, never a side effect of setup.
- The bot posts through `opsbot-whatsapp post` and nothing else; its allow rules name that
  command and not `whatsapp-axi send` ([permissions](../permissions.md)).
- Who reads a destination is decided from WhatsApp's participant list at post time, and a
  doubt is `external`. A person is inside only when the operator listed them.
- Blue ticks mean the session has the item. Why: a read receipt sent when a daemon stored a
  message promises a read nobody did.
- The waker and the reader never log or cache message text. The wake file carries none.
- A peer's word is never the operator's, and the count in code is what stops a run of bot
  turns.
- The reader computes `reply`; the loop answers there and nowhere else.
- `install` prints settings and never writes them.

## Principles

**Inherited** from [principles](../principles.md): answer fast, finish later; a guard in code
beats a rule in prose; a failed check is said out loud; the bot speaks for itself; own
identity (the bot's own account and number, never a person's).
