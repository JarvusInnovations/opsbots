# Skill: opsbot-google

Push from Google into the loop: a listener that hears, within seconds, that mail reached a
mailbox's inbox, and one that hears that a Meet transcript was written. Each appends a line
with no content to a wake file; the bot's own reader then fetches what arrived. It is the third
channel skill (`opsbot-<channel>` in [architecture](../architecture.md#the-composition)), and the
first that only listens: it sends nothing.

The two listeners are independent. A bot installs either or both.

## Installs

```
skills/opsbot-google/
  SKILL.md, README.md                       setup in order; for a person: the cloud objects, the sign-in
  scripts/opsbot-google                     bash: install, status, login, ensure
  scripts/google-push.mjs                   node 22, no dependencies: OAuth, Pub/Sub pull, the two sources
  templates/monitor.d/30-gmail-push         the Gmail listener
  templates/monitor.d/35-meet-transcripts   the Meet listener
  templates/heartbeat.d/15-gmail-push       health of the Gmail push; prints no items
  templates/heartbeat.d/25-meet-transcripts items for transcripts, and the Meet push's health
  templates/infra/gmail/, infra/meet/       an OpenTofu module per source for the cloud objects, no defaults
```

Outside the repo, on the bot's user, all created mode 0600 in 0700 directories:

| Path | What |
| --- | --- |
| `~/.config/<bot>/google-push-token.json` (`token_file`) | the listener's own OAuth grant: `{client_id, client_secret, refresh_token, access_token, expires_at, scope}` |
| `~/.cache/<bot>/gmail-push.jsonl`, `meet-push.jsonl` (`wake_file`) | the wake files; each must be in `wake.files` with its `inputs` |
| `~/.cache/<bot>/gmail-push-state.json`, `meet-push-state.json` | watch or subscription expiry, the history cursor, standing problems, last pull |

## Settings (`streams.gmail_push`, `streams.meet_push` in `opsbot.json`)

Common to both:

| Key | Meaning | Default |
| --- | --- | --- |
| `enabled` | the listener and its heartbeat do nothing unless `true` | `false` |
| `account` | the Google account the grant is for | required |
| `project`, `topic`, `subscription` | the Pub/Sub objects | required; no defaults |
| `token_file`, `wake_file`, `state_file` | paths | as above |
| `wake_grace_seconds` | how long the session's monitor gets before the backstop nudge | `20` |
| `problem_after_minutes` | how long a failure may last before it is raised | `5` |
| `stale_minutes` | no successful pull for this long is a failed input | `15` |

`gmail_push` adds `labels` (default `["INBOX"]`), `renew_hours` (24) and
`renew_before_hours` (24). `meet_push` adds `user_id` (the account's directory id, required;
`status` prints how to find it), `renew_hours` (6), `lookback_minutes` (30) and `enrich` (a
repo path to an executable; below).

Nothing is hard-coded: a missing required key makes the listener refuse to start and `status`
show `missing` with the key.

## The credential

The skill holds its own grant, in its own file, with only the scopes it needs. It never reads
another tool's token store.

- **`opsbot-google login --source gmail|meet|both`** runs Google's installed-app flow for an
  OAuth client the operator created (Desktop app; the client's JSON path is given with
  `--client <file>` and is read once, never copied into the repo). It prints the consent URL,
  listens on a loopback port for the redirect, or takes the pasted redirect URL with
  `--paste` on a headless host, and writes the token file. It asks for exactly:
  `gmail.metadata` and `pubsub` for Gmail; `meetings.space.readonly` and `pubsub` for Meet.
  Both sources share one token file by default, and a sign-in for one source that would drop
  an enabled source's scopes is refused.
- The listener refreshes the access token itself and rewrites the file in place. A missing
  file, a missing scope or a revoked grant is one problem (`sign-in`), raised at once, with the
  `login` command as its fix; the listener then sleeps 30 minutes between tries.
- `gmail.metadata` cannot read a message's body. That is the point: this listener can tell
  that mail arrived and nothing else.

## The cloud objects

Per source: a topic, the publisher grant Google's push service needs on it, a pull
subscription, and the subscriber grant for `account`. `templates/infra/` is a module with those
four per source, every name and id a required variable, and no project, organization, billing
or state configuration: the adopting repo calls it from its own root module. The README gives
the same objects as a short list for an operator who makes them by hand.

`opsbot-google status` checks they exist and are usable by pulling one message without
waiting and handing it straight back, since Pub/Sub has no empty pull; it never creates or
changes one.

## The Gmail listener

1. **Watch.** `users.watch` on `topic` with `labels`, at start and then whenever due: no watch on
   record, `renew_hours` since the last, or within `renew_before_hours` of expiry. A renewal
   keeps the stored history cursor.
2. **Pull**, long-polling the subscription. For each batch it reads the mailbox history since
   its cursor and counts messages newly added with one of `labels` and neither `SENT` nor
   `DRAFT`. Reads, archives and label changes, which Gmail also notifies, count nothing.
3. **One line per batch that counted something**, appended to the wake file:
   `{key: "gmail:<account>:<history id>", type: "inbox", account, count, recorded_at}`. Never a
   sender, a subject, a snippet, a thread or a message id. A first run writes `type: "baseline"`,
   and a cursor Google no longer has is resynchronized with `type: "resync"`, which fails the
   heartbeat once so the bot's reader looks back further.
4. **Then** state is written (temporary file, then rename), **then** the batch is acknowledged.
   A crash before the acknowledgement redelivers; the key makes the line harmless twice.
5. **Then the backstop**: `opsbot-core wake backstop` (below), once per pending wake.

## The Meet listener

1. **Subscription.** A Workspace Events subscription on the account's user resource for the
   transcript-written event, delivered to `topic`, without the resource's content. `ensure` finds
   its own subscription by target and endpoint and creates, reactivates or extends it; it runs at
   start, every `renew_hours`, and on any lifecycle event.
2. **One line per event**: `{key: "meet:transcript:<transcript name>", type: "transcript",
   account, transcript, recorded_at}` or `{key, type: "lifecycle", event, expire_time?,
   recorded_at}`. Lines are written, then acknowledged, then the backstop for a transcript.
3. **What it hears.** Google delivers this event for meetings the account **organized**. A
   meeting it was only invited to produced none on an adopting bot, though Google's guide can
   be read as allowing it; the README says "organized only" first, until a real run shows
   otherwise.

**`heartbeat.d/25-meet-transcripts`** turns each transcript line since `OPSBOT_SINCE` less
`lookback_minutes` into an item: `{key, at, conv: "meet:<account>", kind: "group", from:
"google-meet", text, transcript, conference, start, end, meeting_code, doc: {id, url}}`,
resolved through the Meet API with the skill's own grant. Meet gives no meeting title; a
title is for `enrich` to add. It never reads the
transcript's text. `enrich`, when set, is run once per item with the item as JSON on stdin and
may add keys (a calendar title, attendees), like the Slack skill's sender hook. A lifecycle
`expired` or `suspended` is an item; a reminder is not. Under `OPSBOT_PEEK=1` it makes no
Google call and writes no cache: it prints one unresolved item per line.

## Problems, once each

A failure is counted by kind (`sign-in`, `watch`, `pull`, `history`, `write`). When a kind has
failed for `problem_after_minutes`, or at once for `sign-in`, the listener appends
`{key: "<source>:problem:<kind>:<since>", type: "problem", kind, recorded_at}` to the wake
file, once, and records the detail in the state file. The next success clears it. The standing
problem survives a restart. An error's message never goes in the wake file: it can name a path.

A failed write of the state or wake file (a full disk) is the `write` problem, held in memory
and retried; the listener does not exit, and it does not acknowledge what it could not record.

**`heartbeat.d/15-gmail-push`** prints no items. It exits 1 with the reasons when: there is no
state; a problem stands; the watch is missing or lapsed; the last pull is older than
`stale_minutes`; or a resync happened since the watermark. The Meet reader fails the same way
for its source. Both read state only and are safe under a peek.

## The backstop, in the core

Listeners do not carry their own copy of the wake logic. `opsbot-core wake backstop --key <key>
--at <ISO time> [--grace <seconds>] --reason <text>` is the kit's one implementation
([opsbot-core](opsbot-core.md#the-live-wake)): it waits `grace` for a check begun after the
event or for the key to be seen, waits out a cycle already running, nudges at once when the
bot is asleep, and then nudges until the outcome is `woke` or `cooldown`, a newer check begins,
or 30 minutes pass. It prints one line saying which happened and exits 0. A listener runs it
detached, at most one at a time, and logs its line. The Slack and WhatsApp listeners move to
it too.

## Commands (`scripts/opsbot-google`)

| Command | Does | Exit |
| --- | --- | --- |
| `install [--source gmail\|meet\|both] [--dry-run] [--force]` | copies that source's scripts into `opsbot.d/`; prints the settings block, the `wake.files` entries in `{file, inputs}` form (the Gmail entry naming `15-gmail-push` and a placeholder for the bot's own inbox reader), and the next commands. Never writes `opsbot.json` | 0 · 2 |
| `login --source … --client <file> [--paste]` | [The credential](#the-credential) | 0 · 1 · 2 |
| `ensure [--source …] [--dry-run]` | creates or renews the watch and the subscription now | 0 · 1 |
| `status` | one row each, `ok`, `missing` or `differs` with the fix: settings complete; token file present, 0600, with the scopes; the Pub/Sub objects reachable; the watch or subscription and its expiry; last pull; standing problems; each script matching its template; the units active; each wake file in `wake.files` with inputs | 0 · 1 |

## Rules

- The wake file says that something arrived and how much, never what. Why: it is read by a
  monitor that prints its lines into the session; a subject line there is mail read by a path
  with no reader's care, and no screen.
- The listener's grant cannot read mail bodies or transcript text. Why: the piece that runs all
  day should hold the least.
- Its own token file, its own scopes, never another tool's store. Why: a second reader of a
  credential is a second place it leaks, and a tool's store changes shape without notice.
- Recorded, then acknowledged. Why: an acknowledged notification that never reached the file is
  mail the bot never hears about.
- A problem is one line, once, and a heartbeat that fails until it clears. Why: a dead push
  looks exactly like a quiet inbox.
- No default names a project, an address or a zone. Why: the listeners this came from carried
  their first bot's in every fallback.
- `install` prints settings and never writes them.

## Principles

**Inherited** from [principles](../principles.md): a failed check is said out loud; a guard in
code beats a rule in prose; the schedule is not the bot's to keep (the backstop); nothing here
is public; own identity (the bot's own grant).
