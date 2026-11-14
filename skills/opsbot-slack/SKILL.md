---
name: opsbot-slack
description: >-
  Slack for an ops bot: a Socket Mode listener that reacts the moment a DM, an @mention, a
  thread reply or a reaction arrives and wakes the loop; a heartbeat reader that turns those
  events into check items with the exact reply address and thread context; an escalation sink
  that DMs the operator in the bot's own name; an app manifest; an install and status command;
  and `opsbot-slack post`, the only way the bot posts, which classifies who reads the
  destination and can screen the draft first. Use when giving a bot a Slack presence, creating
  its Slack app, installing or checking its listener, posting a reply, setting up the reply
  screen, when a DM or @mention to the bot gets no reaction or no answer, when a reply lands in
  the wrong thread or was blocked, when the watchdog cannot escalate, or when a bot should hear
  only its owner, save files sent to it, hand prefixed DMs to a script, or must not post as a
  person. Triggers: "Slack for
  the bot", "Slack listener", "slack app manifest", "the bot did not react", "bot missed my
  DM", "app-level token", "xapp", "escalate to Slack", "screen replies", "post to Slack",
  "opsbot-slack", "listen_to", "intercept", "slack files".
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
| `scripts/opsbot-slack` | stays in the skill | `install`, `status`, and `post` and `classify` (through `scripts/slack-post.mjs`) |
| `templates/screen/` | the bot's repo, by hand, if it screens | a reference screen command and two policy starting points |

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
- a reply in a thread the bot was @mentioned in or started, with no new mention needed (the
  `message.channels`, `message.groups` and `message.mpim` events in the manifest; every other
  channel message is dropped unrecorded). A thread the bot only answered in does not count;
- a reaction on one of the bot's own messages;
- a new member joining the workspace.

For each it appends one JSON line to `events_file`, reacts `receipt_emoji` on a message, and
runs `$OPSBOT_CORE nudge --now`, repeating every 10 seconds while the agent is mid-turn until
it wakes or the item was read. It reacts `ack_emoji` only once the item's key is in
`logs/intake/seen`, which the core writes when the check reports the item to the model: the
second reaction means read. It logs every event type it receives, kept or not, so a missing
scope or event subscription shows in `journalctl --user -u opsbot-<bot>-monitor-10-slack-listener`.
It reconnects with backoff when the socket closes.

The bot's own messages are never items. Its own top-level posts in a channel are remembered as
thread roots in `slack-own-threads.jsonl`, beside the events file, for 90 days. A reply under
an older root, or one posted while the listener was down, is still kept when Slack's event
names the bot as the thread's parent author (`parent_user_id`).

A message that carries a `bot_id` is dropped, with a `dropped app post <conv> <user> <bot_id>`
line in the journal, unless an operator wrote it. An app posting with an operator's own user
token (an assistant posting as them) has their `user` and its own `bot_id`; when that `user` is
in `operators`, or the post is in `escalate_dm` and not the bot's, it is heard exactly as if
the operator typed it. Every other bot, integration or app post stays dropped, so two bots
never answer each other forever. The bot's own posts are known by `bot_user`, or by its own
`bot_id` on a post with no user.

**For a bot that answers one person** (an assistant), three opt-in steps run on a kept event
before it is recorded, in this order. None of them calls a model.

- `listen_to: "operators"` keeps only events whose author is in `operators`, and anything in
  `escalate_dm`. Anyone else's DM, mention, thread reply or reaction, and every `team_join`, is
  dropped: no record, no reaction, no wake, so the sender gets no sign. The journal gets
  `dropped non-operator <conv> <user> <kind>`, never the text. List the operator in `operators`
  to hear them in channels.
- `files: {"save": true}` downloads the message's files through `slack-axi download` to
  `.scratch/slack-files/<conv>/<ts>/<safe name>` and puts `path` on each file of the item. A file
  over `max_bytes` (25 MiB), of a type not in `types` (`image/*`, `application/pdf`, `text/*`), from
  a Slack Connect conversation (no type or size in the event), or whose download failed gets
  `skipped: "<why>"` instead. Without `save`, items still carry each file's id, name, type and size.
- `intercept: [{"prefix": "+ ", "command": ["bin/capture"], "kinds": ["dm"]}]` hands a message
  that starts with `prefix` (after leading whitespace, and a leading @mention of the bot for
  `mention`) to the command: argv, no shell, a path inside the repo or absolute. Its stdin is
  `{text, conv, ts, thread_ts, user, files}`, `text` after the prefix. Exit 0 within
  `timeout_seconds` (30): the message gets `intercept_emoji` (`white_check_mark`) and is not
  recorded and wakes nothing. Anything else: `intercept_failed_emoji` (`warning`), and the
  message is recorded as usual with `intercept: "failed: <why>"`. With `listen_to: "anyone"`,
  anyone who can message the bot can run the command.

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
  the message itself. Use it whole and unchanged: `opsbot-slack post <reply> "<markdown>"`.
- `from` is always the Slack user id. `from_slack` is what `slack-axi user` returned; when it
  could not resolve the sender, `from_note` says so. Never guess a name.
- `thread` comes from `slack-axi thread`: the count, the parent, the bot's last message there,
  and the command for the whole thread.
- A reaction item carries `reaction`; a new member is `event: "team_join"` with no `reply`.
- `files` lists the message's files (`{id, name, mimetype, size, path?, skipped?}`); open a
  `path` with the file-reading tool. `intercept` says an intercept command failed on it.

Exit 1 when the events file does not exist (the listener creates it on start, so this means
the listener never ran) or a sender lookup failed.

**The escalation sink** reads the message on stdin, opens it with the bot's mark, and posts it
once to `escalate_dm` through `slack-axi draft` and `draft send`. It refuses, with exit 1 and
one line on stderr, when `escalate_dm` is unset, the message is empty, slack-axi is not in bot
mode, or the draft or send fails. The core decides about retrying.

## Posting: `opsbot-slack post`

The bot posts with this command and nothing else. Not `slack-axi draft`, not the API.

```sh
.agents/skills/opsbot-slack/scripts/opsbot-slack post <reply> "<markdown>"
.agents/skills/opsbot-slack/scripts/opsbot-slack post <conv> - < reply.md   # text on stdin
```

It works out who reads the destination, screens the draft when the settings ask for it, posts
through slack-axi in bot mode, and logs the decision. It prints one JSON object.

| Exit | Means | What to do |
| --- | --- | --- |
| 0 | posted: `{posted: true, conv, ts, class, screen}` | nothing |
| 1 | Slack refused (not in bot mode, the draft or send failed) | fix slack-axi; say so |
| 2 | bad usage, or a screen setting it cannot use | fix the call or `opsbot.json` |
| 3 | blocked: `{screen: "block", passage, reason}` | rewrite without the passage, or ask the operator. Never post it another way |
| 4 | the screen failed; the operator was told once | wait for it, or ask the operator; nothing was posted |
| 5 | the token slack-axi would post with is not `bot_user`'s (`auth.test`), or that could not be checked | fix the slack-axi login (`opsbot-slack status`); never post another way |

`--dry-run` classifies and screens and posts nothing. `opsbot-slack classify <conv>` prints the
class alone.

**The posting identity.** A bot that runs as a person's Unix user may share a slack-axi store
with that person's own login, and `slack-axi auth mode bot` can be set over a person's token. So
before posting, with `bot_user` set, the command asks `auth.test` who the token slack-axi will
post with belongs to, and refuses (exit 5) unless it is `bot_user`. A match is cached for
`cache_seconds` under a hash of the token, so a swapped token is checked at once.

**The classes**, decided from Slack's data (`conversations.info`, `conversations.members`,
`users.info`, `auth.test`, with slack-axi's own bot token), never from the text:

| Class | When | Screened with |
| --- | --- | --- |
| `operator-dm` | a DM with someone in `operators`, or the `escalate_dm` conversation | never |
| `internal` | not shared, and every member a full member of the workspace. A DM with a full member who is not an operator is `internal` | `policy.internal` |
| `external` | Slack Connect or shared in any way, a guest, a deactivated account or someone from another organization among the members, or more than `max_members` members | `policy.external` |
| `unknown` | a lookup failed | `policy.external` |

The class is cached for `cache_seconds` beside the events file (`slack-classes.json`); an
`unknown` is not.

**The screen** is optional and is the bot's own command: the kit holds no model credential.
`streams.slack.screen`:

```json
"screen": {
  "command": "bin/slack-screen",
  "policy": {
    "internal": ["policy/slack-internal.md"],
    "external": ["policy/slack-internal.md", "policy/slack-external.md"]
  },
  "timeout_seconds": 30,
  "cache_seconds": 300,
  "max_members": 100
}
```

- The command gets one JSON object on stdin, `{draft, destination_class, policy}` (the class's
  files joined in order), and nothing else. It prints `{"verdict": "pass"}` or
  `{"verdict": "block", "passage": "…", "reason": "…"}`.
- A class with no list is not screened. List `internal` too only when the bot holds something
  its own team should not read.
- A timeout, a non-zero exit, output that is not JSON or another verdict: nothing is posted
  (exit 4). The operator hears once per outage through `opsbot.d/escalate.d/`; the marker is
  `.git/opsbot-slack-screen`, cleared by the next verdict.
- `templates/screen/screen` is a reference command: one Anthropic Messages API call with the
  key in `ANTHROPIC_API_KEY` (model `OPSBOT_SCREEN_MODEL`, default `claude-opus-5-5`). Copy it
  into the repo with the two `policy-*.md` files and make each policy specific to the bot.
- Every attempt is a line in `post_log` (`logs/slack-posts.jsonl`): class, why, verdict,
  reason, a SHA-256 of the draft. Never the draft. Add it to `commit_paths`.

A screen catches what looks confidential. It cannot know a plain-looking fact is private unless
the policy says so, and it does not replace a rule about where the bot's facts may come from.
The bot's allow rules name `opsbot-slack post`, never `slack-axi draft`, so the screen is not
optional for the session.

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
| `bot_id` | the bot's own bot id (`B…`), for its posts that carry no user | learned from its first own message |
| `escalate_dm` | the id of the bot's DM with its operator; an app's post there is the operator's | required for the sink |
| `app_token_file` | the app-level token, mode 600 | `~/.config/<bot>/slack-app-token` |
| `events_file` | where the listener records and the reader reads; also in `wake.files` | `~/.cache/<bot>/slack-events.jsonl` |
| `receipt_emoji` | the reaction on arrival | `eyes` |
| `ack_emoji` | the reaction once the check has reported the item | `gear` |
| `ack_timeout_minutes` | how long the listener keeps nudging and waiting for the read | `30` |
| `lookback_minutes` | extra window before `$OPSBOT_SINCE` | `30` |
| `bot_name` | the name the bot posts under, to find its last message in a thread | the bot's `name` |
| `team` | the workspace id, when slack-axi holds more than one | slack-axi's default |
| `sender_lookup` | the hook above | unset |
| `operators` | the operator's user ids; a DM with one is `operator-dm`, and an app's post as one is heard as theirs | none; `escalate_dm` still counts |
| `screen` | the screen (Posting, above) | unset: nothing screened, the class still logged |
| `post_log` | the post command's decision log, a repo path | `logs/slack-posts.jsonl` |
| `listen_to` | `anyone`, or `operators`: keep only operators' events, silently | `anyone` |
| `intercept` | rules that hand a prefixed message to a command before it is recorded | none |
| `intercept_emoji` | the reaction on a message a command took | `white_check_mark` |
| `intercept_failed_emoji` | the reaction when the command failed; the message is then recorded | `warning` |
| `files` | `{save, dir, max_bytes, types}`: save a kept message's files | metadata only |

`OPSBOT_SLACK_AXI` in the environment names another slack-axi binary for every piece.

## `opsbot-slack` commands

| Command | Does | Exit |
| --- | --- | --- |
| `install [--dry-run] [--force]` | copies the three scripts into `opsbot.d/`, executable. A file that already matches is left; one that differs is left unless `--force`. Prints what it wrote and left, then the `streams.slack` block and `wake.files` entry to merge (it never writes `opsbot.json`), and the manifest's path | 0 · 2 |
| `status` | one row each, `ok`, `missing` or `differs`, with the fix: the app-level token file (present, mode 600, `xapp-`; never printed), slack-axi signed in in bot mode, each script present and matching its template, `bot_user` and `escalate_dm` in `streams.slack`, the events file in `wake.files`, the listener's unit active; with `bot_user` set, the posting identity (`ok` only when `auth.test` names `bot_user`); with `screen` set, its command and policy files; with `listen_to`, `intercept` or `files` set, that setting (`listen_to: operators` with no `operators` and no `escalate_dm` is refused) | 0 all ok · 1 something to fix · 2 |
| `post <conv> [--reply <ts>] [--dry-run] [<markdown> \| -]` | classifies, screens when configured, checks the posting identity, posts in bot mode, logs (Posting, above) | 0 · 1 · 2 · 3 blocked · 4 screen failed · 5 not the bot |
| `classify <conv>` | `{conv, class, why, cached}` | 0 · 2 |

Exit 2 is bad usage (an unknown command or flag) or not a bot's repo (no `opsbot.json`).

## Rules

- Tokens live in files with mode 600 or in slack-axi's own store. Never in the repo, a chat,
  a log, or a command's output. `status` reads five characters of the token file and its mode.
- The bot posts as its bot user. The sink refuses to send when slack-axi is in human mode; the
  post command refuses when the token is not `bot_user`'s.
- Answer at `reply`, whole, through `opsbot-slack post`. The column is the address; a trimmed
  digest once put two answers in a third thread.
- Post only through `opsbot-slack post`. A blocked draft is rewritten or taken to the operator,
  never posted another way.
- The listener only watches. It never answers; the cycle does.
- Scopes change in the manifest first, in a pull request, then on the app.

## Principles

**Inherited** from the kit: answer fast, finish later (the receipt reaction needs no model);
a guard in code beats a rule in prose (the sink's bot-mode check, the `reply` column); the
schedule is not the bot's to keep (the nudge is the backstop); a failed check is said out loud
(a missing events file or a failed lookup degrades the input); the bot speaks for itself.
