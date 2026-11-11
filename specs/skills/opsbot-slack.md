# Skill: opsbot-slack

The bot in Slack, as its own bot user: a listener that hears events the moment they land, a
heartbeat reader that turns them into check items, an escalation sink, the Slack app's
manifest, one command that installs and checks them, and the one command a bot posts with.
It is the first channel skill (`opsbot-<channel>` in
[architecture](../architecture.md#the-composition)). The post command is the start of the
send guard: it classifies the destination in code and, when the bot configures it, screens
the draft before it posts. The rest of the send guard's refusals are not here yet.

## Installs

```
skills/opsbot-slack/
  SKILL.md                               when to use it, setup in order, the pieces, the rules
  README.md                              for a person: the app, the two tokens, what it can see
  scripts/opsbot-slack                   bash, no build step: install, status, post, classify
  scripts/slack-post.mjs                 node 22, no dependencies: post and classify, run by the above
  templates/manifest.yaml                the Slack app manifest, placeholders to replace
  templates/monitor.d/10-slack-listener  node 22, no dependencies
  templates/heartbeat.d/20-slack-events  node 22, no dependencies
  templates/escalate.d/10-slack-dm       bash, calls node for opsbot.json
  templates/screen/screen                node 22, no dependencies: a reference screen command
  templates/screen/policy-*.md           starting points for the two policy files
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
| `slack-classes.json`, beside the events file | the post command's cache: `{team, convs: {<conv>: {class, why, at}}, users: {<id>: {full, why, at}}}`; a failed lookup is never cached; never in `wake.files` |

In the repo, written by the post command:

| Path | What |
| --- | --- |
| `logs/slack-posts.jsonl` (`post_log`) | one line per post attempt; committed when the bot lists it in `commit_paths` |
| `.git/opsbot-slack-screen` | the screen's told-once marker: when the current screen outage began; removed by the next verdict; never committed |

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
| `operators` | the operator's user ids; a DM with one of them is `operator-dm` | none; `escalate_dm` alone still counts |
| `screen` | the screen ([Posting](#posting-opsbot-slack-post)) | unset: nothing is screened |
| `post_log` | the post command's decision log, a repo path | `logs/slack-posts.jsonl` |

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
`<conv> --reply <thread_ts or ts>`, the arguments `opsbot-slack post` takes before the text.
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

## Posting (`opsbot-slack post`)

`opsbot-slack post <conv> [--reply <ts>] [<markdown> | -]` is the only way a bot posts to Slack.
Its first arguments are the reader's `reply` column, whole: `opsbot-slack post <reply>
"<markdown>"`. The text is the last argument, or stdin when it is `-` or left out. In order, it:

1. refuses bad usage: no conversation id (`C…`, `D…` or `G…`), a `--reply` that is not a Slack
   `ts`, an empty text;
2. classifies the destination (below);
3. screens the draft when the settings name a policy for that class (below);
4. checks that slack-axi is in bot mode, then posts through `slack-axi draft` and `draft send`;
5. appends one line to `post_log`, whatever happened at 2 to 4;
6. prints one JSON object on stdout and exits with its code.

`--dry-run` does 1 to 3 and 5, and posts nothing. `opsbot-slack classify <conv>` does step 2
alone and prints `{conv, class, why, cached}`.

The escalation sink still posts to `escalate_dm` through slack-axi itself. It is the kit's own
path to the operator, it must work while the screen is down, and its destination would be
`operator-dm`, which is never screened.

### Destination classes

Decided in code from Slack's own data, never from the model or the text. The post command reads
the Web API with the bot token from slack-axi's own store (`SLACK_AXI_TOKEN` when set, else the
workspace `team` names, slack-axi's default, or its only one), the token it already posts with,
and never prints it.

| Class | Decided when | Screened with |
| --- | --- | --- |
| `operator-dm` | `conversations.info` says `is_im`, and its `user` is in `operators`, or the conversation is `escalate_dm` | nothing; the screen is never called |
| `internal` | not shared in any way (`is_shared`, `is_ext_shared`, `is_org_shared`, `is_pending_ext_shared` all false or absent), and every member, read from `conversations.members` to the last page, is a full member: `users.info` gives the bot's own `team_id` (from `auth.test`) and `is_restricted`, `is_ultra_restricted`, `is_stranger` and `deleted` are not true. A DM (`is_im`) is judged by its `user` alone | `screen.policy.internal` |
| `external` | shared in any of those ways; or any member is a guest, a deactivated account, or from another team; or the conversation has more than `screen.max_members` members (`num_members`, or counted while paging) | `screen.policy.external` |
| `unknown` | any lookup failed: no token, a Slack error, a missing field it needs, a timeout | as `external` |

- A DM with a full member who is not an operator is `internal`. Its readers are that person and
  the bot, both full members, which is the definition. A bot that must not tell even its own
  team something screens `internal` too.
- A group DM (`is_mpim`) is judged like a channel, by its members.
- Large channels: listing members pages by 200 and stops as soon as the count passes
  `max_members`, and each member's `users.info` is cached in the same file for the same time,
  so a busy channel costs its lookups once per `cache_seconds`. Over the bound the class is
  `external`, never a guess at `internal`: the bound trades a screen call for certainty.
- The class and the one-line `why` are cached per conversation for `cache_seconds`. `unknown`
  is never cached. There is no invalidation on a membership change: the cache is short instead.
- Without `screen` the class is still worked out and logged with every post, and an `unknown`
  does not stop the post.

### The screen

`streams.slack.screen`:

| Key | Meaning | Default |
| --- | --- | --- |
| `command` | a path inside the repo to the bot's own executable; a path outside is refused | required |
| `policy.internal`, `policy.external` | a list of repo paths per class, read and joined in order with a blank line between; `external` usually lists the `internal` file first and then its own, so the shared part is written once | a class with no list is not screened |
| `timeout_seconds` | how long the command may take | `30` |
| `cache_seconds` | how long a class (and a member's lookup) is kept | `300` |
| `max_members` | above this, a channel is `external` without listing everyone | `100` |

The kit holds no model credential and makes no model call. The command is the bot's own (an
API key in its environment, a metered gateway). Its contract:

- **stdin**, one JSON object and nothing else: `{"draft": "<the markdown>",
  "destination_class": "internal" | "external" | "unknown", "policy": "<the joined files>"}`.
  No tools, no repo, no session context, no conversation id, no thread: an injection in the
  session does not carry over.
- **stdout**, one JSON object: `{"verdict": "pass"}` or `{"verdict": "block", "passage":
  "<the words that must not go>", "reason": "<why, against the policy>"}`.
- It runs from the repo root with the bot's environment. Exit 0 is required.

What the post command does with it:

| Outcome | Posted | Exit | Output |
| --- | --- | --- | --- |
| `pass` | yes | 0 | `{posted: true, conv, ts, class, screen: "pass"}` |
| `block` | no | 3 | `{posted: false, class, screen: "block", passage, reason}` |
| a non-zero exit, a timeout, output that is not JSON, a verdict that is neither | no | 4 | `{posted: false, class, screen: "error", error}` |

- On `block` nothing is changed or redacted: an edited message can change its meaning. The
  session rewrites it, or takes it to the operator.
- On exit 4 the operator is told once per outage through `opsbot.d/escalate.d/`, the same scripts
  the watchdog uses, with the class, the error and no draft. The outage's start goes in
  `.git/opsbot-slack-screen`; while it is there no one is told again. Any verdict, `pass` or
  `block`, removes it. When no escalation script succeeds the marker is not written, so the next
  failure tries again.
- `operator-dm` never runs the command, with or without `screen`.
- A screen setting that cannot be used (no command, a command outside the repo or not
  executable, a policy file missing) is exit 2 for a class that would be screened: nothing is
  posted.

### The decision log

One line per attempt in `post_log`: `{at, conv, reply_to?, class, why, screen: "pass" | "block" |
"error" | "skipped", reason?, error?, draft_sha256, posted, ts?, dry_run?}`. The hash is of the
text as given. Never the draft, never the passage.

### Exit codes

| Exit | Meaning | Posted |
| --- | --- | --- |
| 0 | posted (with `--dry-run`: would be) | yes |
| 1 | Slack refused: slack-axi not in bot mode, the draft or the send failed | no, unless the send failed after Slack took it |
| 2 | bad usage, no `opsbot.json`, or an unusable screen setting | no |
| 3 | the screen blocked it | no |
| 4 | the screen could not be run or answered badly; the operator told once | no |

### Limits

The screen catches what looks confidential. It cannot know that a plain-looking fact is private
unless the policy says so. It complements a provenance rule (the session declares its sources,
and code refuses the ones a class may not draw on) and does not replace one. A bot that posts
another way (slack-axi directly, the API) goes around both: the bot's allow rules name
`opsbot-slack post` and not `slack-axi draft` ([permissions](../permissions.md)).

## Commands (`scripts/opsbot-slack`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--dry-run] [--force]` | copies the three scripts into `opsbot.d/`, mode 755; a matching file is left, a differing one is left unless `--force`; prints each file written or left, then the `streams.slack` block and the `wake.files` entry to merge, and the manifest's path. Never writes `opsbot.json` | 0 · 2 |
| `status` | one row each with `ok`, `missing` or `differs` and the fix: the app-level token file (present, mode 600, `xapp-`), slack-axi signed in in bot mode, each of the three scripts present, matching its template and executable, `bot_user` and `escalate_dm` set, the events file in `wake.files`, the unit `opsbot-<bot>-monitor-10-slack-listener.service` active; with `screen` set, one more row: the command executable inside the repo and every policy file present | 0 all ok · 1 something to fix · 2 |
| `post <conv> [--reply <ts>] [--dry-run] [<markdown> \| -]` | [Posting](#posting-opsbot-slack-post) | 0 · 1 · 2 · 3 · 4 |
| `classify <conv>` | the destination class alone, `{conv, class, why, cached}` | 0 · 2 |

Exit 2 is an unknown command or flag, or no `opsbot.json` at the repo root.

## Rules

- Tokens are never printed, logged or placed in the repo. Scripts read the app-level token
  from a mode-600 file; `status` reads its first five characters and its mode, nothing more.
- The bot posts as its bot user: the sink refuses when slack-axi is in human mode.
- The reader computes `reply`; the loop answers there and nowhere else. Why: a bot that
  trimmed its digest answered two questions in a third thread.
- The bot posts through `opsbot-slack post` and nothing else. Why: a check the session can
  step around is a rule in prose; the class and the screen live in the one path to Slack.
- Who reads a destination is decided from Slack's data, and a doubt is `external`. Why: the
  session's sense of a channel is what a confused or injected session gets wrong.
- The screen fails closed and never edits. Why: an error that posts lets the one draft the
  screen was for go out; an edited draft can say something its author did not mean.
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
