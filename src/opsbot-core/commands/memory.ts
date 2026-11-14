/**
 * memory — the bot's Claude Code auto memory, kept in its repo (specs/skills/opsbot-core.md,
 * Auto memory).
 *
 *   memory status                       counts, sizes, the oldest unreviewed file, the last
 *                                       review, whether one is due
 *   memory review --begin               snapshot the directory; print the worksheet and protocol
 *   memory review --done [--note TEXT]  diff against the snapshot; log a memory-review line
 *   memory import <path> [--dry-run]    bring notes in from another directory, never overwriting
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parseArgs, setExit, usageError } from "../args.js";
import { cliInvocation, skillDir } from "../invocation.js";
import { nowIso, nowMs, requireRoot } from "../repo.js";
import { loadSettings, trySettings, type Settings } from "../settings.js";
import { appendJsonl, paths } from "../state.js";
import { writeRun } from "../routine-store.js";
import {
  MEMORY_INDEX,
  MEMORY_ROUTINE,
  memoryOverride,
  REVIEW_OUTCOME,
  ageText,
  clearSnapshot,
  listMemory,
  memoryDir,
  memoryStatus,
  readSnapshot,
  reviewCounts,
  writeSnapshot,
} from "../memory.js";

export const MEMORY_USAGE = "memory status | memory review --begin | memory review --done [--note TEXT] | memory import <path> [--dry-run]";
const GUIDE = "references/memory-review.md";
const PACK_SECTION = "references/pack/50-memory.md";

function settingsFor(root: string): Settings {
  // the committed settings when they validate; the working tree's otherwise (a new bot)
  try {
    return loadSettings(root).settings;
  } catch (e) {
    const s = trySettings(root);
    if (s) return s;
    throw e;
  }
}

function requireMemory(root: string, s: Settings): string {
  const dir = memoryDir(root, s);
  if (!dir) {
    setExit(1);
    throw new AxiError("auto memory is off for this bot (memory: false in opsbot.json)", "REFUSED", [
      "Remove `memory: false` from opsbot.json, commit it, and restart with `start --continue` to turn it on",
    ]);
  }
  return dir;
}

export function memoryCommand(args: string[]): Record<string, unknown> {
  const [sub, ...rest] = args;
  if (sub === "status") return status(rest);
  if (sub === "review") return review(rest);
  if (sub === "import") return importCommand(rest);
  throw usageError(sub ? `unknown memory subcommand ${sub}` : "memory needs a subcommand", MEMORY_USAGE);
}

function status(args: string[]): Record<string, unknown> {
  parseArgs(args, {}, "memory status");
  const root = requireRoot();
  const s = settingsFor(root);
  requireMemory(root, s);
  const now = nowMs();
  const st = memoryStatus(root, s, now)!;
  setExit(0);
  const out: Record<string, unknown> = {
    memory: `${s.memory!.dir}/ · ${st.files.length} file${st.files.length === 1 ? "" : "s"} · ${st.bytes} bytes`,
    index: st.index ? `${MEMORY_INDEX} · ${st.index.bytes} bytes · ${st.index.lines} lines` : `no ${MEMORY_INDEX}`,
    oldest_unreviewed: st.oldest_unreviewed_ms === null ? "none" : `${ageText(st.oldest_unreviewed_ms)} (${st.unreviewed.length} unreviewed)`,
    last_review: st.last_review ?? "never",
    review: st.due ? `due: ${st.why}` : `not due: ${st.why}`,
  };
  if (st.due) out.help = [`Run \`${cliInvocation()} memory review --begin\` for the worksheet`];
  return out;
}

/** The protocol as the pack section has it: the shipped file, comment and title dropped. */
function protocolLines(): string[] {
  const dir = process.env.OPSBOT_PACK_DIR || join(skillDir(), "references", "pack");
  const f = join(dir, "50-memory.md");
  const alt = join(skillDir(), PACK_SECTION);
  const file = existsSync(f) ? f : existsSync(alt) ? alt : null;
  if (!file) return [`(the protocol is in ${join(skillDir(), GUIDE)})`];
  // one entry per paragraph or list item, its wrapped lines joined
  const items: string[] = [];
  let cur: string | null = null;
  const body = readFileSync(file, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "").replace(/^#\s+.+\n+/m, "");
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) { if (cur !== null) items.push(cur); cur = null; continue; }
    if (t.startsWith("- ") || cur === null) { if (cur !== null) items.push(cur); cur = t; }
    else cur += ` ${t}`;
  }
  if (cur !== null) items.push(cur);
  return items;
}

function review(args: string[]): Record<string, unknown> {
  const usage = "memory review --begin | memory review --done [--note TEXT]";
  const { flags } = parseArgs(args, { bool: ["begin", "done"], value: ["note"] }, usage);
  if (!!flags.begin === !!flags.done) throw usageError("give exactly one of --begin or --done", usage);
  if (flags.begin && flags.note !== undefined) throw usageError("--note goes with --done", usage);
  const root = requireRoot();
  const s = settingsFor(root);
  const dir = requireMemory(root, s);
  const now = nowMs();
  const cli = cliInvocation();
  setExit(0);

  if (flags.begin) {
    const st = memoryStatus(root, s, now)!;
    const replaced = readSnapshot(root) !== null;
    writeSnapshot(root, { at: nowIso(), dir: s.memory!.dir, files: Object.fromEntries(st.files.map((f) => [f.name, f.sha])) });
    const unreviewed = new Set(st.unreviewed.map((f) => f.name));
    const out: Record<string, unknown> = {
      review: `begun · ${st.files.length} file${st.files.length === 1 ? "" : "s"} in ${s.memory!.dir}/ · last review ${st.last_review ?? "never"}${replaced ? " · replaced an earlier snapshot" : ""}`,
      files: st.files.length
        ? st.files.map((f) => ({
            name: f.name,
            type: f.type ?? "",
            bytes: f.bytes,
            age: f.changed === null ? "unknown" : ageText(now - f.changed),
            changed_since_review: unreviewed.has(f.name) ? "yes" : "no",
          }))
        : "0 memory files: nothing to review",
      index: st.index ? `${MEMORY_INDEX} · ${st.index.lines} lines · ${st.index.bytes} bytes` : `no ${MEMORY_INDEX}`,
      protocol: protocolLines(),
      guide: join(skillDir(), GUIDE),
      help: [`For each file: fold, update, keep or prune; then run \`${cli} memory review --done --note "<what was folded where>"\``],
    };
    return out;
  }

  const snap = readSnapshot(root);
  if (!snap) {
    setExit(1);
    throw new AxiError("no review has begun: there is no snapshot to compare with", "REFUSED", [`Run \`${cli} memory review --begin\` first`]);
  }
  const c = reviewCounts(snap, listMemory(root, dir));
  const note = typeof flags.note === "string" ? flags.note : undefined;
  const at = nowMs();
  const line: Record<string, unknown> = { at: nowIso(), outcome: REVIEW_OUTCOME, files: c.files, kept: c.kept, updated: c.updated, removed: c.removed, added: c.added };
  if (note !== undefined) line.note = note;
  const counts = `${c.files} reviewed · kept ${c.kept} · updated ${c.updated} · removed ${c.removed} (folded or pruned) · added ${c.added}`;
  // the review is a run of the memory-review routine; the cycle-log line stays for the counts
  const run = writeRun(root, s, {
    routine: MEMORY_ROUTINE,
    title: memoryOverride(root, s)?.title ?? "Review the memory files",
    atMs: at,
    outcome: "done",
    by: s.name,
    notes: note !== undefined ? `${note}\n\n${counts}` : counts,
    checked: [],
    handed_to: null,
  });
  appendJsonl(paths(root).log, line);
  clearSnapshot(root);
  const out: Record<string, unknown> = {
    review: `done · ${counts}`,
    logged: `a run of the ${MEMORY_ROUTINE} routine (${run.file}) and a memory-review line in the cycle log, committed with the next cycle`,
  };
  if (note === undefined && c.removed > 0) out.help = ["Next time add --note saying what was folded where: the counts cannot tell a fold from a prune"];
  return out;
}

// ------------------------------------------------------------ import

/** The link target of an index line (`- [Title](file.md) — hook`), when it has one. */
export function indexTarget(line: string): string | null {
  const m = line.match(/\]\(([^)\s]+)\)/);
  return m ? m[1]!.replace(/^\.\//, "") : null;
}

export interface ImportPlan {
  copy: string[];
  same: string[];
  clashes: string[];
  skipped: string[];
  indexAdd: string[];
  indexSkipped: string[];
}

/** What importing `src` into `dest` would do; writes nothing. Reads only `src` and `dest`. */
export function planImport(src: string, dest: string): ImportPlan {
  const plan: ImportPlan = { copy: [], same: [], clashes: [], skipped: [], indexAdd: [], indexSkipped: [] };
  for (const e of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === MEMORY_INDEX) continue;
    if (e.name.startsWith(".") || !e.isFile()) {
      plan.skipped.push(e.name);
      continue;
    }
    const to = join(dest, e.name);
    if (!existsSync(to)) plan.copy.push(e.name);
    else if (statSync(to).isFile() && readFileSync(to).equals(readFileSync(join(src, e.name)))) plan.same.push(e.name);
    else plan.clashes.push(e.name);
  }
  const srcIdx = join(src, MEMORY_INDEX);
  if (existsSync(srcIdx)) {
    const destIdx = join(dest, MEMORY_INDEX);
    const have = existsSync(destIdx) ? readFileSync(destIdx, "utf8").split("\n") : [];
    const haveLines = new Set(have.map((l) => l.trim()).filter(Boolean));
    const haveTargets = new Set(have.map(indexTarget).filter((t): t is string => t !== null));
    const clash = new Set(plan.clashes);
    for (const raw of readFileSync(srcIdx, "utf8").split("\n")) {
      const l = raw.trimEnd();
      if (!l.trim()) continue;
      const t = indexTarget(l);
      if (haveLines.has(l.trim()) || (t !== null && haveTargets.has(t))) continue;
      if (t !== null && clash.has(t)) {
        plan.indexSkipped.push(l);
        continue;
      }
      plan.indexAdd.push(l);
      haveLines.add(l.trim());
      if (t !== null) haveTargets.add(t);
    }
  }
  return plan;
}

function importCommand(args: string[]): Record<string, unknown> {
  const usage = "memory import <path> [--dry-run]";
  const { positionals, flags } = parseArgs(args, { bool: ["dry-run"], maxPositionals: 1 }, usage);
  if (!positionals[0]) throw usageError("give the directory to import from", usage);
  const root = requireRoot();
  const s = settingsFor(root);
  const dest = requireMemory(root, s);
  const src = resolve(positionals[0].replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    setExit(1);
    throw new AxiError(`${src} is not a directory`, "REFUSED", ["Give the memory directory to import, such as ~/.claude/projects/<project>/memory"]);
  }
  if (resolve(src) === resolve(dest)) {
    setExit(1);
    throw new AxiError(`${src} is the bot's own memory directory`, "REFUSED", ["Give the old directory to import from"]);
  }
  const plan = planImport(src, dest);
  const dry = flags["dry-run"] === true;
  if (!dry) {
    mkdirSync(dest, { recursive: true });
    for (const f of plan.copy) copyFileSync(join(src, f), join(dest, f));
    if (plan.indexAdd.length) {
      const destIdx = join(dest, MEMORY_INDEX);
      const cur = existsSync(destIdx) ? readFileSync(destIdx, "utf8") : "";
      mkdirSync(dirname(destIdx), { recursive: true });
      writeFileSync(destIdx, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${plan.indexAdd.join("\n")}\n`);
    }
  }
  setExit(0);
  const out: Record<string, unknown> = {
    import: `${dry ? "would copy" : "copied"} ${plan.copy.length} · already there ${plan.same.length} · clashes ${plan.clashes.length} · index lines ${dry ? "to add" : "added"} ${plan.indexAdd.length}${dry ? " · dry run: nothing written" : ""}`,
    from: src,
    to: dest,
  };
  if (plan.copy.length) out.copied = plan.copy;
  if (plan.clashes.length) out.clashes = plan.clashes.map((f) => `${f}: a different file of that name is already there; left out, with its index line`);
  if (plan.skipped.length) out.skipped = plan.skipped.map((f) => `${f}: not a plain file`);
  out.help = dry
    ? [`Run \`${cliInvocation()} memory import ${positionals[0]}\` to copy`]
    : [`The next cycle commits them; then run \`${cliInvocation()} memory review --begin\` to review what came in`];
  return out;
}
