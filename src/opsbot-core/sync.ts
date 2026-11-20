/**
 * `repo_sync: pull` (specs/behaviors/log-branch.md, "What this removes"): with nothing of the
 * loop's in the working tree, `cycle begin` fast-forwards the checkout itself. A checkout that is
 * behind and clean moves to its remote's head. One that cannot (a person's unpushed work, a
 * diverged branch, uncommitted changes) is a heartbeat item naming both commits, keyed by the
 * remote's head so it is said once per change, and the cycle goes on with what it has.
 */
import { git, nowIso, run } from "./repo.js";

const FETCH_TIMEOUT_MS = 60_000;

export interface SyncResult {
  /** HEAD moved: the program changed under the loop. */
  moved: boolean;
  /** The item to report when the checkout cannot fast-forward. */
  item: { key: string; at: string; conv: string; kind: string; from: string; text: string } | null;
  /** Why nothing was compared (no remote, the fetch failed); said on the cycle's line. */
  why: string | null;
}

const short = (h: string) => h.slice(0, 12);

export function repoSync(root: string): SyncResult {
  const none: SyncResult = { moved: false, item: null, why: null };
  const b = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (b.code !== 0) return none; // a detached checkout follows nothing
  const branch = b.stdout.trim();
  if (git(root, ["remote", "get-url", "origin"]).code !== 0) return none;
  const f = run("git", ["-C", root, "fetch", "-q", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: FETCH_TIMEOUT_MS });
  if (f.code !== 0) {
    const err = f.stderr.split("\n").filter((l) => l.trim()).pop() ?? `exit ${f.code}`;
    // a remote without this branch has nothing to follow
    if (/couldn't find remote ref/i.test(f.stderr)) return none;
    return { ...none, why: `fetch failed: ${err.slice(0, 120)}` };
  }
  const head = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const theirs = git(root, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]).stdout.trim();
  if (!head || !theirs || head === theirs) return none;
  // ahead only: the cycle's own push sends it
  if (git(root, ["merge-base", "--is-ancestor", theirs, head]).code === 0) return none;
  const behind = git(root, ["merge-base", "--is-ancestor", head, theirs]).code === 0;
  let reason: string;
  if (behind) {
    // porcelain lines are `XY path`: a leading space is part of the line
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).stdout.split("\n").filter((l) => l.trim());
    if (dirty.length === 0) {
      const m = git(root, ["merge", "--ff-only", "-q", theirs]);
      if (m.code === 0) return { moved: true, item: null, why: null };
      reason = `the fast-forward failed: ${(m.stderr.split("\n").find((l) => l.trim()) ?? `exit ${m.code}`).trim().slice(0, 160)}`;
    } else {
      const n = dirty.length;
      reason = `${n} file${n === 1 ? " has" : "s have"} uncommitted changes (${dirty.slice(0, 3).map((l) => l.slice(3)).join(", ")}${n > 3 ? ", …" : ""})`;
    }
  } else {
    reason = "the two have diverged (commits here that the remote does not have)";
  }
  const text = `The checkout cannot fast-forward to its remote: ${branch} is at ${short(head)} here and ${short(theirs)} on origin; ${reason}. The cycle goes on with the program at ${short(head)}. A person resolves it (commit, push or rebase); it is said again only when origin/${branch} moves.`;
  return {
    moved: false,
    item: { key: `repo-sync:${theirs}`, at: nowIso(), conv: "repo", kind: "repo-sync", from: "opsbot-core", text },
    why: null,
  };
}
