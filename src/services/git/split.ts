import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commit, type CommitOptions } from "../git.ts";
import { getFlags } from "../runtime.ts";
import { run } from "../../utils/exec.ts";
import type { ChangedFile } from "../../utils/diff.ts";
import { getGitPath } from "./paths.ts";

export interface SplitCommit {
  subject: string;
  body: string;
  files: string[];
}

interface IndexEntry { mode: string; oid: string }
export interface StagedSnapshot {
  cwd: string;
  indexPath: string;
  indexBytes: Buffer;
  head: string | null;
  branch: string | null;
  tree: string;
  files: ChangedFile[];
  entries: Map<string, IndexEntry>;
}

async function headAt(cwd: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Detached HEAD is a valid local commit target, not a symbolic-ref failure. */
async function branchAt(cwd: string): Promise<string | null> {
  const result = await run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, reject: false });
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw new Error(result.stderr.trim() || "Could not determine the current Git branch.");
}

/** Capture the staged tree before the model runs. Working-tree bytes are never read. */
export async function captureStagedSnapshot(cwd = process.cwd()): Promise<StagedSnapshot> {
  const indexPath = await getGitPath("index", cwd);
  const head = await headAt(cwd);
  const branch = await branchAt(cwd);
  const { stdout: tree } = await run("git", ["write-tree"], { cwd });
  const indexBytes = readFileSync(indexPath);
  const { stdout: listing } = await run("git", ["ls-files", "--stage", "-z"], { cwd });
  const { stdout: changed } = await run("git", ["diff", "--cached", "--no-renames", "--name-status", "-z"], { cwd });
  const entries = new Map<string, IndexEntry>();
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]*)$/.exec(record);
    if (!match || match[3] !== "0") throw new Error("Cannot split an unmerged index.");
    entries.set(match[4]!, { mode: match[1]!, oid: match[2]! });
  }
  const records = changed.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const [status, path] = [records[i], records[i + 1]];
    if (!status || !path) throw new Error("Invalid staged path listing.");
    files.push({ path, staged: true, status: status === "D" ? "deleted" : status === "A" ? "added" : "modified" });
  }
  if (!files.length) throw new Error("Nothing staged to split.");
  if (await branchAt(cwd) !== branch || await headAt(cwd) !== head || !readFileSync(indexPath).equals(indexBytes)) {
    throw new Error("Repository changed while capturing staged content. Retry the split.");
  }
  return { cwd, indexPath, indexBytes, head, branch, tree: tree.trim(), files, entries };
}

/** The model must partition exactly the allowed paths, not choose new files. */
export function validateSplitPlan(value: unknown, snapshot: StagedSnapshot): SplitCommit[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { commits?: unknown }).commits)) {
    throw new Error("Invalid AI split plan: expected commits.");
  }
  const input = (value as { commits: unknown[] }).commits;
  if (!input.length || input.length > snapshot.files.length) throw new Error("Invalid number of split commits.");
  const remaining = new Set(snapshot.files.map((file) => file.path));
  const commits: SplitCommit[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid split commit.");
    const item = entry as Record<string, unknown>;
    if (typeof item.subject !== "string" || !item.subject.trim() || /[\r\n\0]/.test(item.subject) || item.subject.length > 500 ||
        (item.body !== undefined && (typeof item.body !== "string" || item.body.includes("\0") || item.body.length > 40_000)) ||
        !Array.isArray(item.files) || !item.files.length) {
      throw new Error("Invalid split commit message or files.");
    }
    const files: string[] = [];
    for (const path of item.files) {
      if (typeof path !== "string" || !remaining.delete(path)) {
        throw new Error(`Invalid AI split path: ${String(path)}. Only exact, non-duplicated staged paths are allowed.`);
      }
      files.push(path);
    }
    commits.push({ subject: item.subject.trim(), body: typeof item.body === "string" ? item.body : "", files });
  }
  if (remaining.size) throw new Error("AI split omitted staged paths. Nothing was committed.");
  return commits;
}

/**
 * Assemble every planned tree from Git objects, then commit using a private index.
 * The real index stays intact, so a later hook failure leaves remaining work staged.
 * User-installed hooks remain trusted Git programs; unexpected tree changes stop the run.
 */
export async function executeSplitCommits(
  snapshot: StagedSnapshot, plan: SplitCommit[], options: Pick<CommitOptions, "noVerify" | "gpgSign" | "signoff"> = {},
): Promise<string[]> {
  if (getFlags().dryRun) throw new Error("Cannot execute split commits during a dry run.");
  validateSplitPlan({ commits: plan }, snapshot);
  const { cwd, indexPath } = snapshot;
  const lockPath = `${indexPath}.lock`;
  // Exclusive creation respects another Git process's lock. Never remove its lock.
  const lock = openSync(lockPath, "wx", 0o600);
  let checkpoint: string | undefined;
  const completed: string[] = [];
  let success = false;
  try {
    writeFileSync(lock, JSON.stringify({ operation: "ggh split", pid: process.pid, head: snapshot.head }));
    const currentBranch = await branchAt(cwd);
    if (currentBranch !== snapshot.branch || await headAt(cwd) !== snapshot.head || !readFileSync(indexPath).equals(snapshot.indexBytes)) {
      throw new Error("Repository or index changed after AI planning. Retry without discarding your changes.");
    }
    const parent = join(dirname(indexPath), "ggh-split");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    checkpoint = mkdtempSync(join(parent, "checkpoint-"));
    writeFileSync(join(checkpoint, "original-index"), snapshot.indexBytes, { mode: 0o600 });
    const journal = () => writeFileSync(join(checkpoint!, "state.json"), JSON.stringify({
      version: 1, originalHead: snapshot.head, branch: snapshot.branch, stagedTree: snapshot.tree, completed,
    }, null, 2) + "\n", { mode: 0o600 });
    journal();
    const env = { ...process.env, GIT_INDEX_FILE: join(checkpoint, "temporary-index") };
    const git = (args: string[], input?: string) => run("git", args, { cwd, env, input });
    await git(snapshot.head ? ["read-tree", snapshot.head] : ["read-tree", "--empty"]);
    const trees: string[] = [];
    const zeros = "0".repeat(snapshot.tree.length);
    for (const group of plan) {
      // Removal-first handles file/directory changes within a group.
      const paths = [...group.files].sort((a, b) => Number(snapshot.entries.has(a)) - Number(snapshot.entries.has(b)));
      const records = paths.map((path) => {
        const entry = snapshot.entries.get(path);
        return `${entry?.mode ?? "0"} ${entry?.oid ?? zeros}\t${path}\0`;
      }).join("");
      await git(["update-index", "-z", "--index-info"], records);
      trees.push((await git(["write-tree"])).stdout.trim());
    }
    if (trees.at(-1) !== snapshot.tree) throw new Error("Split plan does not reconstruct the staged tree.");
    let expectedHead = snapshot.head;
    for (const [i, group] of plan.entries()) {
      if (await headAt(cwd) !== expectedHead) throw new Error("HEAD changed during the split. No more commits were attempted.");
      await git(["read-tree", trees[i]!]);
      await commit(group.subject, group.body, { ...options, cwd, env });
      const next = await headAt(cwd);
      if (!next) throw new Error("Git did not create the expected split commit.");
      completed.push(next); journal();
      const actualTree = (await run("git", ["rev-parse", `${next}^{tree}`], { cwd })).stdout.trim();
      if (actualTree !== trees[i]) throw new Error("A Git hook changed the planned commit contents. Inspect the last commit before continuing.");
      expectedHead = next;
    }
    success = true;
    return completed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${detail}\nSplit stopped after ${completed.length}/${plan.length} commits. The original index was not replaced.` +
      (checkpoint ? `\nRecovery checkpoint: ${checkpoint}. Inspect git status and git log before retrying; no automatic reset was performed.` : ""), { cause: err });
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    if (success && checkpoint) rmSync(checkpoint, { recursive: true, force: true });
  }
}
