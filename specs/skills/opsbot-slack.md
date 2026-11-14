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
| `slack-classes.json`, beside the events file | the post command's cache: `{team, convs: {<conv>: {class, why, at}}, users: {<id>: {full, why, at}}, identity?: {token, user, name, team, at}}`; `identity.token` is the first 16 hex characters of the SHA-256 of the token, never the token; a failed lookup is never cached; never in `wake.files` |

In the repo:

| Path | What |
| --- | --- |
| `logs/slack-posts.jsonl` (`post_log`) | written by the post command: one line per post attempt; committed when the bot lists it in `commit_paths` |
| `.git/opsbot-slack-screen` | written by the post command: the screen's told-once marker: when the current screen outage began; removed by the next verdict; never committed |
| `.scratch/slack-files/<conv>/<ts>/` (`files.dir`) | written by the listener when `files.save` is on: the files of a kept message ([Files](#files)); inside `.scratch/`, so never committed |

## Settings (`streams.slack` in `opsbot.json`)

| Key | Meaning | Default |
| --- | --- | --- |
| `bot_user` | the bot's own user id: its own messages are never events, and only reactions on its messages are kept | required |
| `bot_id` | the bot's own bot id (`B…`, `auth.test` on the bot token); a message carrying it is the bot's own | unset; learned from the bot's first own message the listener hears |
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
| `operators` | the operator's user ids; a DM with one of them is `operator-dm`; an app's post as one of them is heard like their own ([Posts through an app](#posts-through-an-app)) | none; `escalate_dm` alone still counts |
| `screen` | the screen ([Posting](#posting-opsbot-slack-post)) | unset: nothing is screened |
| `post_log` | the post command's decision log, a repo path | `logs/slack-posts.jsonl` |
| `listen_to` | `anyone` or `operators`: whose events the listener keeps ([Owner-only listening](#owner-only-listening)) | `anyone` |
| `intercept` | a list of rules that hand a matching message to a command before it is recorded ([The intercept](#the-intercept)) | none |
| `intercept_emoji` | the reaction on a message a command took | `white_check_mark` |
| `intercept_failed_emoji` | the reaction on a message whose command failed; it is then recorded as usual | `warning` |
| `files` | whether and how the listener saves a kept message's files ([Files](#files)) | unset: metadata only, nothing saved |

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
answered once stays quiet. The bot's own messages, by `bot_user` or by its own `bot_id`, are
never items. A message carrying any other `bot_id` is dropped unless an operator wrote it
([Posts through an app](#posts-through-an-app)). Its own top-level post in a
channel or private channel (no `thread_ts`, or `thread_ts` equal to `ts`; no subtype other than
`file_share` or `bot_message`) is appended to the own-threads file and nothing else is done
with it; its replies are not roots. On each append, roots whose `ts` is more than 90 days old
are dropped from the file, so it holds at most 90 days of the bot's posts. A reply under an
older root is kept only through `parent_user_id`.

A kept event then passes three optional steps, in this order, before anything is recorded:
`listen_to` may drop it ([Owner-only listening](#owner-only-listening)); its files are saved
when `files.save` is on ([Files](#files)); an `intercept` rule may hand it to a command
([The intercept](#the-intercept)). With none of the three set, every kept event is recorded.

Each recorded event is one line in `events_file`:
`{key, at, event, kind, conv, from, text, ts, thread_ts, reaction?, files?, intercept?,
recorded_at}`, keyed `slack:<conv>:<ts>:msg`, `slack:<conv>:<ts>:<emoji>:<user>` or
`slack:team_join:<user>`. `files` appears only on a message that carries files. On a message
it reacts `receipt_emoji`. It runs `$OPSBOT_CORE nudge --now --reason …`, again every
10 seconds while the nudge reports the agent busy, until it wakes, the key is seen, or
`ack_timeout_minutes` pass. It reacts `ack_emoji` only once the key is in `logs/intake/seen`.
It logs one line for every event it receives, kept or not. It reconnects with backoff (5 s,
doubling, at most 300 s) on a close or a `disconnect`. It refuses to start when the token file
is missing, readable by others, or not `xapp-`.

**`heartbeat.d/20-slack-events`.** Prints one item per line recorded at or after `OPSBOT_SINCE`
less `lookback_minutes`, by `recorded_at`:
`{key, at, conv, kind, from, text, ts, thread_ts?, reply?, event, reaction?, files?,
intercept?, from_slack?, from_note?, thread?, …lookup}`. `kind` is `dm` or `group`. `files` and
`intercept` are the recorded line's, as the listener wrote them. `reply` is
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

## Posts through an app

A message can carry a `bot_id` and still be a person's. An app that holds a person's user
token (an assistant posting as its operator from a command line) posts as that person: `user`
is theirs, and the message also carries the app's `bot_id`. The listener sorts every message,
`app_mention` and reaction by its sender, in this order:

1. **The bot itself, by user**: `user` is `bot_user`. Never an item. Its own top-level
   channel post is only remembered as a root ([the listener](#the-pieces)).
2. **A person**: no `bot_id` and no `bot_message` subtype. The listener's rules, unchanged.
3. **An operator through an app**: a `bot_id`, and a `user` that is in `operators`, or any
   `user` other than the bot in the `escalate_dm` conversation. The post command already
   treats that conversation as the operator's DM, and a DM has only two members. Heard exactly
   like a message the operator typed: the DM, mention-thread and own-thread rules all apply,
   and the item's `from` is the operator. This comes before the `bot_id` test below, so an
   operator's post through the bot's own app is still the operator's.
4. **The bot itself, by bot id**: no `user`, and `bot_id` is the bot's own: `bot_id` in the
   settings, else the `bot_id` on the first message the listener hears from `bot_user`. Never
   an item, and remembered as a root like step 1. A post with a `user` that is neither the bot
   nor an operator is never the bot's, whatever its `bot_id`.
5. **Another bot**: any other `bot_id`: another bot, an integration, a workflow, an app posting
   as someone who is not an operator. Dropped, with one journal line,
   `dropped app post <conv> <user> <bot_id>`, never the text.

A `bot_message` subtype is never an item. Slack sends it for a classic integration's post, and
its reference says such a message "has no associated user", so it cannot be an operator's.
It is dropped as another bot's unless its `bot_id` is the bot's own.

With no `operators` and no `escalate_dm`, step 3 never applies, and the listener keeps exactly
what it kept before: every message with a `bot_id` is dropped.

## Owner-only listening

An assistant-style bot answers one person. `streams.slack.listen_to: "operators"` makes the
listener keep only that person's events; `anyone`, the default, keeps everyone's as before.

With `operators`, an event the listener would keep is kept only when its author is an operator:

- its `from` is in `operators`; or
- it is in the `escalate_dm` conversation: a message there, or a reaction on a message there.
  The bot's own events are never items, so anyone else in that DM is the operator, the same rule
  as [Posts through an app](#posts-through-an-app).

An operator's post through an app counts, as it does today. Everything else is dropped: another
person's DM, @mention, kept thread reply or reaction, and every `team_join` (the new member is
its author). A dropped event is not recorded, gets no reaction and wakes nothing, so its sender
gets no signal. It gets one journal line, `dropped non-operator <conv> <user> <kind>`, with
`kind` one of `dm`, `mention`, `reply`, `reaction`, `team_join`. Never the text.

An operator who should be heard in channels is listed in `operators`; `escalate_dm` alone covers
only that DM. A thread begun by a dropped @mention holds no recorded mention, so a later reply in
it without a mention is not kept either.

`listen_to: "operators"` with no `operators` and no `escalate_dm` would drop everything.
`opsbot-slack status` refuses it as `differs` with the fix, and the listener logs the same line
at start and drops every event. A value other than the two is `differs` too, and the listener
treats it as `anyone`.

## The intercept

Some messages are commands for code, not for the session: a DM that starts with a sigil goes to
a capture script, say. `streams.slack.intercept` is a list of rules:

```json
"intercept": [
  { "prefix": "+ ", "command": ["bin/capture", "--from-slack"], "kinds": ["dm"], "timeout_seconds": 30 }
]
```

| Key | Meaning | Default |
| --- | --- | --- |
| `prefix` | a non-empty string the message must start with | required |
| `command` | an argv array, never a shell line. The first entry is a path inside the repo (resolved from the repo root) or an absolute path; a relative path that leaves the repo is refused | required |
| `kinds` | which messages the rule looks at: `dm` (a direct message, threaded or not), `mention` (an `app_mention`), `reply` (a kept channel thread reply) | `["dm"]` |
| `timeout_seconds` | how long the command may run | `30` |

**Matching.** Only a message is ever intercepted: never a reaction or a `team_join`. The text has
its leading whitespace removed; for a `mention`, a leading `<@bot_user>` and the whitespace after
it are removed too. The rule matches when what is left starts with `prefix`, exactly:
case-sensitive, no trimming of the prefix itself, no pattern. The rules are tried in order and
the first match wins. A rule that cannot be used (no prefix, no command, a command outside the
repo, a kind that is not one of the three) never matches; the listener logs it once at start, and
`opsbot-slack status` shows it as `differs`.

**Running.** The command runs from the repo root with the listener's environment plus
`OPSBOT_ROOT`. Its stdin is one JSON object and nothing else:
`{text, conv, ts, thread_ts, user, files}`, where `text` is what follows the prefix, unchanged,
and `files` is the message's files as recorded ([Files](#files)), saved first when
`files.save` is on, else `[]`. Its stdout is ignored. Exit 0 within the timeout is success.

| Outcome | Recorded | Woken | Reaction | Journal |
| --- | --- | --- | --- | --- |
| exit 0 | no | no | `intercept_emoji` | `intercepted <conv> <ts> <user> rule <n>` |
| a non-zero exit, a signal, a timeout, a command that cannot start | yes, as an ordinary item with `intercept: "failed: <why>"` | yes | `intercept_failed_emoji`, then the usual `receipt_emoji` and `ack_emoji` | `intercept failed <conv> <ts> <user> rule <n>: <why>` |

`<why>` is `exit <code>`, `signal <name>`, `timed out after <n> s` or the spawn error's code. It
never holds the command's output, which may echo the text. A failed command loses nothing a person
sent: the message reaches the session like any other, marked with what failed.

No model is called anywhere on this path. The intercept runs after `listen_to`, so with
`operators` only an operator can trigger a command. With `anyone`, anyone who can DM the bot can,
which is why `opsbot-slack status` names who can on the intercept row.

## Files

Slack puts a message's files on its event as file objects. The listener records, for every kept
message that carries them, `files: [{id, name, mimetype, size, file_access?}]`, the fields
Slack gave, whatever the settings. Saving the bytes is opt-in:

```json
"files": { "save": true, "dir": ".scratch/slack-files", "max_bytes": 26214400, "types": ["image/*", "application/pdf", "text/*"] }
```

| Key | Meaning | Default |
| --- | --- | --- |
| `save` | download each allowed file of a kept message | `false` |
| `dir` | where, resolved from the repo root, or absolute | `.scratch/slack-files` |
| `max_bytes` | the largest file saved | `26214400` (25 MiB) |
| `types` | the mimetypes saved: an exact type, or `<major>/*` | `["image/*", "application/pdf", "text/*"]` |

The listener downloads, at record time, before the intercept and before the line is written, so
a command and the session both see the saved paths. It does so through
`slack-axi download <id> --out <tmp>`: slack-axi already holds the bot token and the `files:read`
scope, and fetches `url_private_download` with it. The listener keeps holding only the app-level
token and reads no token store. The reader was the other candidate. It would also have shelled
out to slack-axi, but lazily at each check, which is after the intercept that needs the files.

For each file, in order:

1. Skipped without a download when the event gives no `mimetype` or `size`: a file in a Slack
   Connect conversation arrives as `file_access: "check_file_info"` with neither, and is skipped
   as `"no type or size in the event"`. Skipped when the type is not allowed
   (`"type <mimetype> not allowed"`), or `size` is over `max_bytes`
   (`"<size> bytes, over max_bytes <n>"`).
2. Downloaded into a fresh directory `<dir>/<conv>/<ts>/.incoming-<id>`, with a 60-second
   timeout. `conv` must look like a conversation id and `ts` like a Slack ts, or the file is
   skipped (`"unsafe conversation or ts"`): neither ever names a path.
3. That directory must then hold exactly one regular file (not a link), no larger than
   `max_bytes`. It is moved to `<dir>/<conv>/<ts>/<name>`, where `name` is the event's file name
   made safe: the last path segment only (after `/` and `\`), control characters removed,
   leading dots and whitespace removed, at most 200 characters, the file id when nothing is left.
   A name already taken becomes `<id>-<name>`. The final path is checked, with links resolved,
   to be inside `dir`; otherwise the file is deleted and skipped.
4. Any failure (slack-axi's exit, a timeout, no file, a check above) is `skipped: "<why>"`;
   the temporary directory is removed either way.

A saved file gets `path`, absolute. A skipped one gets `skipped` and no `path`. A message with a
skipped file is still recorded: the session sees what was sent and why it has no bytes. A
download failure logs one journal line with the file id and the reason, never the name.
Downloads delay the receipt reaction by as long as they take, at most a minute a file.

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
4. checks the posting identity (below), then that slack-axi is in bot mode, then posts through
   `slack-axi draft` and `draft send`;
5. appends one line to `post_log`, whatever happened at 2 to 4;
6. prints one JSON object on stdout and exits with its code.

`--dry-run` does 1 to 3 and 5, and posts nothing. `opsbot-slack classify <conv>` does step 2
alone and prints `{conv, class, why, cached}`.

The escalation sink still posts to `escalate_dm` through slack-axi itself. It is the kit's own
path to the operator, it must work while the screen is down, and its destination would be
`operator-dm`, which is never screened.

### Destination classes

Decided in code from Slack's own data, never from the model or the text. The post command reads
the Web API with the token slack-axi will post with, resolved in slack-axi's own order:
`SLACK_AXI_TOKEN` when set, else the store's token for the workspace `team` names, else
slack-axi's default workspace, else its only one. It never prints it.

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

### The posting identity

A bot that runs as a person's Unix user may share a slack-axi store with that person's own
login. slack-axi posts with whichever token it resolves, and `auth mode bot` can be set on a
person's token, so bot mode alone does not prove the post goes out as the bot.

Before posting, when `bot_user` is set, the post command calls `auth.test` with the token above
and compares its `user_id` with `bot_user`. A different user, or an `auth.test` that fails,
refuses the post: exit 5, nothing is sent,
`{posted: false, conv, class, why, screen, error, identity?: {user, name}}`, and a line in
`post_log`. The answer is cached in `slack-classes.json` for `screen.cache_seconds` (default 300)
under the first 16 hex characters of the token's SHA-256, so a changed token is checked again at
once. Only a match is cached. With `bot_user` unset there is no check; `status` already reports
`bot_user` missing. `--dry-run` posts nothing and does not check.

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
| 5 | the token slack-axi would post with is not `bot_user`'s, or `auth.test` failed | no |

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
| `status` | one row each with `ok`, `missing` or `differs` and the fix: the app-level token file (present, mode 600, `xapp-`), slack-axi signed in in bot mode, each of the three scripts present, matching its template and executable, `bot_user` and `escalate_dm` set, the events file in `wake.files`, the unit `opsbot-<bot>-monitor-10-slack-listener.service` active; with `bot_user` set, the posting identity (`auth.test`'s user id and name; `ok` only when it is `bot_user`, else `differs`, or `missing` when no token resolves or `auth.test` fails); with `screen` set, the command executable inside the repo and every policy file present; with `listen_to` set, its value usable (`operators` needs `operators` or `escalate_dm`); with `intercept` set, every rule usable, and who can trigger them; with `files` set, the directory and limits | 0 all ok · 1 something to fix · 2 |
| `post <conv> [--reply <ts>] [--dry-run] [<markdown> \| -]` | [Posting](#posting-opsbot-slack-post) | 0 · 1 · 2 · 3 · 4 · 5 |
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
- A message carrying another `bot_id` is dropped unless an operator wrote it. Why: two bots
  that each answer the other's posts reply to each other forever. An operator's post through
  an app is theirs, though: a bot dropped two replies an operator's assistant posted as the
  operator in a thread the bot was in, while it heard the replies the operator typed, and the
  drop left no trace. So the drop is logged.
- With `listen_to: "operators"` a dropped event gets no reaction at all. Why: a receipt tells
  the sender a session heard them; for a bot that answers one person, that is a promise to
  someone it will never answer. The journal line keeps the drop diagnosable.
- An intercepted message gets its own reaction, never the receipt, and a failed command records
  the message after all. Why: the receipt and its read reaction belong to the session; a person
  must be able to tell "code took it" from "heard, waiting" from "dead", and nothing a person
  sent may vanish because a script broke.
- Files are fetched through slack-axi, never with a token the listener reads. Why: the listener
  holds the app-level token and nothing else; a second copy of the bot token is a second place to
  leak it.
- The post command refuses when its token is not the bot's. Why: a bot running as a person's
  Unix user shares that person's slack-axi store, and a mode flag can say `bot` over a person's
  token; a post in a person's name cannot be taken back.
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
