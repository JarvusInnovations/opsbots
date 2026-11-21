/**
 * What the log files left behind, in one place (plans/log-branch-migrate.md). Before the log
 * branch the loop wrote its log to files in the working tree and committed them with the
 * program; this release has no file writer. These names exist so `log migrate` can read the
 * files, so a checkout still set up for them is refused rather than written, and so the old
 * settings are named with the command that removes them. Nothing else in the kit names them.
 */
import { cliInvocation } from "./invocation.js";
import { git, showHead } from "./repo.js";

/** The kit's own log files: the cycle log (outage lines too, in an older bot's), outages, the
 * seen keys and the watermark. */
export const OLD_CYCLE_LOG = "logs/cycle.jsonl";
export const OLD_OUTAGES = "logs/outages.jsonl";
export const OLD_SEEN = "logs/intake/seen";
export const OLD_WATERMARK = "logs/intake/watermark";
export const OLD_KIT_FILES = [OLD_CYCLE_LOG, OLD_OUTAGES, OLD_SEEN, OLD_WATERMARK];
/** Where routine runs were written when `routines.runs_dir` was not set. */
export const OLD_RUNS_DIR = "records/routine-runs";
/** The post logs' default files, by channel, when `streams.<channel>.post_log` was not set. */
export const OLD_POST_LOGS: Record<string, string> = { slack: "logs/slack-posts.jsonl", whatsapp: "logs/whatsapp-posts.jsonl" };
/** The setting that listed a bot's own files to commit with each cycle. */
export const OLD_PATHS_KEY = "commit_paths";
/** Top-level keys opsbot.json may still carry so that they are refused by name, not as unknown. */
export const OLD_TOP_KEYS = [OLD_PATHS_KEY];

/** Why the checkout at HEAD is still set up for the log files, or null when it is not: the old
 * setting in opsbot.json, or one of the kit's log files tracked. Two git calls at most. */
export function oldSetup(root: string, settingsAtHead?: string | null): string | null {
  const text = settingsAtHead !== undefined ? settingsAtHead : showHead(root, "opsbot.json");
  if (text !== null) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && v[OLD_PATHS_KEY] !== undefined) return `opsbot.json sets ${OLD_PATHS_KEY}`;
      // an explicit log.branch is the migration's own mark (or a bot that opted in): the log is
      // on the branch, and any file left behind is dead
      if (v && typeof v === "object" && v.log && typeof v.log === "object" && typeof v.log.branch === "string" && v.log.branch) return null;
    } catch {
      // settings that cannot be read are refused by loadSettings
    }
  }
  const r = git(root, ["ls-tree", "--name-only", "HEAD", "--", ...OLD_KIT_FILES]);
  const tracked = r.code === 0 ? r.stdout.split("\n").map((x) => x.trim()).filter(Boolean) : [];
  return tracked.length ? `${tracked.join(", ")} ${tracked.length === 1 ? "is" : "are"} tracked` : null;
}

/** The settings validation's word on what only the log files needed. */
export function oldSettingProblems(raw: Record<string, unknown>): string[] {
  const cli = cliInvocation();
  const out: string[] = [];
  if (raw[OLD_PATHS_KEY] !== undefined) {
    out.push(`${OLD_PATHS_KEY} is gone: the loop's log is written only to the log branch now; run \`${cli} log migrate --dry-run\`, then \`${cli} log migrate\`, which moves every file it lists there and prepares the commit that removes it`);
  }
  const r = raw.routines;
  if (r && typeof r === "object" && !Array.isArray(r) && (r as Record<string, unknown>).runs_dir !== undefined) {
    out.push(`routines.runs_dir is gone: routine runs are records of the log branch's routines sheet; \`${cli} log migrate\` moves the runs there and removes the setting`);
  }
  if (raw.repo_sync === "pull-on-clean" || raw.repo_sync === "never-pull") {
    out.push(`repo_sync ${JSON.stringify(raw.repo_sync)} is now ${JSON.stringify(raw.repo_sync === "never-pull" ? "never" : "pull")} (pull or never); \`${cli} log migrate\` rewrites it`);
  }
  return out;
}
