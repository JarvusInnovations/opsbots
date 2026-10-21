/**
 * The machine-maintained regions of skills/opsbot-core/SKILL.md, derived from
 * the same COMMAND_GROUPS the CLI prints. Prose outside the markers is
 * hand-written and never touched. Inside SKILL.md the CLI is documented by its
 * path relative to the skill directory, since it is not on PATH.
 */
import { COMMAND_GROUPS } from "./reference.js";

const SKILL_INVOCATION = "scripts/opsbot-core";

export function commandReferenceMarkdown(): string {
  return COMMAND_GROUPS.map((group) => {
    const items = group.commands.map((c) => `- \`${SKILL_INVOCATION} ${c.usage}\` — ${c.summary}`).join("\n");
    return `### ${group.group}\n\n${items}`;
  }).join("\n\n");
}

export const GENERATED_REGIONS: Record<string, () => string> = {
  "command-reference": commandReferenceMarkdown,
};

/** Splice each region between its markers; throws when a declared region's markers are missing. */
export function spliceGeneratedRegions(doc: string, regions: Record<string, () => string> = GENERATED_REGIONS): string {
  let out = doc;
  for (const [id, generate] of Object.entries(regions)) {
    const begin = `<!-- BEGIN GENERATED: ${id} -->`;
    const end = `<!-- END GENERATED: ${id} -->`;
    const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`);
    if (!pattern.test(out)) throw new Error(`SKILL.md is missing the generated region markers for "${id}"`);
    out = out.replace(pattern, () => `${begin}\n\n${generate().trim()}\n\n${end}`);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
