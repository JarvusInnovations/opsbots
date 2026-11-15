# Give an ops bot its own WhatsApp account

This skill puts an ops bot in WhatsApp as its own account, with its own number. People message
it directly or mention it in a group. The bot wakes within seconds, the blue ticks show once it
has read the message, and it answers in the chat they asked in. It can also message its operator
when its loop stops.

The bot never uses a person's WhatsApp account. It needs a phone number of its own.

You need: a phone number and a phone to register a WhatsApp account on, the bot's repo with
`opsbot-core` installed, a shell as the bot's Linux user, and
[whatsapp-axi](https://github.com/JarvusInnovations/whatsapp-axi) installed for that user.

## 1. The account

Register WhatsApp on the bot's phone with the bot's number. Then, as the bot's user:

```sh
whatsapp-axi account add <account>
whatsapp-axi daemon install <account>
whatsapp-axi auth link --phone <the bot's number> --account <account>
```

The last command prints a code. On the bot's phone, open WhatsApp, go to **Linked devices**,
choose to link with a phone number, and type the code. The daemon now holds the session. It runs
as a user service, so it keeps running after you log out.

Keep the phone switched on and online now and then: WhatsApp logs out a linked device whose
phone has been away for about two weeks. `whatsapp-axi doctor` warns as that nears.

## 2. Who the bot answers to

Add yourself as an operator, by your own number in E.164 form:

```sh
whatsapp-axi operators add +15550100001 --account <account>
```

## 3. What the bot can see

The daemon decides what it keeps. That choice is the account's **scope**, and only you set it.

- `tagged`, the default: in a group, the bot keeps a message that mentions it, the message such a
  reply quotes, replies down from it, and replies to its own messages.
- `full`: the bot keeps everything in a group. Set it for one group with
  `whatsapp-axi scope set --chat <group id> full --confirm`.
- Direct messages are kept from operators only, unless you run `whatsapp-axi scope dm-from anyone`.

**What this does not promise.** WhatsApp delivers every message in a group to every member's
devices. The daemon receives all of a group's messages and sends the usual delivery ticks for
them. It discards what its scope does not keep without writing it anywhere. In a `tagged` group it
holds recent discarded messages in memory for up to 48 hours, so it can keep the one a later
mention replies to. People in a group with the bot should know that.

See what the bot can read at any time with `whatsapp-axi scope show`, or in `opsbot-whatsapp status`.

## 4. Install the scripts

From the bot's repo checkout:

```sh
.agents/skills/opsbot-whatsapp/scripts/opsbot-whatsapp install
```

It copies three scripts into `opsbot.d/` and prints a block to add to `opsbot.json`:

- `account`: the name you used above.
- `operators`: your number, the same as in `whatsapp-axi operators list`.
- `escalate_chat`: where the bot messages you when its loop stops. Your number works.

It also prints one command that points the daemon at the bot's wake file. Run it. Commit
`opsbot.json`, then:

```sh
opsbot-core infra install
.agents/skills/opsbot-whatsapp/scripts/opsbot-whatsapp status
```

Fix each row that is not `ok`; each one prints its fix. Then message the bot.

## 5. The trusted circle

By default the bot hears anyone whose message the daemon kept. To have it hear only you and the
people you trust with it, list them and set `listen_to`:

```json
"trusted": ["+15550100002", "+15550100003"],
"listen_to": "trusted"
```

A chat whose members are all you, trusted people and listed peer bots is classed `trusted`, and
the bot can check its drafts against a policy written for that audience. Being trusted never lets
someone approve things on your behalf.

## 6. Check drafts before they post (optional)

The bot posts every message through one command, `opsbot-whatsapp post`. Before it posts, the
command works out who is in the chat from WhatsApp's own member list. It can then hand the draft
to a screen, a small command in the bot's repo that says pass or block against a written policy.
It is the same screen as the Slack skill's, so a bot with both shares it.

1. Copy a screen command into the bot's repo, for example `bin/screen` (the Slack skill ships a
   reference one in its `templates/screen/`).
2. Write `policy/trusted.md` and `policy/external.md` for this bot.
3. Add `screen` to `streams.whatsapp`, with `policy.trusted` and `policy.external`.
4. Run `opsbot-whatsapp status`: the `screen` row should say `ok`.

A file to a chat with anyone outside is refused unless you set `screen.files_external` to `true`.

## 7. Another bot in the same group (optional)

Two bots answer each other forever unless something stops them. List the other bot under
`peers`, with its number and the groups where it is heard. The bot then refuses a post after six
turns between the bots with no person between, or past twenty posts to that group in an hour.
