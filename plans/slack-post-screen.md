---
status: done
done: 2026-11-11
depends: [opsbot-slack]
specs:
  - specs/skills/opsbot-slack.md
  - specs/architecture.md
issues: [77]
---

# Plan: one post command that classifies the destination and screens the draft

## Why

A bot's reply in a shared channel is read by everyone there. Until now nothing stood between a
draft and the post except the session's own judgment, and the bot posted by calling
`slack-axi draft <reply> "…"` and `slack-axi draft send` itself. There was no single path to
put a check in.

## Scope

In: `opsbot-slack post` and `opsbot-slack classify` (a node script beside the bash command),
the destination classes, the optional screen with its settings and told-once escalation, the
decision log, a `status` row for the screen, a reference screen command and two policy starting
points in `templates/screen/`, the reader's comment pointing at the new command, tests, the
spec, SKILL.md and README.

Out: the send guard's other refusals in [architecture](../specs/architecture.md#guards)
(length, ids, the persona's word list, unread inbound), a provenance rule, and invalidating the
class cache on a membership event (the app does not subscribe to `member_joined_channel`; the
cache is short instead).

## Implements

- `specs/skills/opsbot-slack.md`: Posting (`opsbot-slack post`): the steps, the four classes and
  how each is decided, the large-channel bound, the cache, the screen's settings and contract,
  fail-closed with told-once, the decision log, the exit codes, the limits; the `post`,
  `classify` and `status` rows; the rules that the post command is the only way to post, that a
  doubt is `external`, and that the screen fails closed and never edits.
- `specs/architecture.md`: the channel row says what the Slack send path now does.

## Approach

1. `scripts/slack-post.mjs` (node 22, no dependencies) holds `post`, `classify` and the status
   helper `screen-check`; `scripts/opsbot-slack` dispatches to it after the bot-repo check.
2. Slack's data comes from the Web API with the bot token slack-axi already holds: slack-axi
   1.4.1's CLI does not expose `is_ext_shared` or a member's guest flags per conversation, so
   the script reads the token as slack-axi resolves it (`SLACK_AXI_TOKEN`, else its store under
   the `team`, default or only workspace) and never prints it. No new credential.
3. `decide()`: `auth.test` for the team; `conversations.info` with `include_num_members`; a DM is
   judged by its `user`; any sharing flag is `external`; `num_members` over `max_members` is
   `external`; members are paged by 200 and stop past the bound; members are looked up ten at a
   time with `users.info` and cached. Any failure is `unknown`, never cached.
4. `screenFor()` resolves the class's policy list (`unknown` uses `external`), refuses a command
   or file outside the repo, and joins the files. `runScreen()` sends exactly
   `{draft, destination_class, policy}` and accepts only `pass` or `block`.
5. A failed screen runs every `opsbot.d/escalate.d/` script, as the core does, unless
   `.git/opsbot-slack-screen` exists; the marker is written only when one succeeds and removed by
   the next verdict.
6. Posting is the sink's path: `auth mode` must say bot, then `draft <conv> [--reply <ts>]
   <text>` and `draft send <id>`. Every attempt appends a line to `post_log` with a SHA-256 of
   the draft.

## Validation

- [x] Each class from fixtures through `classify`: an operator by `operators` and by
      `escalate_dm`, a DM with a full member (`internal`), a DM with a guest, an internal
      channel over two pages, Slack Connect, a guest in a channel, a group DM with someone from
      another organization, a failed `conversations.info`, a failed `users.info`, a network
      failure.
- [x] Members are paged to the last cursor; a channel over `max_members` by `num_members` makes
      no member call, and one found over the bound while paging stops after the page that
      crossed it, with no `users.info`; a raised bound with members that cannot be looked up is
      `unknown`, not `internal`.
- [x] A class is cached and reused without a Slack call; `unknown` is not cached; an expired
      entry is looked up again.
- [x] With `SLACK_AXI_TOKEN` unset the token comes from slack-axi's store, is sent as the
      bearer, and is not printed; with no store the class is `unknown` and Slack is not called.
- [x] Without `screen`: posts once at the reply address, logs the class and a hash and not the
      text; a failed lookup does not stop the post; text on stdin works; bad usage is exit 2 with
      no Slack or slack-axi call; human mode and a failed send are exit 1, logged as not posted.
- [x] The screen receives exactly the three inputs, the policy files joined in order; `unknown`
      is screened as `unknown` with the external policy; a class with no list is not screened.
- [x] `operator-dm` makes no screen call, even with a failing screen configured.
- [x] A blocked draft is never posted: exit 3 with the passage and reason; the log holds the
      reason and not the draft.
- [x] A screen that exits non-zero, prints non-JSON, gives another verdict, or passes its
      timeout posts nothing, exits 4, and tells the operator once across two failures; a verdict
      clears the marker and the next failure tells again; when every escalation script fails no
      marker is kept.
- [x] An unusable screen setting is exit 2 for a screened class and nothing is posted; the
      operator's DM still posts.
- [x] `--dry-run` screens and posts nothing.
- [x] `status` shows no screen row without `screen`, `ok` for a usable one, `differs` with the
      problems for a broken one; the existing `status: all 8 ok` expectation is unchanged.
- [x] `node --check` passes for the post script and the reference screen; no test runs the
      reference screen.
- [x] Every existing test passes with no change to its expectations; `tests/slack.test.ts` is
      untouched.
- [x] Slack API names checked against Slack's reference pages for `conversations.info`,
      `conversations.members`, `users.info`, the conversation object and the user object.
- [x] The reference screen's request shape, model id and fallback header checked against the
      current Claude API reference.
- [x] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass.

## Notes

- A DM with a full member who is not an operator is `internal`: its readers are that person and
  the bot, both full members, which is what `internal` means. A bot that must keep things from
  its own team lists `internal` in its policy.
- `is_shared` counts as `external` along with `is_ext_shared`, `is_org_shared` and
  `is_pending_ext_shared`: a channel shared with another workspace of the same organization is
  read by people outside this workspace.
- `max_members` defaults to 100. Each member costs a `users.info` call once per
  `cache_seconds`; past the bound the class is `external`, so a large internal channel costs a
  screen call rather than a guess.
- The escalation sink still posts to `escalate_dm` through slack-axi itself. It is the path that
  reports a screen outage, and its destination is never screened.
- The build changes only the version stamp in the two bundles (no source under `src/` changed),
  so they are not committed.

## Follow-ups

- Not yet filed: ask slack-axi for a conversation-info command carrying the sharing flags and
  member kinds, then read through it instead of slack-axi's token store.
- Not yet filed: the send guard's other refusals, sharing a library with this command.

## After this plan

Not provable without a live workspace, so not part of the validation above:

- that a real Slack Connect channel reports `is_ext_shared` to `conversations.info` with the
  bot token, and a real guest reports `is_restricted` to `users.info`;
- that `conversations.members` answers for a group DM with the bot token's scopes;
- the first real post through `opsbot-slack post` on a bot, with its `post_log` line;
- one real call through `templates/screen/screen` with a bot's own key and policy.
