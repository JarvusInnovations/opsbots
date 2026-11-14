---
status: done
done: 2026-11-14
depends: [slack-post-screen, slack-owner-intercept-files]
upstream-specs:
  - slack-axi:specs/commands/audience.md
specs:
  - specs/skills/opsbot-slack.md
---

# Plan: classify a destination through `slack-axi audience`

## Why

`opsbot-slack post` decides who can read a destination before it screens a draft. Until now it
read slack-axi's stored bot token itself and called `conversations.info`,
`conversations.members` and `users.info` directly, because slack-axi had no command that said
who can read a conversation. slack-axi 1.6.0 has one, `slack-axi audience`. Reading through it
puts the logic in one place, in the tool that already holds the token, and takes the kit out of
the business of calling Slack for this.

## Scope

In: `scripts/slack-post.mjs` (the classifier and its parser), `scripts/opsbot-slack` (a status
row for slack-axi 1.6.0 and `audience`), the spec, SKILL.md, and the tests.

Out: the posting identity. It still calls `auth.test` with the token slack-axi will post with,
through one small resolver (`postToken`), because no slack-axi command prints the live token's
user id: `doctor` prints a name when it has one, `auth workspaces` the stored identity.

## Implements

- `specs/skills/opsbot-slack.md`: "Destination classes" through `slack-axi audience`; how
  `bots`, `other_workspace`, `truncated` and `unresolved` count, with why; the cache without
  per-user rows; the token read only for the identity; the status row; the rule with its why.

## Approach

1. `readAudience(conv)` runs `slack-axi audience <conv> --max-members <max_members>` with
   `--team` when set. An `Unknown command` error names the upgrade; any other non-zero exit or
   `error:` line is a failed lookup.
2. `parseAudience(out)`: a small strict TOON reader for what the classifier needs: the
   workspace header's team id, the `conversation` and `audience` blocks (quoted strings with
   escapes, booleans, numbers, bare text), and the `non_full_members` table rows (quoted cells
   with commas). A missing block, count, `truncated` or `members_checked` throws.
3. `decide()` keeps today's order and wording: operator DM; a sharing flag; over the bound;
   unresolved is unknown; no member is unknown; a guest, an external, an other-workspace or a
   deactivated member is external, named from the first non-bot row; else internal. The team id
   from the header still clears the cache when the workspace changes.
4. The Web API code shrinks to `authTest()`; `users` rows leave the cache file.
5. `status`: `slack-axi --version` at least 1.6.0 and `slack-axi audience --help` answering,
   else `missing` with `npm install -g slack-axi@latest`.

## Validation

- [x] Every class from canned `audience` reports: operator DM by `operators` and by
      `escalate_dm`, internal DM and channel, guest DM and channel, Slack Connect, group DM with
      an external member, both large-channel cases, a failed lookup, an unresolved member, a
      network error: the existing expectations hold, class and `why`.
- [x] Bots of the workspace are full members; `other_workspace`, a deactivated member and an
      external bot are external; no member, a DM with no `user` and a report without an
      `audience` block are unknown.
- [x] The sample report from slack-axi's own spec parses, with a quoted name holding a comma
      and escaped quotes.
- [x] `audience` is called once per uncached class, with `--max-members` from `max_members` and
      `--team` when set; the class cache and the team reset still work; `unknown` is not cached.
- [x] An older slack-axi (`Unknown command: audience`) gives `unknown` with the upgrade named,
      and `status` shows `slack-axi-audience` as `missing` with the fix; 1.6.0 shows `ok`.
- [x] `classify` makes no Web API call; the post's identity check still reads slack-axi's store
      and never prints the token.
- [x] `bun run build`, `bun run type-check`, `bun test` and `bun run check` pass.

## Notes

- Read against slack-axi `main` at v1.6.0: `specs/commands/audience.md` and
  `src/commands/audience.ts`. Its category order (deactivated, external, other_workspace, bot,
  guest, full; external outranks guest and bot) matches what the kit's own `users.info` rules
  did, with one naming difference: the kit called any other `team_id` "from another
  organization", and still classes `other_workspace` external for that reason.
- `truncated` stays `external`, not `unknown`: slack-axi sets it only when the list did not end
  within the bound, which is exactly the kit's old "over max_members" case, and the existing
  spec and tests have that as `external`.
- slack-axi does not cache what `audience` reads, and stops at `--max-members`; a large channel
  now costs up to `max_members` `users.info` calls once per `cache_seconds`, where the kit used
  to skip them when `num_members` was already over the bound.
- The kit's scripts take no dependencies, so the TOON reader is the kit's own and covers only
  the two blocks and one table it needs. Test fixtures are built with `@toon-format/toon`, the
  encoder slack-axi uses, plus slack-axi's spec sample by hand.
- Test stubs changed, expectations did not, with these exceptions. Three tests asserted the
  kit's own Web API calls (paging cursors, `users.info` per member, the token used for
  `classify`); that work is slack-axi's now. They were rewritten to assert the `audience` call
  and that `classify` makes no Web API call. The slack-axi stand-in logs `audience` and
  `--version` apart, so the post path's call lists stay as they were. The two "lookup failed"
  `why` strings are the stand-in's error text. The "status: everything in place" count went
  from 9 to 10 rows.

## Follow-ups

None.

## After this plan

Not part of the validation, since it needs live Slack: on the first bot that takes this
version, `opsbot-slack classify` on an internal channel, a Slack Connect channel and a DM give
the same class as before the upgrade.
