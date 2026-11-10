---
status: planned
depends: [opsbot-host-bootstrap]
specs:
  - specs/skills/opsbot-host.md
awaits:
  - "a newly created Linux user on a host (root: useradd, enable-linger, the operator's sudo rule)"
---

# opsbot-host: the whole skill on a fresh user

## Scope

A rehearsal, not new code unless it finds a gap: on a user created minutes earlier, run
`bootstrap`, `sessions keep`, `desktop install`, `browser install`, and read `status`.

## Validation

- [ ] `status` reads all ok except the repo settings block, which a person commits.
- [ ] `opsbot-core cold-start` runs in a cloned bot repo.
- [ ] The headless and the headed browser smoke tests pass on the derived display and ports.
