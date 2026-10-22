import { run } from "../../utils/exec.ts";
import { inventoryGitOptions, projectGit } from "./git.ts";
import type { Checkout } from "./types.ts";

export const REFLOG_LIMIT = 1000;
export interface ReflogWork { commits: string[]; truncated: boolean }
/** Read the worktree gitdir directly so missing checkout paths retain protection. */
export async function reflogWork(commonDir: string, target: { branch: string } | { checkout: Checkout }, onlyOrphaned = false, checkoutHeads: string[] = []): Promise<ReflogWork> {
  const gitDir = "branch" in target ? commonDir : target.checkout.gitDir;
  const ref = "branch" in target ? `refs/heads/${target.branch}` : "HEAD";
  const prefix = ["--git-dir", gitDir];
  const exists = await run("git", [...prefix, "reflog", "exists", ref], { ...inventoryGitOptions, cwd: commonDir, reject: false });
  if (exists.exitCode === 1) return { commits: [], truncated: false };
  if (exists.exitCode !== 0) throw new Error("Cannot inspect reflog; keep unpublished state unknown");
  const entries = (await projectGit(commonDir, [...prefix, "reflog", "show", `-n${REFLOG_LIMIT + 1}`, "--format=%H", ref, "--"])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (entries.some(oid => !/^[a-f0-9]{40,64}$/.test(oid))) throw new Error("Cannot parse reflog commit identity");
  const truncated = entries.length > REFLOG_LIMIT;
  const tips = [...new Set(entries.slice(0, REFLOG_LIMIT))];
  if (!tips.length) return { commits: [], truncated };
  const output = await projectGit(commonDir, ["--no-replace-objects", "rev-list", ...tips, "--not", "--remotes", ...onlyOrphaned ? ["--all", ...checkoutHeads] : [], "--"]);
  return { commits: output.stdout.trim().split(/\r?\n/).filter(Boolean), truncated };
}
export async function protectReflog(commonDir: string, target: Parameters<typeof reflogWork>[1]): Promise<void> {
  const work = await reflogWork(commonDir, target);
  if (work.commits.length) throw new Error(`reflog holds ${work.commits.length} unpublished commits (last ${REFLOG_LIMIT} entries scanned)`);
  if (work.truncated) throw new Error(`reflog scan exceeds ${REFLOG_LIMIT} entries; unpublished history unknown`);
}
