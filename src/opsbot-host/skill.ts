import { COMMAND_GROUPS } from "./reference.js";
import { spliceGeneratedRegions as splice } from "../opsbot-core/skill.js";

const SKILL_INVOCATION = "scripts/opsbot-host";

export function commandReferenceMarkdown(): string {
  return COMMAND_GROUPS.map((g) => `### ${g.group}\n\n${g.commands.map((c) => `- \`${SKILL_INVOCATION} ${c.usage}\` — ${c.summary}`).join("\n")}`).join("\n\n");
}

export function spliceOpsbotHost(doc: string): string {
  return splice(doc, { "command-reference": commandReferenceMarkdown });
}
