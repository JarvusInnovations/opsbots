# Skill: opsbot-slack

The bot in Slack, as its own bot user: a listener that hears events the moment they land, a
heartbeat reader that turns them into check items, an escalation sink, the Slack app's
manifest, and one command that installs and checks them. It is the first channel skill
(`opsbot-<channel>` in [architecture](../architecture.md#the-composition)). The send guard is
not here yet: replies go through `slack-axi`'s own draft and send steps.

## Installs

```
skills/opsbot-slack/
  SKILL.md                               when to use it, setup in order, the pieces, the rules
  README.md                              for a person: the app, the two tokens, what it can see
  scripts/opsbot-slack                   bash, no build step: install and status
  templates/manifest.yaml                the Slack app manifest, placeholders to replace
  templates/monitor.d/10-slack-listener  node 22, no dependencies
  templates/heartbeat.d/20-slack-events  node 22, no dependencies
  templates/escalate.d/10-slack-dm       bash, calls node for opsbot.json
```

`opsbot-slack install` copies the three scripts into the bot's `opsbot.d/`; the core then runs
them by its directory contract ([opsbot-core](opsbot-core.md#lifecycle-directories-opsbotd)).
The manifest is copied into the bot's repo by hand, since its placeholders are filled by a
person.

Outside the repo, on the bot's user:

| Path | What |
| --- | --- |
| `~/.config/<bot>/slack-app-token` | the app-level token (`xapp-`, `connections:write`), mode 600 |
| slack-axi's own store | the bot token (`xoxb-`), set by `slack-axi auth login` |
| `~/.cache/<bot>/slack-events.jsonl` | the events file: the listener appends, the reader reads, the session's monitor wakes on it |
| `slack-own-threads.jsonl`, beside the events file | the bot's own top-level channel posts, remembered as thread roots: one `{conv, ts, recorded_at}` line each, written and read by the listener only, never items, never in `wake.files` |

## Settings (`streams.slack` in `opsbot.json`)

| Key | Meaning | Default |
| --- | --- | --- |
| `bot_user` | the bot's own user id: its own messages are never events, and only reactions on its messages are kept | required |
| `escalate_dm` | the id of the bot's DM with its operator | required for the sink |
| `app_token_file` | the app-level token file | `~/.config/<bot>/slack-app-token` |
| `events_file` | the events file; must also be in `wake.files` | `~/.cache/<bot>/slack-events.jsonl` |
| `receipt_emoji` | the listener's reaction on arrival | `eyes` |
| `ack_emoji` | the reaction once the check reported the item | `gear` |
| `ack_timeout_minutes` | how long the listener keeps nudging and waiting for the read | `30` |
| `lookback_minutes` | extra reader window before `OPSBOT_SINCE` | `30` |
| `bot_name` | the name the bot posts under, to find its last message in a thread | the bot's `name` |
| `team` | the workspace id passed to slack-axi as `--team` | slack-axi's default |
| `sender_lookup` | a repo path to the sender hook (below) | unset |

`OPSBOT_SLACK_AXI` in the environment names another slack-axi binary for every piece.

## The pieces

**`monitor.d/10-slack-listener`.** A Socket Mode client on the app-level token. It keeps a DM to
the bot, an `app_mention`, a thread reply in a channel or private channel the bot is in (when
the app subscribes to channel messages), a `reaction_added` on the bot's own message, and a
`team_join`. A thread reply without an @mention of the bot is kept when any of these holds:

- the events file holds a recorded @mention, or an already kept reply, in that thread;
- the thread's root is one of the bot's own top-level posts, remembered in the own-threads
  file;
- the event's `parent_user_id` is `bot_user`. Slack sets it on thread replies but does not
  document it on message events, so it is a backstop, never the only record. It covers a root
  posted while the listener was down.

A reply that @mentions the bot is left to its `app_mention` event. A thread the bot only
replied in, with no mention and not rooted on its own post, does not count, so a busy thread it
answered once stays quiet. The bot's own messages are never items. Its own top-level post in a
channel or private channel (no `thread_ts`, or `thread_ts` equal to `ts`; no subtype other than
`file_share` or `bot_message`) is appended to the own-threads file and nothing else is done
with it; its replies are not roots. On each append, roots whose `ts` is more than 90 days old
are dropped from the file, so it holds at most 90 days of the bot's posts. A reply under an
older root is kept only through `parent_user_id`.

Each kept event is one line in `events_file`:
`{key, at, event, kind, conv, from, text, ts, thread_ts, reaction?, recorded_at}`, keyed
`slack:<conv>:<ts>:msg`, `slack:<conv>:<ts>:<emoji>:<user>` or `slack:team_join:<user>`. On a
message it reacts `receipt_emoji`. It runs `$OPSBOT_CORE nudge --now --reason …`, again every
10 seconds while the nudge reports the agent busy, until it wakes, the key is seen, or
`ack_timeout_minutes` pass. It reacts `ack_emoji` only once the key is in `logs/intake/seen`.
It logs one line for every event it receives, kept or not. It reconnects with backoff (5 s,
doubling, at most 300 s) on a close or a `disconnect`. It refuses to start when the token file
is missing, readable by others, or not `xapp-`.

**`heartbeat.d/20-slack-events`.** Prints one item per line recorded at or after `OPSBOT_SINCE`
less `lookback_minutes`, by `recorded_at`:
`{key, at, conv, kind, from, text, ts, thread_ts?, reply?, event, reaction?, from_slack?,
from_note?, thread?, …lookup}`. `kind` is `dm` or `group`. `reply` is
`<conv> --reply <thread_ts or ts>`, the arguments `slack-axi draft` takes before the text.
`from_slack` is the row `slack-axi user` returns, without its id; `from_note` replaces it when
the sender cannot be resolved. `thread` is `{n, parent, last_mine, full}` from
`slack-axi thread`, with a `note` when it could not be read. Exit 1 when the events file does
not exist or a lookup failed; items are printed first.

**`escalate.d/10-slack-dm`.** The message on stdin, prefixed with `OPSBOT_MARK`, is drafted to
`escalate_dm` and sent once. Exit 1, with one line on stderr, when `escalate_dm` is unset, the
message is empty, slack-axi is not in bot mode, or the draft or send fails.

**`templates/manifest.yaml`.** A bot user on Socket Mode. Bot scopes: `app_mentions:read`,
`chat:write`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`,
`channels:history`, `channels:read`, `groups:history`, `groups:read`, `reactions:read`,
`reactions:write`, `users:read`, `files:read`, each commented with why. Bot events:
`app_mention`, `message.im`, `message.channels`, `message.groups`, `message.mpim`,
`reaction_added`, `team_join`. The three channel message events are what let a reply in a
thread reach the bot without a new @mention; the listener keeps only replies in a thread that
began with a mention or that the bot started, and drops every other channel message
unrecorded. Listed as options in a
comment, off by default: `users:read.email`, `files:write`, `channels:join`,
`chat:write.public`.

## The sender hook

`streams.slack.sender_lookup` names an executable inside the bot's repo; a path outside it is
refused. The reader runs it once per sender per check, from the repo root, with
`{id, …the slack-axi user row}` as JSON on stdin (only `{id}` when slack-axi could not resolve
the sender). It prints one JSON object; each of its keys is added to every item from that
sender unless the item already has the key. A non-zero exit or output that is not a JSON object
fails the input after every item is printed. This is where a bot's own knowledge of its people
goes (team membership, a customer), never into the kit.

## Commands (`scripts/opsbot-slack`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--dry-run] [--force]` | copies the three scripts into `opsbot.d/`, mode 755; a matching file is left, a differing one is left unless `--force`; prints each file written or left, then the `streams.slack` block and the `wake.files` entry to merge, and the manifest's path. Never writes `opsbot.json` | 0 · 2 |
| `status` | one row each with `ok`, `missing` or `differs` and the fix: the app-level token file (present, mode 600, `xapp-`), slack-axi signed in in bot mode, each of the three scripts present, matching its template and executable, `bot_user` and `escalate_dm` set, the events file in `wake.files`, the unit `opsbot-<bot>-monitor-10-slack-listener.service` active | 0 all ok · 1 something to fix · 2 |

Exit 2 is an unknown command or flag, or no `opsbot.json` at the repo root.

## Rules

- Tokens are never printed, logged or placed in the repo. Scripts read the app-level token
  from a mode-600 file; `status` reads its first five characters and its mode, nothing more.
- The bot posts as its bot user: the sink refuses when slack-axi is in human mode.
- The reader computes `reply`; the loop answers there and nowhere else. Why: a bot that
  trimmed its digest answered two questions in a third thread.
- The listener records only what it keeps and logs every event type it receives. Why: the
  first @mention test did nothing because the app lacked `app_mentions:read`; a log of every
  event is what shows such a gap.
- The bot's own messages are never items; its own top-level channel posts are only remembered
  as thread roots. Why: a bot posted in a channel, a person replied under the post without an
  @mention, and the listener dropped the reply because the thread held no mention.
- The second reaction means read, by construction: it waits for the seen key. Why: a reaction
  added on arrival promised a read that a busy agent had not done.
- `install` prints settings and never writes them; the operator commits `opsbot.json`.
- Scopes change in the manifest first, in a reviewed pull request.

## Principles

**Inherited** from [principles](../principles.md): answer fast, finish later; a guard in code
beats a rule in prose; the schedule is not the bot's to keep (the listener's nudge is the
backstop to the session's own monitor); a failed check is said out loud; the bot speaks for
itself; own identity, or configuration that makes it one setting (the bot's own app and
tokens; `team` when a host holds more than one workspace).
