---
status: in-progress
depends: [opsbot-slack, slack-operator-app-posts]
issues: [81]
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: owner-only listening, an intercept, file download, and a posting-identity check

## Why

An assistant-style bot answers one person and replaces an older DM bot. Four things it needs
from the Slack skill were missing, so its adopter carried a patched listener, which
`opsbot-slack status` then reported as `differs` on every update (issue #81):

1. The listener kept anyone's events. The bot must hear only its owner, and a stranger must get
   no sign that a session exists.
2. Some messages are for code: a DM starting with a sigil goes to a capture script. There was no
   way to act on a message before it became an item, without a model call.
3. The listener never saved a file's bytes, so a screenshot sent to the bot could not be read.
4. A bot that runs as a person's Unix user shares that person's slack-axi store. Nothing proved a
   post went out as the bot rather than the person.

## Scope

In: `templates/monitor.d/10-slack-listener`, `templates/heartbeat.d/20-slack-events` (pass
`files` and `intercept` through), `scripts/slack-post.mjs` and `scripts/opsbot-slack` (the
identity check, the new status rows), the manifest's `files:read` comment, SKILL.md, README, the
spec, and tests in `tests/slack.test.ts` and `tests/slack-post.test.ts`.

Out: the escalation sink, which still posts through slack-axi directly to `escalate_dm` (it is
the kit's own path to the operator and must work while everything else is down). Files in Slack
Connect conversations, which arrive without type or size and are skipped with that reason.

## Implements

- `specs/skills/opsbot-slack.md`: the settings `listen_to`, `intercept`, `intercept_emoji`,
  `intercept_failed_emoji`, `files`; the sections "Owner-only listening", "The intercept",
  "Files", "The posting identity"; exit 5; the status rows; the token resolution order; the
  rules with their whys.

## Approach

1. Listener, pure parts: `settings()` reads the new keys with defaults. `heard(item, event, s)`
   says whether `listen_to` keeps an item; `listenKind(item)` names it for the journal.
   `matchIntercept(item, rules, botUser)` returns the first matching rule and the text after the
   prefix. `interceptRules(raw, root)` validates the rules once at start. `fileMeta(event)` gives
   the `files` column; `allowedType`, `safeFileName` and `fileSkip` decide each file.
2. Listener, process: after `classify`, drop a non-operator with a journal line and nothing else;
   save files through `slack-axi download <id> --out <dir>/<conv>/<ts>/.incoming-<id>`, then move
   the one regular file to its safe name and check it resolves inside `dir`; try the intercept
   (spawn, argv, stdin JSON, timeout, SIGKILL); on success react `intercept_emoji` and stop, on
   failure react `intercept_failed_emoji` and record with `intercept: "failed: <why>"`.
3. Reader: copy `files` and `intercept` from the line to the item.
4. Post command: resolve the token in slack-axi's order (`SLACK_AXI_TOKEN`, `team`, default,
   only); `identity()` calls `auth.test`, caches a match by a hash of the token; `post` refuses
   with exit 5 on a mismatch or failure before the bot-mode check. `identity-check` and
   `listen-check` subcommands print one status row each for `opsbot-slack status`.
5. Status: an `identity` row when `bot_user` is set; `listen_to`, `intercept` and `files` rows
   when each is set.

## Validation

- [ ] `listen_to` unset or `anyone`: everything kept as before; all existing listener tests pass
      unchanged.
- [ ] `listen_to: operators`: an operator's DM, mention, reply and reaction are kept, and anyone's
      message or reaction in `escalate_dm`; a non-operator's DM, mention, kept reply, reaction and a
      `team_join` are dropped with one `dropped non-operator <conv> <user> <kind>` line and no text.
- [ ] The running listener drops a non-operator's DM with no reaction and no line in the events
      file, and still receipts an operator's.
- [ ] `status` refuses `listen_to: operators` with no `operators` and no `escalate_dm`, and an
      unknown value.
- [ ] Intercept matching: leading whitespace trimmed, a leading mention stripped for `mention`,
      exact case-sensitive prefix, first rule wins, kinds respected, reactions never matched, a bad
      rule never matches.
- [ ] Intercept success, in the running listener: the command gets
      `{text, conv, ts, thread_ts, user, files}` with the prefix stripped, nothing is recorded,
      the reaction is `intercept_emoji`, no receipt, no nudge, a journal line without the text.
- [ ] Intercept failure: a non-zero exit and a timeout both record the message with
      `intercept: "failed: …"`, react `intercept_failed_emoji` and the receipt, and wake.
- [ ] Files: a kept DM's file is saved to `<dir>/<conv>/<ts>/<name>` with `path`; an oversize
      file and a disallowed type are skipped without a download; a traversal name
      (`../../x`) is saved under a safe name inside `dir`; a failed download is skipped; a
      Slack Connect file is skipped; with `save` off only metadata is recorded.
- [ ] Files are passed to the intercept command when both are set.
- [ ] The reader passes `files` and `intercept` through.
- [ ] Post: an `auth.test` user that is not `bot_user` refuses with exit 5, nothing sent; a
      match posts; the match is cached and a changed token is checked again; with `bot_user`
      unset nothing is checked.
- [ ] `status` shows the identity row: `ok` on a match, `differs` on a mismatch, `missing`
      without a token.
- [ ] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass.

## Notes

## Follow-ups

## After this plan
