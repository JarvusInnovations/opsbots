# Architecture

The operating model every ops bot built on this kit shares, synthesized in October 2026
from two running bots (a campaign bot and a support-desk bot) and the retired festival
bot before them. Where the two running bots did the same thing differently, this file
picks one and says why. Instance details stay in each bot's own repo and its mothership.

## The composition

A bot is a repo. The kit installs into it as skills; the bot's own specs, sheets, rule
card and channel configuration are its own.

| Layer | Owned by | Examples |
| --- | --- | --- |
| The loop | `opsbot-core` | check, cycle-begin/end, next-delay, cold-start, lock, outage accounting, watchdog + nudge units |
| The record | `opsbot-record` | the shared sheets: requests (incl. promises), deliveries, decisions, limitations, proposals; the rules they follow |
| The voice | `opsbot-persona` | the rule-card template, the mark, acknowledge-first, the refusal list a send guard is built from |
| The channels | `opsbot-<channel>` | one adapter per surface: read, send guard, listener, reaction ack |
| Delivery | `opsbot-deliver` | hand a file to a person and prove they can open it |
| The bot's own | the bot's repo | its specs, its principal's sheets (people, accounts, clips…), its rule card's contents, its tools in `bin/` |

A mothership is a repo with the `mothership` skill: the fleet sheets and, later, the
mechanic. Many motherships; each tracks its own fleet.

## The loop

One long-lived agent session in the bot's repo, running a self-paced cycle. A **cycle**
is: begin → check → act or say nothing new → end → compute the next wake. The idle path
is one script call and one line of output; the model is not involved until the check
says there is something to do.

```
listener ──wake──▶ ┌──────────────────────────────────────┐
timer ────wake──▶  │ cycle-begin  (lock, outage check)     │
                   │ check        (every stream, no model) │──0──▶ log, commit, next-delay
                   │ act          (the model; records)     │
                   │ cycle-end    (watermark, commit)      │
                   └──────────────────────────────────────┘
watchdog ──────────▶ escalates when no cycle has logged within the limit
```

### Begin

- Refuses to run while another writer holds the checkout: a rebase, merge or other git
  operation in progress, an `index.lock`, or the cycle lock held by a live process. The
  lock lives in the git directory, holds `{pid, session, started}`, is taken with
  noclobber, and is abandoned only when its process is dead, it is older than the
  configured maximum, or it belongs to this session. Taking over an abandoned lock is
  recorded as an outage.
- Records a `stopped` outage when no cycle has logged within the limit.
- Runs the check.

### Check

One script sweeps **every** stream the bot listens to and reports what is new since the
watermark, without the model. "Whole or not at all."

- Streams are declared in the bot's settings with a posture. The script sweeps everything
  the adapter can see (every conversation a bridge holds, every inbox folder) so a new
  conversation appears without configuration; a new one is reported as needing a posture,
  and its contents are not read until it has one.
- State is committed, under the bot's `logs/intake/`: a typed seen-key set
  (`chat:<conv>:<msg>`, `mail:<id>`, `log:<service>:<id>`), one UTC watermark, and any
  baselines. Nothing lives only in a cache directory.
- One watermark, read with a lookback margin; seen keys stop the margin from
  double-reporting.
- Exit codes: `0` nothing new (the script itself logs, commits and advances the
  watermark); `10` something new (digest printed; ids recorded as seen at report time;
  watermark held); `20` degraded (named failed inputs, then whatever could be read); `2`
  cannot run.
- A degraded input never produces "nothing new." The window stays open and the operator
  is told.
- Output is full bodies, never slices; every message tagged with its conversation and
  `GROUP` or `DM`; an unmapped sender stays unnamed; a gate word is flagged as present
  but not judged here.
- Settings and records are read at `HEAD`, so what runs is what was reviewed.

### Act

The model reads the digest and does the work: records touched through the sheet tool,
replies through the send guard, deliveries through the deliver guard, escalations
through the escalation tool. Anything longer than a cycle is acknowledged first.

### End

- Pins the watermark to the time of this cycle's check, not to "now," so a message that
  arrived mid-cycle is seen next cycle. Refuses a future time, a backwards move, or a
  cycle with no check since the lock was taken. A degraded cycle leaves the watermark
  alone.
- Appends one line to the cycle log: `{at, outcome, inputs, new, failed, watermark}`
  with `outcome ∈ nothing-new | new | degraded | finished | outage | outage-end`.
- Commits the log and watermark with `--only`, with trailers, and pushes. Records written
  during the cycle are one commit per sheet.
- Prints the closing line, the due promises, and `next <seconds> <reason>`.

### Next wake

A separate script reads the cycle log and the bot's cadence table and returns seconds and
a reason. The table is per bot; the defaults:

| Condition | Wake |
| --- | --- |
| something arrived in the last 15 minutes | 3 min |
| something within the last hour | 10 min |
| quiet, working hours (per bot) | 10 min |
| quiet, otherwise | 30 min |
| night (per bot) | 45 min |
| hard cap | 45 min, under the one-hour cache TTL |

The wake is scheduled by the session's own self-pacing call with the loop prompt
verbatim; the prompt carries the operator's cold-cache suffix where one is in use. There
is one clock. The bot never creates a cron or a second loop; the nudge restarts the one
loop.

## Cold start and compaction

A SessionStart hook on `startup | resume | compact | clear` writes the reground pack to a
file and sets a pending flag; a PreToolUse gate refuses every other tool until the pack
has been read whole. The pack, in order, within a size budget the tests hold:

1. the rule card, whole
2. what is owed: fixes not yet told, open requests with the bot's next move (overdue
   first), due promises, open escalations
3. a 48-hour summary of the cycle log: counts, longest gap, last degraded, outages
4. "memory before this point is untrusted; open the source before saying"

Autocompaction is on with a window the bot sets in one place; the launch line and the
settings file agree because the settings file is the only place it is set.

## Guards

Every outgoing message, file and change goes through a script that can refuse. Guards
have **no override flag**; a refusal is changed by changing configuration or the message.

**Send guard** (one per channel adapter, sharing one refusal library):

- destination not configured, or posture not `post`
- empty, or only the mark; mark not first
- over the channel's length limit
- unread inbound waiting in that conversation (the bot reads before it speaks)
- bare file names, repo or home paths, `http://`, a link glued to a closing bracket
- raw platform ids, phone numbers, email addresses outside allowed domains, runs of
  digits that could be a record number, clock times without a meridian
- the persona's word list (spellings, forbidden terms)
- the same text already sent elsewhere; a request-id clash
- a thread that does not exist (replies go in the thread they answer; a top-level
  pointer is refused)
- Content inside a full `https://` link is exempt from the content checks.
- Retries with the same request id; every attempt logged with a body hash, never the
  text.

**Reply posture** is one setting: `approve | acknowledge | speak`. In `approve` every
reply is held for the operator; `acknowledge` sends the acknowledgement and holds the
answer; `speak` sends.

**Gate word.** One definition shared by the check (flags presence) and the judge
(decides):

- the configured word, uppercase, as a whole word; stripped of fenced code, quoted
  lines, inline code and quotation spans before testing
- counts only when: the sender id (from the channel, never from a name in the text) has
  a record and is entitled for the scope; the message is their own words; a request was
  described in that conversation and is `ready`; the message points at exactly one
  request (same thread, quoting the description, a leading `#n` in a private
  conversation, or the only one awaiting); the description's hash is unchanged; not
  already approved
- the bot's own use approves nothing
- recorded on the request as `go_ahead {by, at, message, hash}`; re-judged immediately
  before anything is applied

**Deliver.** A file is delivered when the recipient can open it, checked this cycle:
upload to a folder the person already has access to, read back the permissions (a
user or domain grant counts; a group grant does not; an anyone-with-link grant makes
the file not announceable), write a `deliveries` record, and print the announcement
already dry-run through the send guard. For a published page, fetch the live URL and
require 200 before logging. Never announce without the link.

**Escalation.** One private conversation with the operator, nothing else. One message
per item so each is its own thread; `#n` numbers global and never reused; kinds
`blocked | asked | urgent | proposal | draft`; raised once per record and kind; a
re-raise once after a configured interval; replies matched by thread or a leading number;
a register as jsonl with hashes and ids, never text. If the conversation is unwritable
the item is logged and retried, never sent to a shared space.

## The record

The shared sheets `opsbot-record` installs, all markdown with frontmatter unless noted:

| Sheet | Path | Status |
| --- | --- | --- |
| `requests` | `<status>/<scope>/<id>` | `new → open → waiting → ready → done`, or `declined`; `kind` includes `promise`; `next_move ∈ bot | operator | asker | someone-else` |
| `deliveries` (TOML) | `<scope>/<date>-<id>` | — |
| `proposals` | `<status>/P-nnn` | `draft → proposed → refining → approved → built`, or `declined | parked`; written only by the propose tool; a limitation at two occurrences triggers one |
| `decisions` | `D-nnn` | — |
| `limitations` | `L-nnn` | — |

Rules: a record changes when its state changes; status is a folder; one sweep, one commit
per sheet; pointers not copies; people by id; `open_question` on every markdown sheet;
written through the sheet tool; ids for life. Promises are requests, so due-ness is
computed by the cycle, never remembered. A bot's principal-specific sheets (people,
accounts, clips, tasks) are its own.

## Staying alive

- **Listener.** An always-on process per channel that needs one: watches for a mention,
  a reply to the bot, or a gate word; reacts with the bot's mark within seconds (the
  acknowledgement no model is needed for); appends to a mentions log; wakes the loop
  through the nudge, never through a session-bound monitor.
- **Watchdog** (system timer, every 10 minutes): if no cycle has logged within the limit,
  escalates once per outage with what it can see (rebase, lock held, agent missing),
  records the outage, and records its end when cycles resume.
- **Nudge** (system timer, offset from the watchdog): if the loop is quiet past the
  threshold, no lock is held, it has not nudged recently, and the runtime reports the
  agent idle, it re-issues the loop prompt. The nudge is the only thing that restarts the
  loop.
- **Runtime adapter.** The session must be addressable (a named agent in a multiplexer)
  for the nudge to work. The adapter is one setting; the first one is herdr.

## Settings

One committed file per bot holds: the mark; the gate word; conversations with postures
(`post | answer | read | ignore | notify`) and the escalation conversation; streams and
their adapters; the cadence table with working and night hours; the reply posture; the
autocompact window; the repo-sync policy (`pull-on-clean` for a repo other humans
commit to, `never-pull` for a single writer); the runtime adapter and agent name; the
loop prompt. Nothing about the account the bot speaks from is scattered through scripts.

## Divergences resolved

| Mechanism | Campaign bot | Support-desk bot | Kit | Why |
| --- | --- | --- | --- | --- |
| Check | one script per stream, each its own exit code | one script, all streams | one script | one degraded verdict; the model never has to read seven results |
| Intake state | per-stream seen files in a cache dir | committed under `logs/intake/` | committed | survives a user or machine move; auditable; the cache-only state was what the identity migration lost |
| Cadence | inside the check | a separate script reading the log | separate | testable; the table is config |
| Cycle close | a stamp with free text, watermark = now | `cycle-end`, watermark = check start | `cycle-end` | closes the mid-cycle-arrival gap; the summary stays as an optional field |
| Lock | prose | git-dir lock with abandonment rules | lock | "one committing agent" failed in practice |
| Compaction | pack file + deny-until-read gate | inline hook output under a size budget | gate + budget + broad matcher | the gate exists because truncated hook output went unread |
| Send override | `--force` | none | none | an escape hatch gets used under load |
| Gate word | regex + prose | shared definition + ten-condition judge + record | judge | a quoted or ambiguous word must not approve anything |
| Escalation register | a prose section | numbered jsonl with re-raise and matching | jsonl | due-ness and replies computed |
| Promises | a prose "owes" block | requests of kind promise, `--due-now` | requests | the cycle shows what is due |
| Proposals | none | sheet + two-occurrence trigger | sheet | the self-change gate |
| Liveness | in-session cron or monitor | system watchdog + nudge | system timers | ~100 hours lost to loops that re-armed themselves |
| Fast wake | listener with reaction ack + session monitor | none (site probe only) | listener → nudge | instant ack without the model; wake survives the session |
| Launch | bare session | named agent in a multiplexer | named agent | the nudge needs an address |
| Repo sync | pull on clean, warn on stop | never pull | a setting | depends on how many humans commit |
| Postures | five, incl. `answer` and `notify` | `post | read-only | ignore` | five | the richer set covers both |

## Deliberately per-bot

Persona and rule-card contents; which principal sheets exist; which channels are
installed; the cadence hours; the gate word; whether other humans commit to the repo;
every tool in `bin/` written for a particular ask.

## Drift this synthesis found

Recorded so the extraction fixes it rather than copying it: an autocompact window set in
two places with two values; a timer interval documented at one value and installed at
another; a listener described in a spec and present in no script; a heartbeat cited and
defined nowhere; a stale clone whose listener unit is inactive. Each is the same lesson:
a value set in one place, read everywhere.
