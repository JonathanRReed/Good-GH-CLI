import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commit, type CommitOptions } from "../git.ts";
import { assertWindowsPrivateDirectory } from "../private-storage.ts";
import { getFlags } from "../runtime.ts";
import { run } from "../../utils/exec.ts";
import type { StagedSnapshot } from "./split.ts";

async function commitIdentity(cwd: string) {
  const [head, branch] = await Promise.all([
    run("git", ["rev-parse", "--verify", "HEAD"], { cwd, reject: false }),
    run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, reject: false }),
  ]);
  if (branch.exitCode !== 0 && branch.exitCode !== 1) throw new Error(branch.stderr || "Cannot read branch identity.");
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, branch: branch.exitCode === 0 ? branch.stdout.trim() : null };
}

/** Check hook results before any caller can publish or create another split commit. */
export async function commitExpectedTree(
  expected: Pick<StagedSnapshot, "cwd" | "head" | "branch" | "tree">,
  subject: string, body: string, options: CommitOptions,
): Promise<string> {
  const { cwd } = expected;
  const before = await commitIdentity(cwd);
  if (before.head !== expected.head || before.branch !== expected.branch) throw new Error("HEAD or branch changed after preview. Review the scope again.");
  const output = await commit(subject, body, { ...options, cwd });
  const after = await commitIdentity(cwd);
  if (!after.head) throw new Error("Git did not create a commit. Inspect HEAD before retrying.");
  const tree = (await run("git", ["rev-parse", `${after.head}^{tree}`], { cwd })).stdout.trim();
  if (tree !== expected.tree || after.branch !== expected.branch) {
    const recoveryRef = `refs/ggh/rejected/${after.head}`;
    await run("git", ["update-ref", recoveryRef, after.head], { cwd });
    // A compare-and-swap only restores our own rejected tip. Never reset files
    // or overwrite a concurrent ref update, even when a trusted hook misbehaves.
    if (after.branch === expected.branch) {
      await run("git", expected.head
        ? ["update-ref", expected.branch ?? "HEAD", expected.head, after.head]
        : ["update-ref", "-d", expected.branch ?? "HEAD", after.head], { cwd });
    }
    throw new Error(`A Git hook changed the planned commit contents or branch. Publication stopped. Rejected commit: ${recoveryRef}. Inspect git status; hook worktree edits were preserved.`);
  }
  return output;
}

/** Commit the previewed index without resetting it or reading worktree contents. */
export async function executeSnapshotCommit(snapshot: StagedSnapshot, subject: string, body = "", options: CommitOptions = {}): Promise<string> {
  if (getFlags().dryRun) throw new Error("Cannot execute a commit during a dry run.");
  const { cwd, indexPath } = snapshot;
  const lockPath = `${indexPath}.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  let checkpoint: string | undefined;
  let success = false;
  try {
    const identity = await commitIdentity(cwd);
    if (identity.head !== snapshot.head || identity.branch !== snapshot.branch || !readFileSync(indexPath).equals(snapshot.indexBytes)) {
      throw new Error("Repository or index changed after preview. Review the scope again; concurrent changes were preserved.");
    }
    const parent = join(dirname(indexPath), "ggh-commit");
    assertWindowsPrivateDirectory(parent); mkdirSync(parent, { recursive: true, mode: 0o700 });
    checkpoint = mkdtempSync(join(parent, "checkpoint-"));
    writeFileSync(join(checkpoint, "original-index"), snapshot.indexBytes, { mode: 0o600 });
    writeFileSync(join(checkpoint, "state.json"), JSON.stringify({ version: 1, originalHead: snapshot.head, branch: snapshot.branch, stagedTree: snapshot.tree }) + "\n", { mode: 0o600 });
    const temporaryIndex = join(checkpoint, "temporary-index");
    writeFileSync(temporaryIndex, snapshot.indexBytes, { mode: 0o600 });
    const output = await commitExpectedTree(snapshot, subject, body, { ...options, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    success = true;
    return output;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}` + (checkpoint ? `\nRecovery checkpoint: ${checkpoint}. The original index was not replaced.` : ""), { cause: error });
  } finally {
    closeSync(lock); if (existsSync(lockPath)) unlinkSync(lockPath);
    if (success && checkpoint) rmSync(checkpoint, { recursive: true, force: true });
  }
}
