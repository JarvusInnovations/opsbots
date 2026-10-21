/**
 * Splice the generated regions (the command reference) into each skill's
 * hand-written SKILL.md. Prose outside the markers is never touched.
 *
 *   bun scripts/build-skill.ts            # rewrite the SKILL.md files
 *   bun scripts/build-skill.ts --check    # fail if any is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spliceGeneratedRegions as spliceOpsbotCore } from "../src/opsbot-core/skill.js";

interface SkillTarget {
  path: string;
  splice: (doc: string) => string;
}

const TARGETS: SkillTarget[] = [{ path: "skills/opsbot-core/SKILL.md", splice: (d) => spliceOpsbotCore(d) }];

const check = process.argv.includes("--check");
let stale = false;
for (const { path, splice } of TARGETS) {
  const src = readFileSync(path, "utf8");
  const out = splice(src);
  if (check) {
    if (src !== out) {
      console.error(`${path} is out of date — run \`bun run build:skill\` and commit the result`);
      stale = true;
    } else console.log(`${path} is up to date`);
  } else if (src !== out) {
    writeFileSync(path, out);
    console.log(`Updated ${path}`);
  } else console.log(`${path} already up to date`);
}
if (stale) process.exit(1);
