---
status: planned
depends: [wake-backstop]
specs:
  - specs/skills/opsbot-google.md
---

# Plan: opsbot-google, the Gmail push

## Scope

The skill directory, `install`, `login`, `ensure`, `status`, the Gmail listener and its
heartbeat, the infra module's Gmail half, tests against a stand-in Google (a local HTTP server
the scripts are pointed at by an environment variable), SKILL.md and README. The Meet half is
its own plan.

## Validation

- [ ] The wake line carries no sender, subject, snippet, thread or message id (a marker test over the wake file, the state file and the journal)
- [ ] Only messages newly added with a watched label and neither SENT nor DRAFT count; a read, an archive and a label change write nothing
- [ ] Recorded, then state, then acknowledged; a crash between leaves a redelivery whose key is already there
- [ ] The watch is renewed when due and keeps the cursor; a lost cursor resyncs and fails the heartbeat once
- [ ] Each problem kind is raised once after its time, at once for sign-in, survives a restart and clears on success; a failed write does not exit the listener and acknowledges nothing
- [ ] The token file is 0600, refreshed in place, never printed; `login` asks for exactly the two scopes
- [ ] Every file is created 0600; no setting has a default naming a project, address or zone
- [ ] `status` shows each row against the stand-in, and `install` writes no settings
- [ ] The heartbeat is safe under a peek

## Notes

## Follow-ups
