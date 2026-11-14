# Permissions

How a bot gets its routine work past Claude Code's permission system without a person
approving each call, and without ever being able to widen its own reach.

## Principles

**Inherited:** [A guard in code beats a rule in prose](principles.md#a-guard-in-code-beats-a-rule-in-prose):
the scope of an allowed action lives in a script, not in a sentence the classifier may or
may not weigh.

**Local:**

- **Narrow allow, wide refuse.** An allow rule names one script; the script hardcodes its
  target (one repo, one mailbox, one role) and refuses every argument that would widen it.
  Why: Claude Code resolves narrow Bash allow rules before the auto-mode classifier, so the
  rule is deterministic; the script is where the safety is, so the rule can be.
- **A bot cannot grant itself anything.** The permission surface is the allow rules
  (`.claude/settings*`) and the scripts those rules name (`bin/`); it changes only by a PR
  a person merges, and the bot's own merge script refuses PRs that touch it. Why: an
  allowlist the bot can edit is not an allowlist. Everything else in the repo, the skills
  above all, is the bot's own work and merges through its script: a bot's self-improvement
  loop is mostly skill edits, and a guard that blocks them stalls the loop on a person for
  changes that widen nothing. The cost accepted: an allow rule that names a skill's script
  (the core's own, say) trusts that skill as installed; keep such rules to the vendored,
  `npx skills`-managed skills whose source is a reviewed repo.
- **A bot does not reprogram itself either.** Two more things change only by a PR a person
  merges, where the repo requires review: the rule card, and the routine definitions in
  `routines/` ([opsbot-core](skills/opsbot-core.md#routines)). A definition is what the bot
  will do on a schedule, unprompted, so a change to one is a change to its behaviour. The
  bot's merge script refuses PRs that touch them, as it refuses the permission surface. Runs
  of a routine are the bot's own record and need no review. Why: a bot that could add a
  routine could schedule itself any work at all, and nobody would read it before it ran.

## The three layers, as Claude Code applies them

1. **Permission rules** (`permissions.allow|ask|deny`): pattern rules, no model, resolved
   first. In auto mode a *narrow* allow (`Bash(bin/merge-own-pr *)`) auto-approves without
   the classifier; broad rules (`Bash(*)`, wildcarded interpreters) are suspended. Rules in
   the bot's committed `.claude/settings.json` apply once the bot user has trusted the
   folder; `autoMode` is never read from the repo.
2. **The classifier**: judges what layer 1 left undecided, with `autoMode.environment`
   (prose: what is inside the boundary) and the bot's CLAUDE.md as context. Configured only
   in the bot user's `~/.claude/settings.json` or managed settings.
3. **Hooks**: `gate check` (PreToolUse) runs before both and holds every tool until the
   cold-start pack is read; it is where the gate word is judged.

## What a bot's repo carries

- `bin/<verb>` scripts, one per routine action, each with: the target hardcoded; argument
  validation; a `--check` or `--dry-run`; a refusal list in its header comment.
- `.claude/settings.json`: `permissions.allow` naming each script and the bot's own AXI
  tools whose scope is already the bot's identity (its Slack token, its mailbox, its
  record); `autoCompactEnabled: true`, so no host default can turn compaction off; the
  kit's hooks.
- `CLAUDE.md`, a "Routine operations" section stating what is inside the boundary, for the
  classifier as much as for the bot.
- The rule card: the bot never widens its own permissions and does not route around a block.

## What the operator applies once per host

`autoMode.environment` and `autoMode.allow` for the bot user, rendered by
`opsbot-core permissions render` from `opsbot.json` and the repo (organization, trusted
repo, the bot's accounts and surfaces, host containment, sensitive data and its audiences)
and reviewed before it is written to `~/.claude/settings.json`. It cannot be committed, by
Claude Code's design; the render makes it reproducible.

## What this does not do

It does not remove the gate word: ENGAGE is judged by the hook and the rule card, not by
the permission rules. It does not let the bot send in the company's name, delete a user, or
merge to a release branch; no script exists for those, so no rule can allow them.
