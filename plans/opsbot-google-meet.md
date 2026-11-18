---
status: planned
depends: [opsbot-google-gmail]
specs:
  - specs/skills/opsbot-google.md
---

# Plan: opsbot-google, Meet transcripts

## Scope

The Meet listener, its reader with the `enrich` hook, the infra module's Meet half, `login`
and `status` for the Meet source, tests.

## Validation

- [ ] `ensure` creates, reactivates and extends only its own subscription
- [ ] A transcript event becomes one line and one item; the reader never fetches transcript text; under a peek it calls nothing and writes nothing
- [ ] `enrich` adds keys and a failing hook fails the input after the items
- [ ] Lifecycle: expired and suspended are items, a reminder is not
- [ ] The README states first that only organized meetings deliver

## Notes

## Follow-ups
