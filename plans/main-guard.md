---
status: done
done: 2026-11-10
depends: []
specs:
  - specs/architecture.md
pr: 44
---

# Guard `main` so it can become the default branch

## Scope

`npx skills add JarvusInnovations/opsbots` installs the default branch. With `develop` as the
default every bot took each merge as it landed. This plan makes `main` safe to be the default:
`main-guard` (a check that a PR into `main` comes from `develop` or `hotfix/*`) and
`main-retarget` (moves a stray PR onto `develop`), and the README and architecture say that
bots install releases and how to take `#develop` on purpose. The committed bundle keeps
reporting the commit it was built from; a release is named by its tag.

Not in this plan: the switch itself. Setting the default branch and requiring the guard in the
`Protect main` ruleset are repo-admin settings, tracked in issue 29, done after the release
that puts both workflows on `main`.

## Validation

- [x] Both workflows are byte-identical to the ones running in the sibling skill repo, apart
      from the repo name in a comment.
- [x] README and `specs/architecture.md` state that installs take the latest release and how
      to install from `develop`.
- [x] `bun run check` and the suite pass.

## Notes

- 2026-11-10: issue 29. Chris: do it once the first kit-built bot settled.
