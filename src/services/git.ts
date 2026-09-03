import { run } from "../utils/exec.ts";
import { existsSync, appendFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import type { ChangedFile } from "../utils/diff.ts";
import type { CloneMode } from "./config.ts";

export interface GitStatusResult {
  isRepo: boolean;
  branch: string;
  isDetached?: boolean;
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  conflicts: ChangedFile[];
  hasChanges: boolean;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  isBare: boolean;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
}

export const NON_INTERACTIVE_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
});

/**
 * Executes a git command with exponential backoff retry if index.lock or HEAD.lock is encountered.
 */
export async function execGitWithRetry(
  args: string[],
  options: {
    cwd?: string;
    maxRetries?: number;
    delayMs?: number;
    nonInteractive?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const cwd = options.cwd || process.cwd();
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.delayMs ?? 250;
  // Default to non-interactive when stdin is not a TTY so git never blocks on credential prompts
  const nonInteractive = options.nonInteractive ?? !process.stdin.isTTY;
  const env = nonInteractive
    ? { ...process.env, ...options.env, ...NON_INTERACTIVE_ENV }
    : options.env
      ? { ...process.env, ...options.env }
      : undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await run("git", args, { cwd, env });
    } catch (err: unknown) {
      const errStr = String(err);
      const isLockError =
        errStr.includes("index.lock") ||
        errStr.includes("HEAD.lock") ||
        (errStr.includes("Unable to create") && errStr.includes(".lock"));

      if (isLockError && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 1.5;
        continue;
      }
      throw err;
    }
  }
  return await run("git", args, { cwd, env });
}

export async function isGitRepo(cwd = process.cwd()): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function hasCommits(cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function hasBranch(branch: string, cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return stdout.trim();
}

export async function getCurrentBranch(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return "HEAD";
  }
}

export async function isDetachedHead(cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["symbolic-ref", "-q", "HEAD"], { cwd });
    return false;
  } catch {
    return true;
  }
}

export async function getCommitCount(cwd = process.cwd()): Promise<number> {
  try {
    const { stdout } = await run("git", ["rev-list", "--count", "HEAD"], { cwd });
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function getRemotes(cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["remote"], { cwd });
    return stdout
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function hasRemote(name = "origin", cwd = process.cwd()): Promise<boolean> {
  const remotes = await getRemotes(cwd);
  return remotes.includes(name);
}

export async function listBranches(cwd = process.cwd()): Promise<BranchInfo[]> {
  try {
    const { stdout } = await run(
      "git",
      // NUL-delimited so branch names containing "|" (or subjects containing "|") parse correctly
      ["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(subject)", "refs/heads"],
      { cwd },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\0");
        const name = parts[0]?.trim() || "";
        const head = parts[1]?.trim() || "";
        const commit = parts[2]?.trim() || "";
        return {
          name,
          current: head === "*",
          commit,
        };
      });
  } catch {
    return [];
  }
}

export async function setBranchMergeBase(
  branch: string,
  baseBranch: string,
  cwd = process.cwd(),
): Promise<void> {
  try {
    await run("git", ["config", `branch.${branch}.gh-merge-base`, baseBranch], { cwd });
  } catch {
    // Best-effort
  }
}

export async function getBranchMergeBase(
  branch?: string,
  cwd = process.cwd(),
): Promise<string | null> {
  try {
    const targetBranch = branch || (await getCurrentBranch(cwd));
    const { stdout } = await run("git", ["config", `branch.${targetBranch}.gh-merge-base`], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function switchBranch(
  branch: string,
  create = false,
  cwd = process.cwd(),
  baseBranch?: string,
): Promise<void> {
  const current = await getCurrentBranch(cwd);
  const args = create
    ? baseBranch
      ? ["checkout", "-b", branch, baseBranch]
      : ["checkout", "-b", branch]
    : ["checkout", branch];
  await execGitWithRetry(args, { cwd });
  if (create) {
    const base = baseBranch || current;
    await setBranchMergeBase(branch, base, cwd);
  }
}

export async function renameBranch(
  oldName: string,
  newName: string,
  cwd = process.cwd(),
): Promise<void> {
  await execGitWithRetry(["branch", "-m", oldName, newName], { cwd });
  const mergeBase = await getBranchMergeBase(oldName, cwd);
  if (mergeBase) {
    await setBranchMergeBase(newName, mergeBase, cwd);
  }
}

export async function fetchPullRequestBranch(
  prNumber: number,
  localBranch: string,
  cwd = process.cwd(),
): Promise<void> {
  const remotes = await getRemotes(cwd);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] || "origin";
  await run(
    "git",
    ["fetch", "--quiet", "--no-tags", remote, `+refs/pull/${prNumber}/head:refs/heads/${localBranch}`],
    { cwd },
  );
}

export async function findPrTemplate(cwd = process.cwd()): Promise<string | null> {
  try {
    const repoRoot = await getRepoRoot(cwd);
    const candidates = [
      join(repoRoot, ".github", "pull_request_template.md"),
      join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
      join(repoRoot, "pull_request_template.md"),
      join(repoRoot, "PULL_REQUEST_TEMPLATE.md"),
      join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE", "pull_request_template.md"),
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return readFileSync(c, "utf-8");
      }
    }
  } catch {
    // Best-effort
  }
  return null;
}

export async function getStatus(cwd = process.cwd()): Promise<GitStatusResult> {
  // Probe repo state and porcelain status in parallel (independent git calls)
  const [inRepo, isDetached, branch, statusResult] = await Promise.all([
    isGitRepo(cwd),
    isDetachedHead(cwd),
    getCurrentBranch(cwd),
    run(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall"],
      { cwd, reject: false },
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 128 })),
  ]);

  if (!inRepo) {
    return {
      isRepo: false,
      branch: "",
      isDetached: false,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      hasChanges: false,
    };
  }

  const stdout = statusResult.stdout;

  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];
  const conflicts: ChangedFile[] = [];

  const rawEntries = stdout.split("\0");
  let i = 0;
  while (i < rawEntries.length) {
    const entry = rawEntries[i];
    if (!entry) {
      i++;
      continue;
    }

    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);

    if (x === "R" || x === "C") {
      // For rename/copy in -z mode, next entry is the original path
      i++;
    }

    // Merge conflict states
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicts.push({ path: filePath, status: "conflict", staged: false });
      i++;
      continue;
    }

    if (x === "?" && y === "?") {
      untracked.push({ path: filePath, status: "untracked", staged: false });
      i++;
      continue;
    }

    // Staged changes (X column)
    if (x !== " " && x !== "?") {
      let status: ChangedFile["status"] = "modified";
      if (x === "A") status = "added";
      else if (x === "D") status = "deleted";
      else if (x === "R") status = "renamed";
      staged.push({ path: filePath, status, staged: true });
    }

    // Unstaged changes (Y column)
    if (y !== " " && y !== "?") {
      let status: ChangedFile["status"] = "modified";
      if (y === "D") status = "deleted";
      unstaged.push({ path: filePath, status, staged: false });
    }

    i++;
  }

  const hasChanges =
    staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || conflicts.length > 0;

  return {
    isRepo: true,
    branch,
    isDetached,
    staged,
    unstaged,
    untracked,
    conflicts,
    hasChanges,
  };
}

export async function stageFiles(files: string[], cwd = process.cwd()): Promise<void> {
  if (files.length === 0) return;
  await execGitWithRetry(["add", "--", ...files], { cwd });
}

export async function stageAll(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["add", "-A"], { cwd });
}

export async function getStagedDiff(cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["diff", "--cached"], { cwd });
  return stdout;
}

export async function getStagedDiffStat(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "--cached", "--stat"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getRecentCommits(count = 10, cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["log", `-n`, `${count}`, "--oneline"], { cwd });
    return stdout.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

export interface CommitOptions {
  noVerify?: boolean;
  gpgSign?: boolean;
  signoff?: boolean;
  amend?: boolean;
  cwd?: string;
}

export interface LargeFileCheckResult {
  blocked: Array<{ path: string; sizeMB: number }>;
  warnings: Array<{ path: string; sizeMB: number }>;
}

export async function checkLargeFiles(
  files: ChangedFile[],
  cwd = process.cwd(),
): Promise<LargeFileCheckResult> {
  const repoRoot = await getRepoRoot(cwd);
  const blocked: Array<{ path: string; sizeMB: number }> = [];
  const warnings: Array<{ path: string; sizeMB: number }> = [];

  await Promise.all(
    files.map(async (file) => {
      if (file.status === "deleted") return;
      const fullPath = join(repoRoot, file.path);

      try {
        const stats = await stat(fullPath);
        const sizeMB = Math.round((stats.size / (1024 * 1024)) * 10) / 10;
        if (stats.size >= 100 * 1024 * 1024) {
          blocked.push({ path: file.path, sizeMB });
        } else if (stats.size >= 50 * 1024 * 1024) {
          warnings.push({ path: file.path, sizeMB });
        }
      } catch {
        // File missing or unreadable; ignore
      }
    }),
  );

  return { blocked, warnings };
}

export async function getAheadBehind(
  cwd = process.cwd(),
): Promise<{ ahead: number; behind: number; hasUpstream: boolean }> {
  try {
    const { stdout } = await run(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      { cwd },
    );
    const parts = stdout.trim().split(/\s+/).map(Number);
    return { ahead: parts[0] || 0, behind: parts[1] || 0, hasUpstream: true };
  } catch {
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
}

/**
 * Detects the repository's default branch: recorded merge-base first, then main/master fallback.
 */
export async function detectDefaultBranch(cwd = process.cwd()): Promise<string> {
  try {
    const current = await getCurrentBranch(cwd);
    const recordedBase = await getBranchMergeBase(current, cwd);
    if (recordedBase && (await hasBranch(recordedBase, cwd))) {
      return recordedBase;
    }
  } catch {
    // Fall through to main/master detection
  }

  const [hasMain, hasMaster] = await Promise.all([hasBranch("main", cwd), hasBranch("master", cwd)]);
  if (hasMain) return "main";
  if (hasMaster) return "master";
  return "main";
}

export async function getAheadOfDefault(
  defaultBranch?: string,
  cwd = process.cwd(),
): Promise<number> {
  try {
    const current = await getCurrentBranch(cwd);
    const actualDefault =
      defaultBranch && (await hasBranch(defaultBranch, cwd))
        ? defaultBranch
        : await detectDefaultBranch(cwd);
    if (!actualDefault || current === actualDefault) return 0;

    const { stdout } = await run(
      "git",
      ["rev-list", "--count", `${actualDefault}..HEAD`],
      { cwd },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function discardFiles(
  files: { path: string; staged?: boolean; untracked?: boolean }[],
  cwd = process.cwd(),
): Promise<void> {
  const hasUntracked = files.some((f) => f.untracked);
  const root = hasUntracked ? await getRepoRoot(cwd) : "";

  for (const f of files) {
    if (f.untracked) {
      rmSync(join(root, f.path), { force: true, recursive: true });
    } else if (f.staged) {
      await execGitWithRetry(["restore", "--staged", "--worktree", "--", f.path], { cwd });
    } else {
      await execGitWithRetry(["restore", "--", f.path], { cwd });
    }
  }
}

export async function fetchPrune(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["fetch", "--prune"], { cwd });
}

export async function getGoneBranches(cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["branch", "-vv"], { cwd });
    const gone: string[] = [];
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.includes(": gone]")) {
        const branchName = line.replace(/^[*+ ]\s*/, "").split(/\s+/)[0];
        if (branchName) gone.push(branchName);
      }
    }
    return gone;
  } catch {
    return [];
  }
}

export async function deleteLocalBranch(
  branch: string,
  force = false,
  cwd = process.cwd(),
): Promise<void> {
  const flag = force ? "-D" : "-d";
  await execGitWithRetry(["branch", flag, branch], { cwd });
}

export async function getUnmergedCommits(
  branch: string,
  base = "main",
  cwd = process.cwd(),
): Promise<string[]> {
  try {
    const [baseExists, masterExists] = await Promise.all([
      hasBranch(base, cwd),
      hasBranch("master", cwd),
    ]);
    const actualBase = baseExists ? base : masterExists ? "master" : "HEAD";
    const { stdout } = await run("git", ["cherry", actualBase, branch], { cwd });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(2).trim());
  } catch {
    return [];
  }
}

export interface SubmoduleStatus {
  name: string;
  status: "dirty" | "uninitialized" | "conflict";
  commit: string;
}

export async function checkSubmodules(cwd = process.cwd()): Promise<SubmoduleStatus[]> {
  try {
    const { stdout } = await run("git", ["submodule", "status"], { cwd });
    const results: SubmoduleStatus[] = [];
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const flag = line[0];
      const parts = trimmed.split(/\s+/);
      const commit = parts[0]?.replace(/^[-+U]/, "") || "";
      const name = parts[1] || "";

      if (flag === "+") {
        results.push({ name, status: "dirty", commit });
      } else if (flag === "-") {
        results.push({ name, status: "uninitialized", commit });
      } else if (flag === "U") {
        results.push({ name, status: "conflict", commit });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function squashCommits(
  count: number,
  cwd = process.cwd(),
): Promise<{ previousMessages: string[]; stagedCount: number }> {
  if (count <= 1) {
    throw new Error("Squash count must be at least 2.");
  }
  const total = await getCommitCount(cwd);
  if (total < count) {
    throw new Error(`Cannot squash ${count} commits: only ${total} commit(s) available.`);
  }

  const { stdout } = await run("git", ["log", `-n`, count.toString(), "--pretty=format:%s"], { cwd });
  const previousMessages = stdout.split("\n").filter(Boolean);

  await execGitWithRetry(["reset", "--soft", `HEAD~${count}`], { cwd });
  const status = await getStatus(cwd);
  return { previousMessages, stagedCount: status.staged.length };
}

export async function commit(
  subject: string,
  body?: string,
  optionsOrCwd: CommitOptions | string = {},
): Promise<string> {
  if (!subject || subject.trim().length === 0) {
    throw new Error("Commit message cannot be empty.");
  }

  const options = typeof optionsOrCwd === "string" ? { cwd: optionsOrCwd } : optionsOrCwd || {};
  const cwd = options.cwd || process.cwd();
  const args = ["commit", "-m", subject.trim()];
  if (options.amend) {
    args.push("--amend");
  }
  if (body && body.trim().length > 0) {
    args.push("-m", body.trim());
  }
  if (options.noVerify) {
    args.push("--no-verify");
  }
  if (options.gpgSign) {
    args.push("-S");
  }
  if (options.signoff) {
    args.push("-s");
  }
  const { stdout } = await execGitWithRetry(args, { cwd });
  return stdout;
}

export async function undoCommit(cwd = process.cwd()): Promise<void> {
  const count = await getCommitCount(cwd);
  if (count <= 1) {
    // Only root commit exists. Soft reset to unborn state using update-ref
    await execGitWithRetry(["update-ref", "-d", "HEAD"], { cwd });
  } else {
    await execGitWithRetry(["reset", "--soft", "HEAD~1"], { cwd });
  }
}

export async function getRemoteTrackingBranch(cwd = process.cwd(), branch?: string): Promise<string | null> {
  try {
    const ref = branch ? `${branch}@{u}` : "@{u}";
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", ref], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function pullRebase(cwd = process.cwd()): Promise<void> {
  await run("git", ["pull", "--rebase"], { cwd, stdio: "inherit" });
}

export async function push(
  options: { remote?: string; branch?: string; setUpstream?: boolean; noVerify?: boolean; cwd?: string } = {},
): Promise<void> {
  const cwd = options.cwd || process.cwd();

  const [detached, remotes] = await Promise.all([isDetachedHead(cwd), getRemotes(cwd)]);

  if (detached) {
    throw new Error("Cannot push from a detached HEAD state. Please create or checkout a branch first.");
  }

  if (remotes.length === 0) {
    throw new Error("No git remotes configured. Please add a remote (e.g. `git remote add origin <url>`) before pushing.");
  }

  const remote = options.remote || (remotes.includes("origin") ? "origin" : remotes[0]);
  const branch = options.branch || (await getCurrentBranch(cwd));

  const args = ["push"];
  if (options.noVerify) {
    args.push("--no-verify");
  }
  if (options.setUpstream) {
    args.push("-u", remote, branch);
  } else {
    // Check if tracking branch exists for this branch
    const tracking = await getRemoteTrackingBranch(cwd, branch);
    if (!tracking) {
      args.push("-u", remote, branch);
    }
  }

  await run("git", args, { cwd, stdio: "inherit" });
}

export async function clone(
  repoUrl: string,
  destination: string,
  mode: CloneMode = "standard",
  cwd = process.cwd(),
): Promise<void> {
  const args = ["clone"];

  if (mode === "blobless") {
    args.push("--filter=blob:none");
  } else if (mode === "shallow") {
    args.push("--depth", "1");
  }

  args.push("--", repoUrl, destination);
  await run("git", args, { cwd, stdio: "inherit" });
}

export async function worktreeList(cwd = process.cwd()): Promise<WorktreeInfo[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd });
  const entries: WorktreeInfo[] = [];

  const blocks = stdout.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let path = "";
    let head = "";
    let branch = "";
    let isBare = false;

    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.replace("worktree ", "").trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.replace("HEAD ", "").trim();
      } else if (line.startsWith("branch ")) {
        branch = line.replace("branch refs/heads/", "").trim();
      } else if (line === "bare") {
        isBare = true;
      }
    }

    if (path) {
      entries.push({ path, head, branch: branch || head, isBare });
    }
  }

  return entries;
}

export interface WorktreeAddResult {
  copiedEnvFiles: string[];
}

export async function worktreeAdd(
  branch: string,
  targetPath: string,
  baseBranch?: string,
  cwd = process.cwd(),
): Promise<WorktreeAddResult> {
  const repoRoot = await getRepoRoot(cwd);
  if (!(await hasCommits(repoRoot))) {
    throw new Error(
      "Cannot create a worktree in an empty repository with no commits. Please make an initial commit first.",
    );
  }

  const resolvedPath = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);

  // If destination folder exists on disk, check if it's an orphaned worktree directory
  if (existsSync(resolvedPath)) {
    // Never recursively delete anything outside the repository
    const rel = relative(repoRoot, resolvedPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Refusing to clean up '${resolvedPath}': it is outside the repository root '${repoRoot}'.`,
      );
    }

    const activeTrees = await worktreeList(repoRoot);
    const isActive = activeTrees.some((w) => w.path === resolvedPath);
    if (!isActive) {
      // Clean up orphaned folder from previous aborted operations
      rmSync(resolvedPath, { recursive: true, force: true });
    } else {
      throw new Error(`Worktree directory '${resolvedPath}' is already an active worktree.`);
    }
  }

  // Ensure .worktrees is ignored in .git/info/exclude
  const excludePath = join(repoRoot, ".git", "info", "exclude");
  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf-8");
    if (!content.includes(".worktrees")) {
      appendFileSync(excludePath, "\n.worktrees/\n");
    }
  }

  const branchAlreadyExists = await hasBranch(branch, repoRoot);
  const base = baseBranch || (await getCurrentBranch(cwd));

  const args = branchAlreadyExists
    ? ["worktree", "add", "--", resolvedPath, branch]
    : ["worktree", "add", "-b", branch, "--", resolvedPath, base];

  await execGitWithRetry(args, { cwd: repoRoot });

  // Sync .env files from parent repository to the new worktree (T3 Code DX feature)
  const copiedEnvFiles: string[] = [];
  const envFileCandidates = [".env", ".env.local", ".env.development"];
  for (const envName of envFileCandidates) {
    const srcEnv = join(repoRoot, envName);
    const destEnv = join(resolvedPath, envName);
    if (existsSync(srcEnv) && !existsSync(destEnv)) {
      try {
        copyFileSync(srcEnv, destEnv);
        copiedEnvFiles.push(envName);
      } catch {
        // Best-effort
      }
    }
  }

  // Update submodules recursively if present (T3 Code pattern)
  const gitmodulesPath = join(resolvedPath, ".gitmodules");
  if (existsSync(gitmodulesPath)) {
    try {
      await run("git", ["submodule", "update", "--init", "--recursive"], {
        cwd: resolvedPath,
        stdio: "inherit",
      });
    } catch {
      // Best-effort
    }
  }

  // Set merge base in git config (T3 Code pattern)
  try {
    await run(
      "git",
      ["config", `branch.${branch}.gh-merge-base`, base],
      { cwd: repoRoot },
    );
  } catch {
    // Best-effort
  }

  return { copiedEnvFiles };
}

export async function worktreeRemove(
  targetPath: string,
  force = false,
  cwd = process.cwd(),
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", targetPath);
  await execGitWithRetry(args, { cwd });
  await run("git", ["worktree", "prune"], { cwd });
}

export async function resolveConflict(
  file: string,
  strategy: "ours" | "theirs" | "mark",
  cwd = process.cwd(),
): Promise<void> {
  if (strategy === "ours") {
    await execGitWithRetry(["checkout", "--ours", "--", file], { cwd });
    await execGitWithRetry(["add", "--", file], { cwd });
  } else if (strategy === "theirs") {
    await execGitWithRetry(["checkout", "--theirs", "--", file], { cwd });
    await execGitWithRetry(["add", "--", file], { cwd });
  } else if (strategy === "mark") {
    await execGitWithRetry(["add", "--", file], { cwd });
  }
}

export interface StashEntry {
  ref: string;
  date: string;
  message: string;
}

export async function stashList(cwd = process.cwd()): Promise<StashEntry[]> {
  try {
    const { stdout } = await run("git", ["stash", "list", "--pretty=format:%gd|%cr|%gs"], { cwd });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return {
          ref: parts[0]?.trim() || "",
          date: parts[1]?.trim() || "",
          message: parts[2]?.trim() || "",
        };
      });
  } catch {
    return [];
  }
}

export async function stashPush(message?: string, cwd = process.cwd()): Promise<void> {
  const args = ["stash", "push", "-u"];
  if (message && message.trim().length > 0) {
    args.push("-m", message.trim());
  }
  await execGitWithRetry(args, { cwd });
}

export async function stashPop(ref?: string, cwd = process.cwd()): Promise<void> {
  const args = ["stash", "pop"];
  if (ref) {
    args.push(ref);
  }
  await execGitWithRetry(args, { cwd });
}

export async function stashDrop(ref: string, cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["stash", "drop", ref], { cwd });
}

export async function stashDiff(ref: string, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["stash", "show", "-p", "-u", ref], { cwd });
    return stdout;
  } catch {
    return "";
  }
}

export async function gitPassthrough(args: string[], cwd = process.cwd()): Promise<number> {
  const result = await run("git", args, {
    cwd,
    stdio: "inherit",
    reject: false,
  });
  return result.exitCode ?? 0;
}
