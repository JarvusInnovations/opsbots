+++
active = true
cadence = "weekly"
hands_to = "the operator"
id = "weekly-backup-check"
owner = "the bot"
since = "2026-01-05"
title = "Check that last week's backups ran"
+++

# Check that last week's backups ran

An example routine. Copy it to `routines/<id>.md`, set `id` to the file's name, and change the
schedule and these instructions. A routine runs on an interval (`cadence = "daily"`,
`"weekly"`, `"monthly"`, `"quarterly"`, `"yearly"`, or `every = "10d"`) or at a preferred time
(`at = "08:30"` with `days = [1, 2, 3, 4, 5]`, ISO weekdays in the bot's timezone), never both.
Check it with `routines validate`, then merge it the way the rule card changes.

What to check:

- Every nightly backup job since the last run finished and reported success.
- The newest backup can be listed and is not empty.

What done looks like: each night accounted for. A failed or missing night is named, with the
job's own error, and handed to the operator. Record the run with
`routines done weekly-backup-check --notes "<nights checked, failures, who got them>"`.
