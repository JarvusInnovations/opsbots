---
status: in-progress
depends: []
specs:
  - specs/architecture.md
---

# `main` as the default branch: bots install releases

## Scope

`npx skills add JarvusInnovations/opsbots` installs the default branch. With `develop` as the
default every bot took each merge as it landed. `main` becomes the default; two workflows keep
it release-only (`main-guard`, a required check that a PR into `main` comes from `develop` or
`hotfix/*`; `main-retarget`, which moves a stray PR onto `develop`). The committed bundle keeps
reporting the commit it was built from; a release is named by its tag.

## Steps

1. [x] `main-guard.yml` and `main-retarget.yml` on `develop`; README and architecture say bots
       install releases and how to take `#develop` on purpose.
2. [ ] Released, so both workflows exist on `main`.
3. [ ] A repo admin sets the default branch to `main` and adds the guard as a required check
       in the `Protect main` ruleset.

## Validation

- [ ] `gh api repos/JarvusInnovations/opsbots --jq .default_branch` prints `main`.
- [ ] A test PR from a feature branch into `main` is retargeted to `develop`.
- [ ] `npx skills add JarvusInnovations/opsbots --skill opsbot-core` in a scratch repo
      installs the bundle from the latest release tag.

## Notes

- 2026-11-10: issue 29. Chris: do it once the first kit-built bot settled.
