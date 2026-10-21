# opsbots

A kit for standing up and running **ops bots**: long-running agents that sit inside a
group's chat, keep the record of what was asked, promised, decided and delivered, draft
the work, and act only when a named human says the word. Built from running several of
them; every rule here was earned by one of them failing.

Two kinds of skill, installed with the [`skills`](https://skills.sh/) CLI:

- **`opsbot-*`** — what a bot needs: its loop, its record, its persona, its channel
  guards. *(Coming as each is extracted from a running bot.)*
- **`mothership`** — what an operator needs to run a fleet of them: the fleet sheets
  (bots, hosts, incidents, lessons) and, later, the mechanic that examines bots from the
  outside and feeds what it learns back into the kit.

```bash
npx skills add JarvusInnovations/opsbots --skill mothership
```

A repo becomes a mothership by installing that one skill. There can be many motherships;
each tracks its own fleet. This kit is the product; a mothership is an instance.

## Layout

| Path | What |
| --- | --- |
| `skills/<name>/` | Installable skills. Each has its own README. |
| `specs/` | What must be true of the kit (spec-driven; see `CLAUDE.md`) |
| `plans/` | Work in flight |

## Principles, in one breath

The record beats the session. A guard in code beats a rule in prose. Look before saying.
Not-yet-known is an answer. Answer fast, finish later. The bot speaks as itself and says
it is AI. A failed check is said out loud. The bot asks before it changes itself.

Full statements with their reasons: [`specs/principles.md`](specs/principles.md).

## License

MIT. This kit is public so that anyone, including volunteer and civic efforts, can use
it on the same terms.
