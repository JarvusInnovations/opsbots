---
name: opsbot-slack
description: >-
  Slack for an ops bot: a Socket Mode listener that reacts the moment a DM, an @mention, a
  thread reply or a reaction arrives and wakes the loop; a heartbeat reader that turns those
  events into check items with the exact reply address and thread context; an escalation sink
  that DMs the operator in the bot's own name; an app manifest; and an install and status
  command. Use when giving a bot a Slack presence, creating its Slack app, installing or
  checking its listener, when a DM or @mention to the bot gets no reaction or no answer, when
  a reply lands in the wrong thread, or when the watchdog cannot escalate. Triggers: "Slack
  for the bot", "Slack listener", "slack app manifest", "the bot did not react", "bot missed
  my DM", "app-level token", "xapp", "escalate to Slack", "opsbot-slack".
---

# opsbot-slack: the bot in Slack

Three scripts that drop into the bot's `opsbot.d/` (the `opsbot-core` lifecycle directories), a
Slack app manifest, and one command that installs and checks them. The bot speaks as its own
bot user, never as a person.

| Piece | Goes to | Does |
| --- | --- | --- |
| `templates/monitor.d/10-slack-listener` | `opsbot.d/monitor.d/` | always on: hears events over Socket Mode, records them, reacts, wakes the loop |
| `templates/heartbeat.d/20-slack-events` | `opsbot.d/heartbeat.d/` | every check: the recorded events as items |
| `templates/escalate.d/10-slack-dm` | `opsbot.d/escalate.d/` | when the core must reach the operator: one DM |
| `templates/manifest.yaml` | the bot's repo, by hand | the Slack app: bot user, scopes, events, Socket Mode |
| `scripts/opsbot-slack` | stays in the skill | `install` and `status` |

## Setup, in order

Run as the bot's user, from the bot's repo checkout. The person-facing walk-through, with
where each token goes, is [README.md](README.md).

1. **The app.** Copy `templates/manifest.yaml` into the repo (`slack/manifest.yaml`), replace
   the placeholders, and create the app from it. Install it to the workspace.
2. **The bot token** (`xoxb-`): `slack-axi auth login --token xoxb-...`. This puts slack-axi in
   bot mode; everything the bot posts goes out as its bot user.
3. **The app-level token** (`xapp-`, scope `connections:write`): into
   `~/.config/<bot>/slack-app-token`, mode 600. The listener reads it from there.
4. **The scripts.** `scripts/opsbot-slack install`. It copies the three scripts and prints the
   `streams.slack` block and the `wake.files` entry. Merge them into `opsbot.json` with the
   bot's user id (`bot_user`) and the id of its DM with the operator (`escalate_dm`); commit.
5. **The unit.** `opsbot-core infra install` renders the listener as the user service
   `opsbot-<bot>-monitor-10-slack-listener`.
6. **Check.** `scripts/opsbot-slack status` until every row is `ok`. Then DM the bot: the
   receipt reaction lands within seconds, the read reaction once the check reports it.

## What each piece does

**The listener** holds a Socket Mode connection on the app-level token and keeps:

- a direct message to the bot;
- an @mention (`app_mention`);
- a reply in a thread the bot was @mentioned in (only when the app subscribes to
  `message.channels` / `message.groups`, an option in the manifest);
- a reaction on one of the bot's own messages;
- a new member joining the workspace.

For each it appends one JSON line to `events_file`, reacts `receipt_emoji` on a message, and
runs `$OPSBOT_CORE nudge --now`, repeating every 10 seconds while the agent is mid-turn until
it wakes or the item was read. It reacts `ack_emoji` only once the item's key is in
`logs/intake/seen`, which the core writes when the check reports the item to the model: the
second reaction means read. It logs every event type it receives, kept or not, so a missing
scope or event subscription shows in `journalctl --user -u opsbot-<bot>-monitor-10-slack-listener`.
It reconnects with backoff when the socket closes.

The events file is in `wake.files`, so the session's own bounded monitor wakes on it first.
The nudge is the backstop that survives the session. With `loop.schedule: "monitor"` the one
schedule monitor is that wake; the nudge stays, with its own cooldown.

**The reader** prints one item per event recorded since the check's window opened
(`$OPSBOT_SINCE` less `lookback_minutes`, judged by when the listener recorded it, since Slack
can deliver late):

```json
{"key": "slack:D0DM000001:1794400100.000200:msg", "at": "…", "conv": "D0DM000001", "kind": "dm",
 "from": "U0ANN00001", "text": "and the second one", "ts": "1794400100.000200",
 "thread_ts": "1794400000.000100", "reply": "D0DM000001 --reply 1794400000.000100",
 "event": "message", "from_slack": {"name": "…", "display_name": "…", "kind": "member"},
 "thread": {"n": 2, "parent": "…", "last_mine": "…", "full": "slack-axi thread D0DM000001 1794400000.000100"}}
```

- `key` is stable, so the core drops what it has already reported.
- `kind` is `dm` for a direct message conversation, else `group`.
- `reply` is where the answer goes: the thread when the message is threaded, else a thread on
  the message itself. Use it whole and unchanged: `slack-axi draft <reply> "<markdown>"`.
- `from` is always the Slack user id. `from_slack` is what `slack-axi user` returned; when it
  could not resolve the sender, `from_note` says so. Never guess a name.
- `thread` comes from `slack-axi thread`: the count, the parent, the bot's last message there,
  and the command for the whole thread.
- A reaction item carries `reaction`; a new member is `event: "team_join"` with no `reply`.

Exit 1 when the events file does not exist (the listener creates it on start, so this means
the listener never ran) or a sender lookup failed.

**The escalation sink** reads the message on stdin, opens it with the bot's mark, and posts it
once to `escalate_dm` through `slack-axi draft` and `draft send`. It refuses, with exit 1 and
one line on stderr, when `escalate_dm` is unset, the message is empty, slack-axi is not in bot
mode, or the draft or send fails. The core decides about retrying.

## `sender_lookup`

Some bots need to know more about a sender than Slack says: whether they are on the team,
which customer they belong to. That knowledge is the bot's own, so the reader takes a hook:

- `streams.slack.sender_lookup` is a path inside the bot's repo to an executable.
- It is run once per sender per check, from the repo root, with the sender on stdin as one
  JSON object: `{"id": "U…", "name": …, "display_name": …, "kind": "member" | "guest" |
  "external" | "bot", "title"?: …, "email"?: …}`. `title` and `email` appear only when the
  bot token's scopes return them (`email` needs `users:read.email`). When slack-axi could not
  resolve the sender, only `id` is sent.
- It prints one JSON object on stdout. Each key is added to the item unless the item already
  has it: `{"from_team": true}`, `{"customer": "acme"}`.
- A non-zero exit, or output that is not a JSON object, fails the reader's input: every item
  is still printed, and the check reports the stream as degraded with the lookup's first
  stderr line.
- Unset, nothing is added.

## `streams.slack` settings

| Key | Meaning | Default |
| --- | --- | --- |
| `bot_user` | the bot's own user id; its own messages are never events, and only reactions on its messages are kept | required |
| `escalate_dm` | the id of the bot's DM with its operator | required for the sink |
| `app_token_file` | the app-level token, mode 600 | `~/.config/<bot>/slack-app-token` |
| `events_file` | where the listener records and the reader reads; also in `wake.files` | `~/.cache/<bot>/slack-events.jsonl` |
| `receipt_emoji` | the reaction on arrival | `eyes` |
| `ack_emoji` | the reaction once the check has reported the item | `gear` |
| `ack_timeout_minutes` | how long the listener keeps nudging and waiting for the read | `30` |
| `lookback_minutes` | extra window before `$OPSBOT_SINCE` | `30` |
| `bot_name` | the name the bot posts under, to find its last message in a thread | the bot's `name` |
| `team` | the workspace id, when slack-axi holds more than one | slack-axi's default |
| `sender_lookup` | the hook above | unset |

`OPSBOT_SLACK_AXI` in the environment names another slack-axi binary for every piece.

## `opsbot-slack` commands

| Command | Does | Exit |
| --- | --- | --- |
| `install [--dry-run] [--force]` | copies the three scripts into `opsbot.d/`, executable. A file that already matches is left; one that differs is left unless `--force`. Prints what it wrote and left, then the `streams.slack` block and `wake.files` entry to merge (it never writes `opsbot.json`), and the manifest's path | 0 · 2 |
| `status` | one row each, `ok`, `missing` or `differs`, with the fix: the app-level token file (present, mode 600, `xapp-`; never printed), slack-axi signed in in bot mode, each script present and matching its template, `bot_user` and `escalate_dm` in `streams.slack`, the events file in `wake.files`, the listener's unit active | 0 all ok · 1 something to fix · 2 |

Exit 2 is bad usage (an unknown command or flag) or not a bot's repo (no `opsbot.json`).

## Rules

- Tokens live in files with mode 600 or in slack-axi's own store. Never in the repo, a chat,
  a log, or a command's output. `status` reads five characters of the token file and its mode.
- The bot posts as its bot user. The sink refuses to send when slack-axi is in human mode.
- Answer at `reply`, whole. The column is the address; a trimmed digest once put two answers
  in a third thread.
- The listener only watches. It never answers; the cycle does.
- Scopes change in the manifest first, in a pull request, then on the app.

## Principles

**Inherited** from the kit: answer fast, finish later (the receipt reaction needs no model);
a guard in code beats a rule in prose (the sink's bot-mode check, the `reply` column); the
schedule is not the bot's to keep (the nudge is the backstop); a failed check is said out loud
(a missing events file or a failed lookup degrades the input); the bot speaks for itself.
