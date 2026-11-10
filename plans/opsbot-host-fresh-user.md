---
status: done
done: 2026-11-10
depends: [opsbot-host-bootstrap]
specs:
  - specs/skills/opsbot-host.md
---

# opsbot-host: the whole skill on a fresh user

## Scope

A rehearsal on a Linux user created minutes earlier (root's three steps, nothing else):
`bootstrap` piped from `main`, then a scratch bot repo with both skills installed, then
`sessions keep`, `desktop install`, `browser install`, and `status`.

One gap found and fixed here: `status` did not check `agent-recall-axi`, which the bootstrap
installs and the cold-start pack reads through.

## Validation

- [x] The bootstrap one-liner from `main` installed eleven pieces in under two minutes and
      found the system's `gh`; the system's node 18 was ignored.
- [x] `status` reads all ok except the three repo-settings rows, which a person commits.
- [x] `opsbot-core settings validate` passes on the template and `cold-start` prints the pack
      in the scratch repo.
- [x] The three desktop units are active on the derived display (`100 + uid % 100`), with VNC
      listening on the tailnet address only, on the derived port.
- [x] The headless browser opens a page on the derived bridge port; a headed browser, started
      on its own port, runs on the derived display.

## Notes

- 2026-11-10: `.bashrc` ends up with two managed blocks at the top (the browser environment,
  then PATH), both above the interactive guard; each rewrites only its own.
- The `skills` CLI reads standard input, so a script piped to a shell must give it
  `</dev/null` or it swallows the rest of the script.
- A headed and a headless browser need different bridge ports; start the headed one with its
  own `CHROME_DEVTOOLS_AXI_PORT`.
