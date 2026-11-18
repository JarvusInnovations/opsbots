---
status: done
done: 2026-11-18
depends: [wake-backstop]
specs:
  - specs/skills/opsbot-google.md
pr: 115
---

# Plan: opsbot-google, the Gmail push

## Scope

The skill directory, `install`, `login`, `ensure`, `status`, the Gmail listener and its
heartbeat, the infra module's Gmail half, tests against a stand-in Google (a local HTTP server
the scripts are pointed at by an environment variable), SKILL.md and README. The Meet half is
its own plan.

## Validation

- [x] The wake line carries no sender, subject, snippet, thread or message id (a marker test over the wake file, the state file and the journal)
- [x] Only messages newly added with a watched label and neither SENT nor DRAFT count; a read, an archive and a label change write nothing
- [x] Recorded, then state, then acknowledged; a crash between leaves a redelivery whose key is already there
- [x] The watch is renewed when due and keeps the cursor; a lost cursor resyncs and fails the heartbeat once
- [x] Each problem kind is raised once after its time, at once for sign-in, survives a restart and clears on success; a failed write does not exit the listener and acknowledges nothing
- [x] The token file is 0600, refreshed in place, never printed; `login` asks for exactly the two scopes
- [x] Every file is created 0600; no setting has a default naming a project, address or zone
- [x] `status` shows each row against the stand-in, and `install` writes no settings
- [x] The heartbeat is safe under a peek

## Notes

Built in PR 115. All tests are in `tests/google.test.ts`, against a stand-in Google started by
the test (`Bun.serve` on 127.0.0.1) and named to the scripts by the test-only
`OPSBOT_GOOGLE_{AUTH,TOKEN,GMAIL,PUBSUB}_URL`; the core is a stand-in that logs each
`wake backstop`. Where each box is tested:

- No content: "no sender, subject, snippet, thread or message id reaches…". The stand-in puts a
  marker in every message id, thread id, sender, subject and snippet it serves; the test checks
  the stand-in did serve it, then that the wake file, state file and listener output do not hold it.
- What counts: "only messages newly added with a watched label…" (INBOX counts; INBOX+SENT,
  DRAFT and another label do not; a record without labels is looked up with
  `format=minimal`; a 404 there is skipped; a label-only change writes nothing but moves the
  cursor; the history is read in two pages).
- Order: "a first run writes a baseline; a new inbox message is one line, then state, then the
  ack, then the backstop" (the stand-in looks at the wake file and the state file at the moment
  the ack arrives); "a failed state write records the line, acknowledges nothing…"; "a crash
  between the line and the acknowledgement…" (SIGKILL after the line, restart, same key again,
  then acknowledged).
- Watch and resync: "the watch is renewed when due and keeps the cursor"; "a lost cursor resyncs
  from the newest notification and fails the heartbeat once" (fails against a watermark before
  the resync, passes against one after).
- Problems: "a failing pull is raised once after problem_after_minutes, recorded in state,
  survives a restart, and clears on success"; "a revoked grant is the sign-in problem at once; a
  missing scope too"; "a failing watch and a failing history read are each raised once, as their
  own kind"; the write problem in the failed-write test.
- Token and login: "the token file is refreshed in place, stays 0600, and no token is ever
  printed…"; "asks for exactly the two scopes with PKCE; the loopback redirect writes the token
  file 0600 in a 0700 directory, never printed"; "--paste takes the redirect's address on stdin;
  a wrong state or a partial grant writes nothing".
- Files and defaults: the token test checks the token, wake and state files 0600 and their
  directories 0700; "no setting has a default naming a project, an address or a zone"; "a
  required key missing: the listener refuses to start and names it".
- Status and install: "status: every row ok against the stand-in, and it only reads" (token and
  state files unchanged, a waiting message handed back); "status: each problem is a row with its
  fix"; "install copies the source's scripts and prints the settings and the wake.files entry;
  it never writes opsbot.json".
- Peek: "fails with each reason; passes when healthy; the same under a peek, which writes nothing
  and calls nothing".
- `templates/infra/`: `tofu init -backend=false && tofu validate` and `tofu fmt -check` pass with
  OpenTofu 1.13.9 and `hashicorp/google` 8.12.0 (the provider's current release; the module
  pins `~> 8.0`).

Read against Google's public reference (users.watch, users.history.list, the Gmail push guide,
Pub/Sub `subscriptions.pull`, the installed-app OAuth guide). Not confirmed there, and so
unverified until a real bot runs it:

- `labelFilterBehavior`: the reference lists `include`/`exclude`; the push guide's example writes
  `INCLUDE`. The listener sends `include`.
- Whether `messagesAdded[].message` carries `labelIds`: the reference says history messages
  typically carry only `id` and `threadId`, so the `format=minimal` lookup is the common path,
  not the exception.
- Pub/Sub has no zero-message pull (`maxMessages` must be positive). `status` checks the
  subscription by pulling one with `returnImmediately` and handing anything it receives straight
  back with `modifyAckDeadline` 0, so the listener gets it at once.
- How long a real long-poll `pull` holds the connection; the listener allows 120 s.
- Whether Google returns a new refresh token on refresh (the listener keeps the old one unless
  it does) and the exact error bodies for a revoked grant (`invalid_grant`) and a missing scope
  (a 403 whose body names the scope).

Choices within the spec:

- `--source` defaults to `gmail` for every command; `meet` and `both` print `meet: not yet
  available`, and `login`/`ensure` with only `meet` exit 1.
- `topic` and `subscription` take a short name (joined to `project`) or a full `projects/…` path.
- The line's history id is the newest history record that counted a message, so a redelivered
  batch repeats its key; the cursor moves to the newest id the history read returned.
- `baseline` and `resync` lines carry `count: 0`. Only `inbox` and `resync` lines run the
  backstop; a `problem` line does not (the heartbeat reports it at the next check).
- `expires_at` in the token file is epoch milliseconds. A token refreshed by `status` stays in
  memory, so `status` writes nothing.
- A disabled listener stays running and idle (the unit restarts anything that exits).
- `ensure` writes only the watch's expiry into the state file; the history cursor stays the
  listener's.

Laid out for the Meet plan: `google-push.mjs` has `SOURCES`, `SCOPES.meet`, `NOT_YET`, and the
OAuth, Pub/Sub (`pull`, `acknowledge`, `release`), private-file, problem and backstop helpers are
source-free; `status-rows` and the bash command take `--source`. The Meet listener adds a
`runMeet`, a `meetSettings`, a `listen meet` branch, its heartbeat template, and the infra
module's Meet variables beside `gmail.tf`.

## Follow-ups

- The infra module's Meet half will need its inputs optional (a bot installs either source);
  decide in the Meet plan how that fits "every name a required variable".
- A first run against a real mailbox, to settle the unverified points above.
