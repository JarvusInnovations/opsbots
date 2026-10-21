---
name: mothership
description: Run a fleet of ops bots from one repo — the fleet sheets (bots, hosts, incidents, lessons) as installable gitsheets configs, the conventions for keeping them honest, and the home of the mechanic that examines bots from the outside. Use when setting up a mothership repo, registering a new bot, recording an incident or a lesson, or asking what is running where.
---

# mothership

A **mothership** is a repo that tracks a fleet of ops bots: what exists, where each runs,
on whose accounts, what broke, and what was learned. There can be many motherships. Each
tracks its own fleet; none tracks another's. This skill makes a repo one.

## Install

```bash
npx skills add JarvusInnovations/opsbots --skill mothership
```

Then copy the sheet configs into the repo's gitsheets directory and commit them before
writing any record (configs are read from the committed tree):

```bash
cp .agents/skills/mothership/sheets/*.toml .gitsheets/
git add .gitsheets && git commit -m "chore(mothership): install fleet sheets"
```

The configs store records under `fleet/`. Change `root` in each config if the mothership
keeps its fleet elsewhere (a mothership inside a larger repo may want
`<subdir>/fleet/...`).

## The sheets

| Sheet | One record is | Path |
| --- | --- | --- |
| `bots` | An ops bot, planned or running or retired | `fleet/bots/<status>/<id>.md` |
| `hosts` | A machine or environment bots run on, and who is on it | `fleet/hosts/<id>.toml` |
| `incidents` | One thing that went wrong, on one bot, on one day | `fleet/incidents/<I-nnn>.md` |
| `lessons` | A failure pattern generalized across bots, and what encodes the fix | `fleet/lessons/<LS-nnn>.md` |

Status is a folder on `bots`: what is live is one directory listing.

Read and write them with `gitsheets-axi` (`npx -y gitsheets-axi query bots`), never by
hand-serializing TOML. Markdown records carry state in frontmatter and narrative in the
body.

## Rules

- **A bot record changes when its state changes.** Seen running again is not a change.
- **Instance data stays in the mothership.** Names, numbers, hosts, principals are here.
  Anything that goes back to the public kit is a lesson written generically.
- **Every incident points at a lesson or says why not.** An incident with no lesson is an
  open question on the record, not a closed matter.
- **A lesson says what encodes it.** `encoded_in` names the kit skill and version that
  carries the guard, or the status is `open`.
- **Kit versions on the bot record.** `kit` lists each installed kit skill with its
  version so a mothership can see which bots are behind.
- **Not yet known has a field.** `open_question` on every markdown sheet.

## Registering a bot

1. `gitsheets-axi upsert bots` with at least `id`, `name`, `mark`, `status`, `principal`,
   `operator`, `repo`, `surfaces`, `account_shape`.
2. Add the host to `hosts` if new, and list the bot on it.
3. Note which kit skills it carries in `kit` (`[]` for a hand-built bot).

## Recording what broke

1. `incidents`: one record per occurrence, `bot`, `occurred`, `kind`, what it cost.
2. If it matches a known pattern, set `lesson` to that `LS-nnn`. If not, open a lesson
   or write `open_question`.
3. When a kit skill version carries the guard, set the lesson's `encoded_in` and
   `status: encoded`; bots whose `kit` is older are behind.

## The mechanic

TK. The mechanic is the agent that runs from a mothership, reads a bot's repo (never its
host user's home), correlates its limitations and cycle log, proposes fixes, and opens
upgrade PRs. It reads and proposes unasked; it merges, restarts or changes a bot's rules
only on the operator's gate word, recorded as a decision. Its spec is
`specs/mothership.md` in the kit.
