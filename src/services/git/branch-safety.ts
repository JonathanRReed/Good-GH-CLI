import { run } from "../../utils/exec.ts";
import { projectPath } from "../projects/discovery.ts";
import { inventoryGitOptions, gitLine } from "../projects/git.ts";
import { worktreeList } from "./worktree.ts";

type BranchSnapshot = { commonDir: string; branch: string; tip: string; baseTip: string };
export type BranchDeletionProof =
  | ({ outcome: "delete" } & BranchSnapshot)
  | ({ outcome: "keep"; reason: "unmerged" } & BranchSnapshot)
  | { outcome: "keep"; reason: "checked-out" | "unpublished" | "unknown" };

/** Shared conservative classifier for sync pruning and future tidy actions. */
export async function classifyBranchDeletion(branch: string, base: string, cwd = process.cwd()): Promise<BranchDeletionProof> {
  try {
    const query = (args: string[]) => run("git", args, { ...inventoryGitOptions, cwd });
    await query(["check-ref-format", `refs/heads/${branch}`]);
    const commonDir = projectPath(gitLine((await query(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout));
    const tip = gitLine((await query(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).stdout);
    if ((await worktreeList(cwd, inventoryGitOptions)).some(checkout => checkout.branch === branch)) return { outcome: "keep", reason: "checked-out" };
    const unpublished = (await query(["rev-list", "--max-count=1", tip, "--not", "--remotes"])).stdout;
    if (unpublished) return { outcome: "keep", reason: "unpublished" };
    const baseTip = gitLine((await query(["rev-parse", "--verify", `refs/heads/${base}^{commit}`])).stdout);
    const merged = await run("git", ["merge-base", "--is-ancestor", tip, baseTip], { ...inventoryGitOptions, cwd, reject: false });
    if (merged.exitCode === 1) return { outcome: "keep", reason: "unmerged", commonDir, branch, tip, baseTip };
    if (merged.exitCode !== 0) return { outcome: "keep", reason: "unknown" };
    return { outcome: "delete", commonDir, branch, tip, baseTip };
  } catch { return { outcome: "keep", reason: "unknown" }; }
}

/** Force only relaxes merge proof; it never overrides publication or checkout guards. */
export async function deleteGoneBranch(branch: string, base: string, force = false, cwd = process.cwd(), expected?: BranchSnapshot): Promise<void> {
  const refs = await run("git", ["for-each-ref", "--format=%(refname)%00%(upstream:track)", `refs/heads/${branch}`], { ...inventoryGitOptions, cwd });
  if (!refs.stdout.split("\n").some(line => { const [ref, tracking] = line.split("\0"); return ref === `refs/heads/${branch}` && tracking === "[gone]"; })) throw new Error(`Keep ${branch}: upstream is no longer gone`);
  const proof = await classifyBranchDeletion(branch, base, cwd);
  if (proof.outcome === "keep" && !(force && proof.reason === "unmerged")) throw new Error(`Keep ${branch}: ${proof.reason}`);
  if (expected && (!("tip" in proof) || proof.tip !== expected.tip || proof.baseTip !== expected.baseTip || proof.commonDir !== expected.commonDir)) throw new Error(`Keep ${branch}: deletion proof changed`);
  await run("git", ["branch", force ? "-D" : "-d", "--", branch], { ...inventoryGitOptions, cwd });
}
