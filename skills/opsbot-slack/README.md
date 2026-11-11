# Give an ops bot its own Slack app

This skill puts an ops bot in a Slack workspace as its own bot user. People DM it or
@mention it; it reacts within seconds so they know it heard, and it answers in the thread
they asked in. It can also DM its operator when its loop stops.

You need: a Slack workspace where you can create and install apps (a workspace admin, or
someone an admin lets install apps), the bot's repo with `opsbot-core` installed, and a shell
as the bot's Linux user.

## 1. Create the app

1. Copy [`templates/manifest.yaml`](templates/manifest.yaml) into the bot's repo, for example
   as `slack/manifest.yaml`. Replace the placeholders in angle brackets: the bot's name, one
   line on what it does, and who is responsible for it. Commit it.
2. Open <https://api.slack.com/apps?new_app=1>, choose **From a manifest**, pick the
   workspace, paste the file, and create the app.
3. On the app's **Install App** page, install it to the workspace and approve the scopes.
4. Optional: upload an icon on **Basic Information**.

## 2. The two tokens, and where each goes

The app has two tokens. Neither goes in the repo, in Slack, in a chat, or in an issue. Do
these steps in the bot's own shell (`sudo -u <bot> -i`), so the files belong to the bot.

**The bot token** (`xoxb-…`) is how the bot reads and posts. Copy the **Bot User OAuth Token**
from **Install App**, then:

```sh
slack-axi auth login --token xoxb-...
slack-axi doctor          # the token works and has its scopes
```

slack-axi keeps it in its own store, readable only by the bot's user. A bot token puts
slack-axi in bot mode, so every message goes out as the bot.

**The app-level token** (`xapp-…`) is how the listener hears events without a public URL. On
**Basic Information**, under **App-Level Tokens**, generate one named `socket` with the
`connections:write` scope. Then:

```sh
install -d -m 700 ~/.config/<bot>
(umask 077; cat > ~/.config/<bot>/slack-app-token)   # paste the xapp- token, Enter, Ctrl-D
```

The listener refuses to start if that file is readable by anyone else.

## 3. Install the scripts

From the bot's repo checkout:

```sh
.agents/skills/opsbot-slack/scripts/opsbot-slack install
```

It copies three scripts into `opsbot.d/` and prints two blocks to add to `opsbot.json`. Fill
in two ids:

- `bot_user`: the bot's own user id (`U…`). `slack-axi doctor` shows it, or the app's
  **App Home** page.
- `escalate_dm`: the id of the bot's DM with you (`D…`). Open a DM with the bot in Slack;
  the id is in the conversation's details, or in the URL in a browser.

Commit `opsbot.json` and the scripts. Then start the listener and check everything:

```sh
.agents/skills/opsbot-core/scripts/opsbot-core infra install
.agents/skills/opsbot-slack/scripts/opsbot-slack status
```

Every row should say `ok`. Each row that does not prints the command that fixes it. Then DM
the bot: 👀 appears within seconds, ⚙️ once the bot has read the message, and the answer
follows in a thread.

## What the bot can and cannot see

- It reads direct messages sent to it, and group DMs it is part of.
- It reads a channel only after someone adds it there (`/invite @<bot>`). In a channel it
  hears @mentions of itself, and reactions on its own messages.
- It does not see member email addresses. The manifest leaves `users:read.email` out on
  purpose.
- It cannot read direct messages between other people, or channels it is not in.
- It knows when a new member joins the workspace.

## Changing a scope

1. Edit the manifest in the repo, in a pull request, with the reason in a comment beside the
   scope. The manifest's header lists the optional ones and what each is for.
2. Once it merges, open the app at <https://api.slack.com/apps>, go to **App Manifest**, paste
   the new version, and save.
3. Reinstall the app when Slack asks. If the bot token changed, log slack-axi in again with
   the new one (`slack-axi auth login --token xoxb-...`).
4. Run `opsbot-slack status`, and `slack-axi doctor` to see the scopes the token now has.

If the bot does not react to an @mention, the listener's log says which events reach it:
`journalctl --user -u opsbot-<bot>-monitor-10-slack-listener`. No `app_mention` lines there
usually means the `app_mentions:read` scope or the `app_mention` event is missing.

To take a token back, revoke it on the app's pages, then delete the file or run
`slack-axi auth revoke <team>`.
