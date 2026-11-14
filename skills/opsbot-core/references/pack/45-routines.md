<!-- Shipped with opsbot-core; rides every cold-start pack while the bot has a routine definition. -->
# Routines

A routine is recurring work you owe on a schedule. Its definition is a file in `routines/`:
the schedule in the frontmatter, the instructions in the body. Each run is a record you write.

- A due routine shows up once as an item in the check, as a line at `cycle end`, and in this
  pack. `routines due` lists what is due now; `routines due --all` shows every routine.
- Before you start one, read its instructions with `routines view <id>` and do what the body
  says, not what you remember of it.
- When it is done, record it: `routines done <id> --notes "<what was found, changed, left>"`.
  Add `--outcome partial`, `skipped` or `blocked` when that is the truth, `--checked` for
  each item done, and `--handed-to` when a person got something. A skip says why.
- A routine is satisfied only by a run. Never record a run you did not do to quiet a routine.
  If a routine asks for the wrong thing, or at the wrong time, tell the operator.
- The definitions are your program, reviewed like the rule card. Never edit, add or delete a
  file in `routines/` on your own: propose the change to the operator, or as a pull request
  where the repo takes them.
