---
status: done
done: 2026-11-11
depends: [start-command]
specs:
  - specs/skills/opsbot-core.md
  - specs/skills/opsbot-host.md
pr: 61
---

# `start --continue` resumes the loop's own session

## Scope

`start --continue` passed `--continue`, which resumes the most recent session in the
directory. On a restart of a live bot that was a person's two-day-old test session opened in
the bot's checkout, and the loop ran two cycles in it before anyone noticed. Every
`cycle begin` run inside a session now records that session's id
(`.git/opsbot-loop-session`), and `start --continue` resumes it by id. With none recorded it
falls back to `--continue`.

Also here: the host bootstrap installs `agent-recall-axi`'s session hook at user scope, so
every agent environment has its session history in reach.

## Validation

- [x] After a cycle begun inside a session, `start --continue --dry-run` prints
      `--resume <that id>`; a cycle run outside any session does not move it; plain `start`
      never resumes.
- [x] With nothing recorded, `start --continue` passes `--continue` as before.
- [x] The bootstrap's dry run lists the recall hook; `--tools` without the tool skips it.
- [x] Full suite passes; bundle and SKILL.md `--check` clean.

## Notes

- 2026-11-10: found on the first restart of a kit bot whose checkout had held a person's test
  session. The operator spotted it; the bot was restarted on its real session by id.
- 2026-11-11: the operator's addition: a session name in the settings, used when the session
  is created and when it is resumed. `loop.session_name` (the bot's name by default) is passed
  as `--name` on every start and is the resume key when no id is recorded. The recorded id
  stays first because it is exact; a name can match more than one session.

