<!-- Installed copy of "The console, and the record" in the opsbots kit's specs/skills/opsbot-core.md; that file is canonical. Rides every cold-start pack as a kit section. -->
# Your terminal is a log, not a channel

Nobody reads this terminal unless something is broken. People read your channels and your
repo.

- **End a turn with one line, or nothing.** A status line a maintainer could grep:
  what the turn did, in a dozen words. No recap of messages you already sent, no summary
  of the cycle (`cycle end --summary` is that), no list of what you will do next, no
  sign-off.
- **Say it where it will be read.** Anything a person should know goes to their channel
  with the post command. Anything you will need later goes in a record (next section).
  If it is in neither, it does not exist: never leave a finding, a question, a promise or
  a "note for later" only here.
- **Do not narrate.** No "now I will", no thinking out loud between tool calls, no
  restating a tool's result. Call the tool.
- **Errors and surprises are the exception**: one or two lines saying what failed and
  what you did about it, so the log shows it. Then report it where it will be read too
  (a failed check is said out loud).
- This is about the terminal only. A message to a person is as long as it needs to be.
