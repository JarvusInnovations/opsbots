---
name: opsbot-google
description: >-
  Push from Google into an ops bot's loop: a Gmail listener that hears within seconds that mail
  reached the bot's mailbox (through a Gmail watch and a Pub/Sub pull subscription) and appends
  a line with no content to a wake file, a heartbeat that fails while the push is unhealthy, the
  listener's own narrow OAuth grant, an OpenTofu module for the cloud objects, and an install,
  login, ensure and status command. It only listens: the bot's own inbox reader fetches the mail.
  Use when giving a bot instant mail wake-ups, setting up or checking the Gmail push, signing the
  listener in, when mail reaches the bot late or never, when the push heartbeat fails, or when a
  sign-in, watch, pull, history or write problem appears in the wake file. Triggers: "Gmail
  push", "opsbot-google", "gmail watch", "Pub/Sub subscription", "wake on mail",
  "gmail_push", "google-push-token", "sign-in problem".
---

# opsbot-google: push from Google

Two scripts that drop into the bot's `opsbot.d/` (the `opsbot-core` lifecycle directories), one
library they share, and one command that installs, signs in and checks them. This build has the
Gmail source; the Meet source is not yet available (each command says `meet: not yet
available` for `--source meet`).

| Piece | Goes to | Does |
| --- | --- | --- |
| `templates/monitor.d/30-gmail-push` | `opsbot.d/monitor.d/` | always on: keeps the watch, pulls notifications, counts new mail, writes the wake line, runs the backstop |
| `templates/heartbeat.d/15-gmail-push` | `opsbot.d/heartbeat.d/` | every check: no items; fails while the push is unhealthy |
| `templates/infra/` | your infra repo | the four cloud objects, as an OpenTofu module with no defaults |
| `scripts/google-push.mjs` | stays in the skill | the logic: OAuth, Pub/Sub, Gmail, problems; the two templates load it |
| `scripts/opsbot-google` | stays in the skill | `install`, `login`, `ensure`, `status` |

The wake line says that mail arrived and how much, never what. The listener's grant is
`gmail.metadata` and `pubsub`: it cannot read a body. The bot's own inbox reader (another
`heartbeat.d/` script, with its own credential) turns the mail into items.

## Setup, in order

Run as the bot's user, from the bot's repo checkout. The person-facing walk-through is
[README.md](README.md).

1. **The cloud objects.** A topic, Gmail's publisher grant on it, a pull subscription, and the
   subscriber grant for the bot's account: `templates/infra/` (call it from your own root
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

## Commands (`scripts/opsbot-google`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--source gmail\|meet\|both] [--dry-run] [--force]` | copies the source's scripts into `opsbot.d/` (a file that differs is left without `--force`); prints the settings block, the `wake.files` entry and the next commands; never writes `opsbot.json` | 0 · 2 |
| `login --source … --client <file> [--paste]` | the installed-app sign-in with PKCE; asks for exactly `gmail.metadata` and `pubsub`; refuses a partial grant; writes the token file | 0 · 1 · 2 |
| `ensure [--source …] [--dry-run]` | creates or renews the watch now; keeps the cursor | 0 · 1 · 2 |
| `status [--source …]` | one row each, `ok`, `missing` or `differs`, with the fix: the settings; the token file (present, 0600, the scopes); the subscription (answers a pull); the watch and its expiry; the last pull; standing problems; `wake.files` with inputs; each script against its template; the unit. It only reads: a token it refreshes stays in memory, and a message its pull receives is handed straight back | 0 · 1 · 2 |

`--source` defaults to `gmail`.

## When it goes wrong

- **Mail reaches the bot only at its next full check.** `status`. A `wake.files` row that is not
  `ok`, or the listener's unit not active (`journalctl --user -u
  opsbot-<bot>-monitor-30-gmail-push`).
- **A `problem` line, or a failing `15-gmail-push` input.** The heartbeat's reason names the
  kind. `sign-in`: run `login` again. `watch`: the topic or Gmail's publisher grant
  (`templates/infra/README.md`). `pull`: the subscription or the subscriber grant. `history`:
  usually transient. `write`: the disk.
- **A `resync` line.** Google dropped the cursor (it keeps history for about a week, sometimes
  less). The bot's inbox reader should read back further than usual once.

## Test-only environment

`OPSBOT_GOOGLE_AUTH_URL`, `OPSBOT_GOOGLE_TOKEN_URL`, `OPSBOT_GOOGLE_GMAIL_URL` and
`OPSBOT_GOOGLE_PUBSUB_URL` point the endpoints at a stand-in server; `OPSBOT_GOOGLE_BACKOFF_MS`
and `OPSBOT_GOOGLE_SIGNIN_RETRY_MS` shorten the waits; `OPSBOT_GOOGLE_PUSH` names another copy
of the library. Never set them on a running bot.
