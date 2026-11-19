# Wake an ops bot when mail arrives or a meeting transcript is written

For Meet, Google sends the event only for meetings the account organized. A meeting the bot's
account was only invited to produces no event, so the bot never hears of its transcript. Make the
bot's account the organizer of the meetings it should hear about.

This skill makes an ops bot hear, within seconds, that mail reached its Gmail inbox, or that
Google Meet wrote a transcript for one of its meetings. Without it, the bot sees these only at its
next scheduled check. With it, Google tells a small listener, the listener writes one line saying
"mail arrived, this many" or "a transcript was written", and the bot's session wakes and looks.

The two halves are independent: install either or both. Each listener only listens. The Gmail
listener cannot read a message: its permission is to see that mail exists, not what it says. The
Meet listener writes the transcript's resource name and nothing else, and the skill's Meet reader
looks up only when and where the meeting was and where the transcript document is. It never
reads the transcript itself; the bot's own tools, with their own credential, do that.

You need: the bot's repo with `opsbot-core` installed; a shell as the bot's Linux user; Node 22;
and a Google Cloud project you can create Pub/Sub objects and an OAuth client in. For Gmail, an
inbox reader of the bot's own (a `heartbeat.d/` script that turns mail into items). For Meet, a
Google Workspace account (the Meet API's events need one) and its directory id (step 4).

## 1. The cloud objects

Google publishes a notification to a Pub/Sub topic; the listener pulls it from a subscription.
Per source, you need four things in your project:

1. a topic;
2. permission for Google's push service to publish to it (`roles/pubsub.publisher`), for
   Gmail `serviceAccount:gmail-api-push@system.gserviceaccount.com`, for Meet
   `serviceAccount:meet-api-event-push@system.gserviceaccount.com`;
3. a pull subscription on that topic;
4. permission for the bot's Google account to pull from it (`roles/pubsub.subscriber` for
   `user:<the bot's address>`).

`templates/infra/gmail/` and `templates/infra/meet/` are OpenTofu modules that make exactly
these, with every name a required input; call the one you need from your own infrastructure
code. `templates/infra/README.md` gives the same lists for making them by hand. If your
organization restricts sharing to its own domain, the publisher grant needs an exception for
Google's account. For Meet, the topic must be in the project that owns the OAuth client (step 2).

## 2. The OAuth client

In the Google Cloud console, under APIs and services, enable the **Cloud Pub/Sub API**, plus the
**Gmail API** for Gmail, or the **Google Meet REST API** and the **Google Workspace Events API**
for Meet. Then create an OAuth client of type **Desktop app** and download its JSON. Keep it
outside the bot's repo. If the consent screen is in testing, add the bot's account as a test
user.

## 3. Install the scripts

From the bot's repo, with `--source gmail` (the default), `meet` or `both`:

```sh
.agents/skills/opsbot-google/scripts/opsbot-google install --source both
```

It copies the source's two scripts into `opsbot.d/` and prints the blocks for `opsbot.json`. It
never edits `opsbot.json` itself: merge them, fill in your account and the names from step 1,
and for Gmail replace the inbox-reader placeholder with the name of the bot's own mail input:

```json
"streams": {
  "gmail_push": {
    "enabled": true,
    "account": "bot@example.com",
    "project": "example-project",
    "topic": "example-gmail-topic",
    "subscription": "example-gmail-sub"
  },
  "meet_push": {
    "enabled": true,
    "account": "bot@example.com",
    "user_id": "100000000000000000001",
    "project": "example-project",
    "topic": "example-meet-topic",
    "subscription": "example-meet-sub"
  }
},
"wake": { "files": [
  { "file": "~/.cache/examplebot/gmail-push.jsonl", "inputs": ["15-gmail-push", "20-mail"] },
  { "file": "~/.cache/examplebot/meet-push.jsonl", "inputs": ["25-meet-transcripts"] }
] }
```

Commit the change.

## 4. Meet: the account's directory id

The Meet listener subscribes to events for one Google Workspace user, named by its directory id
(a long number), not its address. The skill does not look it up for you. A Workspace admin can
read it:

- with the Admin SDK Directory API, `users.get` with `fields=id`:
  `GET https://admin.googleapis.com/admin/directory/v1/users/bot@example.com?fields=id`
  (the API Explorer on that method's reference page runs it from a browser); or
- in the Admin console, on the user's page: the page's address ends in the id.

Put it in `streams.meet_push.user_id`. `opsbot-google status --source meet` shows the same
instructions while it is missing.

## 5. Sign the listener in

```sh
.agents/skills/opsbot-google/scripts/opsbot-google login --source both --client ~/client.json
```

Open the printed address in a browser signed in as the bot's account, and allow every
permission. On a machine with no browser, add `--paste`, open the address on any computer, and
when the browser fails to load a `127.0.0.1` page, copy that page's address and paste it into
the terminal.

The grant is saved in `~/.config/<bot>/google-push-token.json`, readable only by the bot's user.
It is the listeners' own, separate from any other tool's sign-in. Both sources share the file by
default, so sign in for both at once (`--source both`); `login` refuses a one-source sign-in that
would drop the other, enabled source's permissions.

## 6. Start it

```sh
.agents/skills/opsbot-google/scripts/opsbot-google ensure --source both
.agents/skills/opsbot-core/scripts/opsbot-core infra install
.agents/skills/opsbot-google/scripts/opsbot-google status --source both
```

Fix each row that is not `ok`; each prints its fix. Then send the bot an email, or hold a short
meeting the bot's account organized with transcription on: the session wakes within seconds of
the mail, or of Google writing the transcript (usually some minutes after the meeting ends).

## When something is wrong

The listeners' logs are `journalctl --user -u opsbot-<bot>-monitor-30-gmail-push` and
`…-35-meet-transcripts`. When something fails for more than five minutes, the listener writes one
`problem` line and the bot's check reports the `15-gmail-push` or `25-meet-transcripts` input as
failed until it recovers, so a dead push never looks like a quiet inbox or a quiet calendar. A
`sign-in` problem is reported at once: run `login` again.

No Meet event for a meeting? Check first that the bot's account organized it.

To take the grant back, remove the app's access in the bot's Google account security settings and
delete the token file.
