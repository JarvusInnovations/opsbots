# Wake an ops bot when mail arrives

This skill makes an ops bot hear, within seconds, that mail reached its Gmail inbox. Without
it, the bot sees new mail only at its next scheduled check. With it, Gmail tells a small
listener, the listener writes one line saying "mail arrived, this many", and the bot's session
wakes and reads its inbox the way it always does.

The listener only listens. It cannot read a message: its permission is to see that mail exists,
not what it says. The bot's own inbox reader, with its own credential, fetches the mail.

You need: the bot's repo with `opsbot-core` installed and an inbox reader of its own (a
`heartbeat.d/` script that turns mail into items); a shell as the bot's Linux user; Node 22;
and a Google Cloud project you can create Pub/Sub objects and an OAuth client in.

The Meet half of this skill (hearing that a meeting transcript was written) is not in this
build yet.

## 1. The cloud objects

Gmail publishes a notification to a Pub/Sub topic; the listener pulls it from a subscription.
You need four things in your project:

1. a topic;
2. permission for Gmail's push service to publish to it
   (`roles/pubsub.publisher` for `serviceAccount:gmail-api-push@system.gserviceaccount.com`);
3. a pull subscription on that topic;
4. permission for the bot's Google account to pull from it (`roles/pubsub.subscriber` for
   `user:<the bot's address>`).

`templates/infra/` is an OpenTofu module that makes exactly these, with every name a required
input; call it from your own infrastructure code. Its README gives the same list for making them
by hand. If your organization restricts sharing to its own domain, the publisher grant needs an
exception for Gmail's account.

## 2. The OAuth client

In the Google Cloud console, under APIs and services, enable the **Gmail API** and the **Cloud
Pub/Sub API**, then create an OAuth client of type **Desktop app** and download its JSON. Keep it
outside the bot's repo. If the consent screen is in testing, add the bot's account as a test
user.

## 3. Install the scripts

From the bot's repo:

```sh
.agents/skills/opsbot-google/scripts/opsbot-google install
```

It copies two scripts into `opsbot.d/` and prints two blocks for `opsbot.json`. It never edits
`opsbot.json` itself: merge them, fill in your account and the three names from step 1, and
replace the inbox-reader placeholder with the name of the bot's own mail input:

```json
"streams": {
  "gmail_push": {
    "enabled": true,
    "account": "bot@example.com",
    "project": "example-project",
    "topic": "example-gmail-topic",
    "subscription": "example-gmail-sub"
  }
},
"wake": { "files": [{ "file": "~/.cache/examplebot/gmail-push.jsonl", "inputs": ["15-gmail-push", "20-mail"] }] }
```

Commit the change.

## 4. Sign the listener in

```sh
.agents/skills/opsbot-google/scripts/opsbot-google login --source gmail --client ~/client.json
```

Open the printed address in a browser signed in as the bot's account, and allow both
permissions. On a machine with no browser, add `--paste`, open the address on any computer, and
when the browser fails to load a `127.0.0.1` page, copy that page's address and paste it into
the terminal.

The grant is saved in `~/.config/<bot>/google-push-token.json`, readable only by the bot's user.
It is the listener's own, separate from any other tool's sign-in.

## 5. Start it

```sh
.agents/skills/opsbot-google/scripts/opsbot-google ensure
.agents/skills/opsbot-core/scripts/opsbot-core infra install
.agents/skills/opsbot-google/scripts/opsbot-google status
```

Fix each row that is not `ok`; each prints its fix. Then send the bot an email: the session wakes
within seconds.

## When something is wrong

The listener's log is `journalctl --user -u opsbot-<bot>-monitor-30-gmail-push`. When something
fails for more than five minutes, the listener writes one `problem` line and the bot's check
reports the `15-gmail-push` input as failed until it recovers, so a dead push never looks like a
quiet inbox. A `sign-in` problem is reported at once: run `login` again.

To take the grant back, remove the app's access in the bot's Google account security settings and
delete the token file.
