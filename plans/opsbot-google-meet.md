---
status: done
done: 2026-11-18
depends: [opsbot-google-gmail]
specs:
  - specs/skills/opsbot-google.md
pr: 116
---

# Plan: opsbot-google, Meet transcripts

## Scope

The Meet listener, its reader with the `enrich` hook, the infra module's Meet half, `login`
and `status` for the Meet source, tests.

## Validation

- [x] `ensure` creates, reactivates and extends only its own subscription
- [x] A transcript event becomes one line and one item; the reader never fetches transcript text; under a peek it calls nothing and writes nothing
- [x] `enrich` adds keys and a failing hook fails the input after the items
- [x] Lifecycle: expired and suspended are items, a reminder is not
- [x] The README states first that only organized meetings deliver

## Notes

Built in PR 116. The tests are in `tests/google-meet.test.ts`, against a stand-in Google
(`Bun.serve` on 127.0.0.1: the token endpoint, Workspace Events, Meet REST v2, Pub/Sub) named to
the scripts by the test-only `OPSBOT_GOOGLE_{EVENTS,MEET}_URL` beside the Gmail plan's variables.
Where each box is tested:

- Ensure: "ensure creates, reactivates and extends only its own subscription, never one
  delivering elsewhere; --dry-run calls nothing" (the filter, the create body with
  `includeResource: false`, `PATCH ?updateMask=ttl` with `ttl: "0s"`, `:reactivate` for
  `SUSPENDED`, paged listing, another topic's subscription never written to); "an operation not
  yet done is polled until it is"; "the listener ensures at start and every renew_hours".
- One line, one item, no text, peek: "a transcript event is one line, then state, then the ack,
  then the backstop; the reader makes it one item and never fetches the transcript's text" (the
  stand-in serves a marker only from transcript entries; no request to `entries` or the export
  address, the marker nowhere; the item's exact shape and neutral text; a redelivered key is one
  item; the cache is 0600, metadata only, and a second check makes no Meet call; the window);
  "under a peek the reader calls nothing and writes nothing: one unresolved item per line" (no
  request, no cache written or read, no hook run, state unchanged); "a failed lookup still prints
  the item, unresolved, and fails the input".
- Enrich: "enrich adds keys, never over one the item has; a failing hook fails the input after
  the items; a path outside the repo is refused" (non-zero exit, non-object output, `../` and an
  absolute path).
- Lifecycle: "lifecycle: expired and suspended are items, a reminder is not; each makes the
  listener ensure again; no backstop for them" (the suspension reason reaches the journal, not
  the wake file).
- README: "states first that only meetings the account organized deliver an event" (the
  README's first paragraph; SKILL.md; the infra README names the publisher account and cites
  its page).

Also tested: problems once each for this source ("a failing pull is raised once, kept in state
across a restart, fails the reader, and clears; a Gmail-only grant is sign-in at once"; "a
failing subscription ensure is the watch problem, raised once; the reader fails without state,
with a lapsed or suspended subscription, or a stale pull", the same under a peek); "a required
key missing: the listener refuses to start and names it"; `login` asks for exactly the Meet
scopes, and for the union with `--source both`, written once to the shared file; a one-source
login that would drop the enabled Gmail source's scopes is refused; `install --source meet`;
`status --source meet` (every row ok and it only reads; a missing `user_id` row says how to find
it and the stand-in sees no Admin SDK call). The three Gmail tests that asserted `meet: not yet
available` now assert the Meet source instead; every other Gmail test is unchanged and passes
on the refactored listener (the problem, record and pull-loop code is now shared by both).

`templates/infra/` is now two modules, `gmail/` and `meet/`, each with every name a required
variable: a bot calls only the one it uses, so `tofu init -backend=false && tofu validate` and
`tofu fmt -check` pass for each alone (OpenTofu 1.13.9, `hashicorp/google` 8.12.0). This
settles the Gmail plan's follow-up without an optional input; the Gmail module's variables lost
their `gmail_` prefix (`topic`, `subscription`, `subscriber`), unreleased until now.

Read against Google's public documentation: the Workspace Events overview, "Create a Google
Workspace subscription", "Update or renew", "Reactivate", the lifecycle-events guide, the Meet
events guide, the subscriptions reference (create, list, patch, reactivate), the auth guide, the
Meet REST v2 reference (transcripts, conferenceRecords, spaces, DocsDestination) and the Admin SDK
Directory `users.get` guide. Confirmed there: the user target, the event type, `payloadOptions`,
`notificationEndpoint.pubsubTopic` (in the same project as the client), the list filter
(`event_types:"…" AND target_resource="…"`, an event type required), `ttl` 0 for the maximum
(seven days without resource data), `:reactivate` for a suspended subscription, create, patch
and reactivate returning a long-running operation, the lifecycle event types and their data,
the CloudEvents attributes, the transcript event's data `{transcript: {name}}`, the publisher
account `meet-api-event-push@system.gserviceaccount.com`, the transcript's `docsDestination`
(`document`, `exportUri`), the conference record's times and `space`, `spaces.get` taking
`spaces/<id>` and returning `meetingCode`, and `meetings.space.readonly` sufficing for the
subscription and all three reads. Not confirmed, and so unverified until a real bot runs it:

- That `users/<id>` in the target is the Directory API user id: the guide says the id in a
  participant's `signedinUser.user`, which the reference calls "interoperable with Admin SDK".
- `"0s"` as the wire form of `ttl`: the reference says 0; the samples write `0s`.
- The JSON case of the lifecycle data (`expireTime` or `expire_time`): the guide prints
  `expire_time`; the listener reads both.
- How quickly a create's operation is done (the guide says create returns a completed one; the
  listener polls ten times a second apart otherwise).
- Who receives the event. The spec says organized meetings only, seen on an adopting bot. The
  Meet guide says a user subscription covers spaces the user owns, which is usually the
  organizer, and that invitees "can only receive" the started and transcript events, which reads
  as if an invitee could. The README says organized only, as the spec does.
- The Admin console's user page address ending in the id: not in a public page read here;
  `status` offers it beside the documented `users.get`.

Choices within the spec:

- `drive.metadata.readonly` is not asked for. Every field of the spec's item comes from the
  three Meet reads (`doc.id` is `docsDestination.document`, `doc.url` its `exportUri`), and no
  Meet response has a meeting title; a title is `enrich`'s to add. The spec's Meet scope list is
  one too long.
- A failing subscription call is the `watch` problem kind, the spec's name for the source's
  renewal; `history` does not apply to Meet.
- The lifecycle key is `meet:lifecycle:<event>:<CloudEvents id>`. Only transcript lines run the
  backstop; a lifecycle line makes the listener ensure at once instead.
- The item's `at` is the line's `recorded_at`. Lifecycle items carry `conv`, `kind`, `from` and a
  `text` naming the fix, plus `event` and `expire_time`.
- `enrich` runs for transcript items only (a lifecycle item is not a meeting), and not under a
  peek.
- A failed lookup prints the item unresolved and fails the input, so nothing is held back.
- The reader refreshes the access token in memory, never writing the token file the listeners
  write.
- The cache is `meet-push-cache.json` beside the state file, rewritten with only the
  transcripts still in the window.
- Both sources share the token file by default; `login` writes one grant to each distinct token
  file of the sources it signs in, and refuses a one-source sign-in that would drop an enabled
  source from a shared file. Fix hints name `--source both` when the file is shared.
- `status` rows for Meet are prefixed `meet` (`meet token`, `meet events`, …) so `--source both`
  reads as one list.

## Follow-ups

- A first run against a real Workspace account, to settle the unverified points above.
- The spec's credential section lists `drive.metadata.readonly` for Meet; it is not needed (above).
