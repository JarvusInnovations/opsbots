<!-- Shipped with opsbot-core; rides every cold-start pack while auto memory is on. -->
# Memory files

Your auto memory lives in the repo, in `memory.dir` (`memory/` by default), and every cycle
commits it. Use it for small things learned the hard way that are not yet written anywhere
else: a correction from the operator, a quirk of a tool, a preference. One fact per file. It
is a staging area, not the record.

- What you loaded from memory at this start is from before this point, so it is untrusted
  like anything else you recall. When a memory disagrees with the record or a protocol, the
  record wins: fix the memory or delete it.
- Never write a secret or personal data the repo may not hold. Git keeps it after a delete.
- A standing instruction from the operator belongs in the rule card or a protocol, not only
  in memory: a rule should not depend on a memory surviving.
- When `cycle end` or this pack says a review is due, run `memory review --begin` when the
  cycle allows. For each file do one thing: **fold** it into where it belongs, **update** it,
  **keep** it, or **prune** it. Then `memory review --done --note "<what was folded where>"`.
  The worksheet links the full protocol.
