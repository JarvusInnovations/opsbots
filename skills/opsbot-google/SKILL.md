---
name: opsbot-google
description: >-
  Push from Google into an ops bot's loop: a Gmail listener that hears within seconds that mail
  reached the bot's mailbox (through a Gmail watch and a Pub/Sub pull subscription) and appends
  a line with no content to a wake file, and a Meet listener that hears that a transcript was
  written for a meeting the bot's account organized (through a Workspace Events subscription),
  with a reader that turns each into a check item with the meeting's times, code and document,
  never its text. Also heartbeats that fail while a push is unhealthy, the listeners' own narrow
  OAuth grant, OpenTofu modules for the cloud objects, and an install, login, ensure and status
  command. It only listens. Use when giving a bot instant mail or transcript wake-ups, setting up
  or checking either push, signing the listener in, when mail or a transcript reaches the bot
  late or never, when a push heartbeat fails, or when a sign-in, watch, pull, history or write
  problem appears in a wake file. Triggers: "Gmail push", "Meet transcripts", "opsbot-google",
  "gmail watch", "Workspace Events", "Pub/Sub subscription", "wake on mail", "gmail_push",
  "meet_push", "google-push-token", "sign-in problem".
---

# opsbot-google: push from Google

Two sources, each two scripts that drop into the bot's `opsbot.d/` (the `opsbot-core` lifecycle
directories), one library they share, and one command that installs, signs in and checks them.
A bot installs either source or both (`--source gmail|meet|both`; `gmail` by default).

**Meet: Google sends the transcript event only for meetings the account organized.** A meeting
the account was only invited to produces nothing.

| Piece | Goes to | Does |
| --- | --- | --- |
| `templates/monitor.d/30-gmail-push` | `opsbot.d/monitor.d/` | always on: keeps the watch, pulls notifications, counts new mail, writes the wake line, runs the backstop |
| `templates/heartbeat.d/15-gmail-push` | `opsbot.d/heartbeat.d/` | every check: no items; fails while the push is unhealthy |
| `templates/monitor.d/35-meet-transcripts` | `opsbot.d/monitor.d/` | always on: keeps the Workspace Events subscription, pulls its events, writes a line per transcript or lifecycle event, runs the backstop |
| `templates/heartbeat.d/25-meet-transcripts` | `opsbot.d/heartbeat.d/` | every check: one item per transcript, resolved through the Meet API; fails while the Meet push is unhealthy |
| `templates/infra/gmail/`, `templates/infra/meet/` | your infra repo | each source's four cloud objects, as an OpenTofu module with no defaults |
| `scripts/google-push.mjs` | stays in the skill | the logic: OAuth, Pub/Sub, Gmail, Workspace Events, Meet, problems; the templates load it |
| `scripts/opsbot-google` | stays in the skill | `install`, `login`, `ensure`, `status` |

The wake line says that mail arrived and how much, never what. The Gmail grant is
`gmail.metadata` and `pubsub`: it cannot read a body. The bot's own inbox reader (another
`heartbeat.d/` script, with its own credential) turns the mail into items. The Meet grant is
`meetings.space.readonly` and `pubsub`; the Meet line names the transcript resource only, and the
skill's reader looks up its meeting's times, code and document, never the transcript's text.

## Setup, in order

Run as the bot's user, from the bot's repo checkout. The person-facing walk-through is
[README.md](README.md).

1. **The cloud objects.** A topic, Gmail's publisher grant on it, a pull subscription, and the
   subscriber grant for the bot's account: `templates/infra/gmail/` (call it from your own root
   module), or its README's list by hand.
2. **The OAuth client.** A *Desktop app* client in a project with the Gmail and Pub/Sub APIs
   enabled; download its JSON. It is read once by `login` and never copied into the repo.
3. **The scripts.** `scripts/opsbot-google install`. It copies the two scripts and prints the
   `streams.gmail_push` block and the `wake.files` entry in its object form,
   `{ "file": "~/.cache/<bot>/gmail-push.jsonl", "inputs": ["15-gmail-push", "<the bot's inbox reader>"] }`,
   so a wake from it runs a fast check of those inputs. Merge both into `opsbot.json` and commit.
   `install` never writes `opsbot.json`.
4. **Sign in.** `scripts/opsbot-google login --source gmail --client <client.json>` prints the
   consent URL; open it signed in as the bot's account. It waits on a `127.0.0.1` port for the
   redirect. On a headless host add `--paste`: the browser then fails to load a `127.0.0.1` page,
   and you paste that page's address. The grant goes to `token_file`, 0600.
5. **The watch.** `scripts/opsbot-google ensure` creates it now (the listener also does at start).
6. **The unit.** `opsbot-core infra install` renders the listener as the user service
   `opsbot-<bot>-monitor-30-gmail-push`.
7. **Check.** `scripts/opsbot-google status` until every row is `ok`. Then send the bot mail.

For Meet the same steps take `--source meet` (or `both`), with these differences: the topic's
publisher is `meet-api-event-push@system.gserviceaccount.com` and the topic lives in the OAuth
client's project (`templates/infra/meet/`); the client's project enables the Google Meet REST API
and the Google Workspace Events API; `streams.meet_push.user_id` is the account's directory id,
which an admin reads with the Admin SDK Directory API (`users.get` with `fields=id`) or from the
user's page in the Admin console (the skill never calls the Admin SDK; `status` repeats this
while it is missing); `ensure --source meet` makes the Workspace Events subscription; the
`wake.files` entry is `{ "file": "~/.cache/<bot>/meet-push.jsonl", "inputs": ["25-meet-transcripts"] }`.
Both sources share the token file by default: sign in with `--source both` (a one-source sign-in
that would drop an enabled source's scopes from the shared file is refused).

## Settings (`streams.gmail_push`)

| Key | Meaning | Default |
| --- | --- | --- |
| `enabled` | the listener and its heartbeat do nothing unless `true` | `false` |
| `account` | the Google account the grant is for, the mailbox watched | required |
| `project`, `topic`, `subscription` | the Pub/Sub objects (short names, or full `projects/…` paths) | required |
| `labels` | the labels watched and counted | `["INBOX"]` |
| `token_file` | the listener's own grant | `~/.config/<bot>/google-push-token.json` |
| `wake_file` | the wake file; must be in `wake.files` with its inputs | `~/.cache/<bot>/gmail-push.jsonl` |
| `state_file` | watch expiry, history cursor, standing problems, last pull | `~/.cache/<bot>/gmail-push-state.json` |
| `wake_grace_seconds` | how long the session's own monitor gets before the backstop nudges | `20` |
| `problem_after_minutes` | how long a failure lasts before it is raised | `5` |
| `stale_minutes` | no pull for this long fails the heartbeat | `15` |
| `renew_hours` | how often the watch is renewed | `24` |
| `renew_before_hours` | renew when this close to the watch's expiry | `24` |

## Settings (`streams.meet_push`)

`enabled`, `account`, `project`, `topic`, `subscription`, `token_file`, `wake_grace_seconds`,
`problem_after_minutes` and `stale_minutes` as for Gmail; `wake_file` defaults to
`~/.cache/<bot>/meet-push.jsonl`, `state_file` to `~/.cache/<bot>/meet-push-state.json`. Then:

| Key | Meaning | Default |
| --- | --- | --- |
| `user_id` | the account's Workspace directory id; the subscription's target is `//cloudidentity.googleapis.com/users/<user_id>` | required |
| `renew_hours` | how often the subscription is extended | `6` |
| `lookback_minutes` | extra window the reader reads before `$OPSBOT_SINCE` | `30` |
| `enrich` | a repo path to an executable that adds keys to each item (below) | unset |

No default names a project, an address or a zone. A missing required key makes the listener
refuse to start (it names the key) and `status` show it `missing`. Every file is created 0600 in
a 0700 directory.

## What each piece does

**The listener** (`monitor.d/30-gmail-push`):

1. **Watch.** `users.watch` on `topic` with `labels` (`labelFilterBehavior: include`), at
   start and whenever due: none on record, `renew_hours` since the last, or within
   `renew_before_hours` of its expiry. A renewal keeps the history cursor. The first watch's
   history id is the cursor's start, written as a `baseline` line.
2. **Pull**, long-polling the subscription (50 at a time). Each notification is
   `{emailAddress, historyId}`. For a batch it reads the mailbox history since its cursor
   (`history.list`, `messageAdded` only, paged) and counts messages newly added with one of
   `labels` and neither `SENT` nor `DRAFT`; a record without labels is looked up with
   `messages.get?format=minimal`, and one gone since is skipped. Reads, archives and label
   changes count nothing and write nothing.
3. **One line per batch that counted something**:
   `{"key": "gmail:<account>:<history id>", "type": "inbox", "account": …, "count": 2, "recorded_at": …}`.
   The history id is that of the newest record that counted, so a redelivered batch writes the
   same key. A first run writes `type: "baseline"`; a cursor Google no longer has (a 404) is
   restarted from the newest notification as `type: "resync"`, which fails the heartbeat once.
4. **Then** the state is written (temporary file, rename), **then** the batch is acknowledged. A
   crash before the acknowledgement redelivers, and the key makes the line harmless twice.
5. **Then the backstop**: `opsbot-core wake backstop --key <key> --at <time> --grace
   <wake_grace_seconds> --reason gmail`, detached, one at a time, for `inbox` and `resync`
   lines. The listener logs its notes and its one line.

It refreshes the access token itself and rewrites the token file in place, 0600. It never
prints a token. It retries with backoff from 5 seconds, doubling to 5 minutes.

**Problems, once each.** A failure is counted by kind: `sign-in` (no token file, a missing
scope, a revoked grant, a 401, a 403 naming a scope), `watch`, `pull`, `history`, `write`. When a
kind has failed for `problem_after_minutes`, or at once for `sign-in`, the listener appends
`{"key": "gmail:problem:<kind>:<since>", "type": "problem", "kind": …, "recorded_at": …}` once and
keeps the detail in the state file. The next success of that kind clears it; a standing problem
survives a restart. On `sign-in` it waits 30 minutes between tries; the fix is `login`. A failed
write of the wake or state file is `write`, held in memory: the listener does not exit and does
not acknowledge what it could not record.

**The heartbeat** (`heartbeat.d/15-gmail-push`) prints no items. It reads the state file only and
exits 1, one reason per line, when there is no state, a problem stands, the watch is missing or
lapsed, the last pull is older than `stale_minutes`, or a resync happened since the watermark (the
reader should look back further). The same under `OPSBOT_PEEK=1`: it writes nothing and calls
nothing.

**The Meet listener** (`monitor.d/35-meet-transcripts`):

1. **Subscription.** `ensure` lists the Workspace Events subscriptions for the transcript event
   (`google.workspace.meet.transcript.v2.fileGenerated`) on the account's user resource, and
   takes the one whose endpoint is `topic`. None: it creates one (`payloadOptions.includeResource:
   false`, so an event carries the transcript's name only). `SUSPENDED`: it reactivates it.
   Otherwise it extends it to the maximum lifetime (`PATCH ?updateMask=ttl`, `ttl: "0s"`; seven
   days for an event without resource data). A subscription delivering to another topic is never
   touched. It runs at start, every `renew_hours`, and after any lifecycle event.
2. **One line per event**: `{"key": "meet:transcript:<transcript name>", "type": "transcript",
   "account": …, "transcript": "conferenceRecords/…/transcripts/…", "recorded_at": …}`, or for a
   lifecycle event (`expirationReminder`, `expired`, `suspended`) `{"key":
   "meet:lifecycle:<event>:<event id>", "type": "lifecycle", "event": …, "expire_time"?: …,
   "recorded_at": …}`. A suspension's reason goes to the journal, not the line. Other event
   types are acknowledged and not recorded.
3. **Then** the state, **then** the acknowledgement, **then** the backstop
   (`--reason meet`) for a transcript.

Problems as for Gmail (`meet:problem:<kind>:<since>`); a failing subscription call is the
`watch` kind.

**The Meet reader** (`heartbeat.d/25-meet-transcripts`) prints one item per transcript line
recorded since `$OPSBOT_SINCE` less `lookback_minutes` (a key seen twice is one item):

```json
{"key": "meet:transcript:conferenceRecords/c1/transcripts/t1", "at": "<recorded_at>",
 "conv": "meet:<account>", "kind": "group", "from": "google-meet",
 "text": "A Meet transcript was written for the meeting abc-defg-hij that started … and ended ….",
 "transcript": "conferenceRecords/c1/transcripts/t1", "conference": "conferenceRecords/c1",
 "start": "…", "end": "…", "meeting_code": "abc-defg-hij",
 "doc": {"id": "<Docs document id>", "url": "<the document's export address>"}}
```

It resolves each through the Meet REST API with the skill's grant: `transcripts.get` (the
document), `conferenceRecords.get` (start, end, space), `spaces.get` (the meeting code). It
never reads transcript entries or the document: `doc.url` is where the bot's own tools fetch
the text. Lookups are cached beside the state file (`meet-push-cache.json`, 0600, metadata only,
kept for the lines still in the window). A failed lookup still prints the item, unresolved, and
fails the input. A lifecycle `expired` or `suspended` line is an item too (`event`,
`expire_time`); a reminder is not. Under `OPSBOT_PEEK=1` it makes no Google call, runs no hook
and neither reads nor writes the cache: one unresolved item per line (`transcript` and
`conference` only). After the items it exits 1, one reason per line, when a lookup or the hook
failed, or for the Meet push's health: no state; a problem stands; no subscription, or one not
`ACTIVE` or lapsed; no pull within `stale_minutes`.

**`enrich`** names an executable inside the bot's repo; a path outside it is refused (the input
fails). The reader runs it once per transcript item, from the repo root, with the item as JSON
on stdin. It prints one JSON object; each key is added to the item unless the item has it
(`{"title": …, "attendees": […]}` from the bot's calendar). A non-zero exit or output that is
not a JSON object fails the input after every item is printed. This is where a bot's knowledge
of its meetings goes, never into the kit.

## Commands (`scripts/opsbot-google`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--source gmail\|meet\|both] [--dry-run] [--force]` | copies the source's scripts into `opsbot.d/` (a file that differs is left without `--force`); prints the settings block, the `wake.files` entry and the next commands; never writes `opsbot.json` | 0 · 2 |
| `login --source … --client <file> [--paste]` | the installed-app sign-in with PKCE; asks for exactly `gmail.metadata` and `pubsub` (Gmail), `meetings.space.readonly` and `pubsub` (Meet), or their union (`both`); refuses a partial grant, and a one-source grant that would drop an enabled source from a shared token file; writes the token file | 0 · 1 · 2 |
| `ensure [--source …] [--dry-run]` | creates or renews the Gmail watch now, keeping the cursor; creates, reactivates or extends the Meet subscription | 0 · 1 · 2 |
| `status [--source …]` | one row each, `ok`, `missing` or `differs`, with the fix: the settings; the token file (present, 0600, the scopes); the subscription (answers a pull); the watch and its expiry; the last pull; standing problems; `wake.files` with inputs; each script against its template; the unit. For Meet the same rows, prefixed `meet`, with `meet events` (the Workspace Events subscription: on record, `ACTIVE`, not lapsed) in place of the watch, and a missing `user_id` row that says how to find it It only reads: a token it refreshes stays in memory, and a message its pull receives is handed straight back | 0 · 1 · 2 |

`--source` defaults to `gmail`.

## When it goes wrong

- **Mail reaches the bot only at its next full check.** `status`. A `wake.files` row that is not
  `ok`, or the listener's unit not active (`journalctl --user -u
  opsbot-<bot>-monitor-30-gmail-push`).
- **A `problem` line, or a failing `15-gmail-push` input.** The heartbeat's reason names the
  kind. `sign-in`: run `login` again. `watch`: the topic or Gmail's publisher grant
  (`templates/infra/README.md`). `pull`: the subscription or the subscriber grant. `history`:
  usually transient. `write`: the disk.
- **A transcript never arrives.** The account must have organized the meeting. Then `status
  --source meet`: `meet events` not `ok` (a `suspended` item names the cause in the journal: a
  revoked grant, or a lost publisher grant on the topic), or the Meet listener's unit.
- **A `resync` line.** Google dropped the cursor (it keeps history for about a week, sometimes
  less). The bot's inbox reader should read back further than usual once.

## Test-only environment

`OPSBOT_GOOGLE_AUTH_URL`, `OPSBOT_GOOGLE_TOKEN_URL`, `OPSBOT_GOOGLE_GMAIL_URL`,
`OPSBOT_GOOGLE_PUBSUB_URL`, `OPSBOT_GOOGLE_EVENTS_URL` and `OPSBOT_GOOGLE_MEET_URL` point the endpoints at a stand-in server; `OPSBOT_GOOGLE_BACKOFF_MS`
and `OPSBOT_GOOGLE_SIGNIN_RETRY_MS` shorten the waits; `OPSBOT_GOOGLE_PUSH` names another copy
of the library. Never set them on a running bot.
