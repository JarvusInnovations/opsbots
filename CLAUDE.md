# opsbots kit

This is the public kit for ops bots and motherships. It is **public**: nothing here names
a client, a principal, a person, a host, a phone number, or an instance of a running bot.
Lessons are written generically ("a campaign bot", "a support-desk bot"). Instance data
lives in each mothership, never here.

## Spec-driven development (specops)

This project uses spec-driven development. `specs/` is the source of truth for what
*should be true*; `plans/` is the work-in-flight DAG that bridges specs to merged code.
The **specops** skill carries the full methodology — invoke it (the skill triggers on
"spec", "plan", starting a feature, etc.) before writing specs, planning, or building.

- **Specs lead.** Before changing behavior, change the spec; bring code into conformance
  after. Specs merge implemented-or-planned; a spec still being designed rides a draft
  planning PR, not `develop`.
- **`plans/` is the planning system — not your built-in plan mode.** Every chunk of work
  lands as a file in `plans/` that freezes to `done`.
- **When to author a plan depends on intent:** mapping out a batch of specs → finish the
  batch first, then propose a *set* of plans; one bounded feature → spec change and plan
  in tandem; unclear → ask.
- **A spec change ripples to its plans** (`grep -l '<spec-path>' plans/*.md`).

Query the DAG: `.agents/skills/specops/scripts/specops next` and `... dag`.

## House rules

- `develop` is the default branch; `main` is the release target; merge commits only.
- Skills follow the `skills` CLI layout: `skills/<name>/SKILL.md` plus a README.
- A skill that bundles a CLI follows the `axi` and `axi-skills` conventions.
