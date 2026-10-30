import { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import {
  detectDefaultBranch,
  execGitWithRetry,
  getCurrentBranch,
  getRebaseBranch,
  getRemoteTrackingBranch,
  getStackAncestors,
  getStackDescendants,
  getStackGraph,
  getRemotes,
  getStatus,
  isAncestor,
  isDetachedHead,
  isRebaseInProgress,
  push,
  recordParentTip,
  requireGitRepo,
  restackBranch,
  setBranchMergeBase,
  switchBranch,
  type StackNode,
} from "../services/git.ts";
import {
  clearProtectedStackTips,
  clearStackRecovery,
  createStackRecovery,
  getBranchTip,
  protectStackTip,
  readStackRecovery,
  setBranchTipIfUnchanged,
  writeStackRecovery,
  acquireStackOperationLock,
  type StackRecoveryCheckpoint,
  type StackRecoveryEntry,
} from "../services/git/stack.ts";
import {
  createPullRequest,
  getActivePullRequest,
  ghGlobal,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parsePullRequestUrl,
  parseRepoFlag,
  registerNativeStack,
  requireAuth,
  type NativeStackRegistration,
  type PullRequestTarget,
} from "../services/github.ts";
import { getActiveOperation, getFlags, recordCommandIssue, setActiveOperation } from "../services/runtime.ts";
import { hasUrlCredentials, remotePushUrl } from "../services/publication.ts";
import { readOperation, startOperation, updateOperation, type OperationRecord, type OperationStatus } from "../services/operations.ts";
import { run } from "../utils/exec.ts";
import { dryRun } from "../utils/flags.ts";
import { validateBranchName } from "../utils/branch-name.ts";
import {
  confirmOrAbort, jsonOut,
  fail,
  failFromGitHub,
  failFromPush,
  header,
  p,
  pc,
  promptInput,
  searchablePicker,
} from "../utils/ui.ts";
import { PushProtectionError } from "../services/git/push-protection.ts";

interface StackRemoteCheck {
  name: string;
  state: string;
  description?: string;
  link?: string;
}

interface StackRemotePullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  reviewDecision: string | null;
  checks: { state: "available"; runs: StackRemoteCheck[] } | { state: "unavailable"; reason: string };
}

type StackRemoteStatus =
  | { state: "available"; pr?: StackRemotePullRequest }
  | { state: "unavailable"; reason: string; pr?: StackRemotePullRequest };

interface StackGitHubTarget {
  host: string;
  repoArg: string;
}

const STACK_REMOTE_LOOKUP_LIMIT = 25;

async function stackGitHubTarget(cwd: string): Promise<StackGitHubTarget | null> {
  const explicit = parseRepoFlag();
  if (explicit) return { host: explicit.host, repoArg: explicit.repoArg };

  const remotes = await getRemotes(cwd);
  for (const remote of [...new Set(["origin", ...remotes])]) {
    const result = await run("git", ["config", "--get", "remote." + remote + ".url"], { cwd, reject: false });
    if (result.exitCode !== 0) continue;
    const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(result.stdout);
    if (!parsed) continue;
    if (typeof parsed === "string") return { host: "github.com", repoArg: parsed };
    return { host: parsed.host, repoArg: parsed.host + "/" + parsed.nameWithOwner };
  }
  return null;
}

async function runStackGitHubRead(args: string[], target: StackGitHubTarget, cwd: string) {
  return ghGlobal([...args, "--repo", target.repoArg], { cwd, reject: false });
}

function parseRemoteJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error("GitHub returned invalid JSON."); }
}

function parseStackPullRequest(value: unknown): Omit<StackRemotePullRequest, "checks"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pr = value as Record<string, unknown>;
  if (typeof pr.number !== "number" || !Number.isInteger(pr.number) || typeof pr.title !== "string" ||
      typeof pr.state !== "string" || typeof pr.url !== "string" || !URL.canParse(pr.url) ||
      (pr.reviewDecision !== null && pr.reviewDecision !== undefined && typeof pr.reviewDecision !== "string")) return null;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    reviewDecision: typeof pr.reviewDecision === "string" ? pr.reviewDecision : null,
  };
}

async function remoteStatusForBranch(branch: string, target: StackGitHubTarget, cwd: string): Promise<StackRemoteStatus> {
  try {
    const pullRequests = await runStackGitHubRead([
      "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
      "--json", "number,title,state,url,reviewDecision",
    ], target, cwd);
    if (pullRequests.exitCode !== 0) {
      return { state: "unavailable", reason: pullRequests.stderr.trim() || "Pull request lookup failed." };
    }
    const parsed = parseRemoteJson(pullRequests.stdout);
    if (!Array.isArray(parsed)) return { state: "unavailable", reason: "GitHub returned an invalid pull request list." };
    if (parsed.length === 0) return { state: "available" };
    const pr = parseStackPullRequest(parsed[0]);
    if (!pr) return { state: "unavailable", reason: "GitHub returned incomplete pull request metadata." };

    const checksResult = await runStackGitHubRead([
      "pr", "checks", String(pr.number), "--json", "name,state,description,link",
    ], target, cwd);
    if (checksResult.stdout.trim()) {
      const checks = parseRemoteJson(checksResult.stdout);
      if (Array.isArray(checks) && checks.every((check) => check && typeof check === "object" && !Array.isArray(check) &&
          typeof check.name === "string" && typeof check.state === "string")) {
        return {
          state: "available",
          pr: {
            ...pr,
            checks: {
              state: "available",
              runs: checks.map((check) => ({
                name: check.name as string,
                state: check.state as string,
                ...(typeof check.description === "string" ? { description: check.description } : {}),
                ...(typeof check.link === "string" ? { link: check.link } : {}),
              })),
            },
          },
        };
      }
      return { state: "unavailable", reason: "GitHub returned invalid check metadata.", pr: { ...pr, checks: { state: "unavailable", reason: "Invalid check metadata." } } };
    }
    if (checksResult.exitCode !== 0 && !/no checks reported|no checks found/i.test(checksResult.stderr)) {
      const reason = checksResult.stderr.trim() || "CI lookup failed.";
      return { state: "unavailable", reason, pr: { ...pr, checks: { state: "unavailable", reason } } };
    }
    return { state: "available", pr: { ...pr, checks: { state: "available", runs: [] } } };
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function remoteStatuses(branches: string[], cwd: string): Promise<Map<string, StackRemoteStatus>> {
  let target: StackGitHubTarget | null;
  try { target = await stackGitHubTarget(cwd); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new Map(branches.map((branch) => [branch, { state: "unavailable", reason }]));
  }
  if (!target) return new Map(branches.map((branch) => [branch, { state: "unavailable", reason: "No GitHub repository could be identified from --repo or a Git remote." }]));

  const statuses = new Map<string, StackRemoteStatus>();
  const previousHost = process.env.GH_HOST;
  process.env.GH_HOST = target.host;
  try {
    const limited = branches.slice(0, STACK_REMOTE_LOOKUP_LIMIT);
    let next = 0;
    const workers = Array.from({ length: Math.min(5, limited.length) }, async () => {
      while (next < limited.length) {
        const branch = limited[next++];
        if (branch !== undefined) statuses.set(branch, await remoteStatusForBranch(branch, target, cwd));
      }
    });
    await Promise.all(workers);
  } finally {
    if (previousHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousHost;
  }
  for (const branch of branches.slice(STACK_REMOTE_LOOKUP_LIMIT)) {
    statuses.set(branch, { state: "unavailable", reason: "Remote lookup limit reached for this view." });
  }
  return statuses;
}

function remoteSummary(status: StackRemoteStatus | undefined): string {
  if (!status || status.state === "unavailable") return "remote unavailable";
  if (!status.pr) return "no pull request";
  const review = status.pr.reviewDecision || "review pending";
  const checks = status.pr.checks.state === "unavailable"
    ? "CI unavailable"
    : status.pr.checks.runs.length === 0
      ? "no checks"
      : status.pr.checks.runs.map((check) => check.state).join("/");
  return "PR #" + status.pr.number + " · " + review + " · " + checks;
}

async function withStackMutationLock(cwd: string, command: string, action: () => Promise<void>): Promise<void> {
  if (getFlags().dryRun) return action();
  let release: (() => Promise<void>) | undefined;
  try { release = await acquireStackOperationLock(cwd, command); }
  catch (error) { fail(String(error)); return; }
  try { await action(); }
  finally { await release(); }
}

function operationSteps(checkpoint: StackRecoveryCheckpoint): OperationRecord["steps"] {
  return checkpoint.entries.slice(0, 100).map((entry, index) => ({
    name: `branch ${index + 1}`,
    state: entry.state === "completed" ? "completed" : entry.state === "failed" || entry.state === "unknown" ? entry.state : "pending",
  }));
}

async function beginStackOperation(command: "stack restack" | "stack submit", target: string, steps: string[], cwd: string): Promise<string | null> {
  if (process.env.GGH_NO_RECORDS === "1") return null;
  const active = getActiveOperation();
  if (active?.cwd === cwd) {
    try { await readOperation(active.id, cwd); return active.id; }
    catch { /* A stale runtime id must not block a new durable record. */ }
  }
  const record = await startOperation({
    command,
    target,
    steps: steps.slice(0, 100),
    cwd,
  });
  setActiveOperation({ id: record.id, cwd });
  return record.id;
}

async function saveStackProgress(
  checkpoint: StackRecoveryCheckpoint,
  state: OperationStatus,
  cwd: string,
  steps: OperationRecord["steps"] = operationSteps(checkpoint),
): Promise<void> {
  if (process.env.GGH_NO_RECORDS === "1") return;
  const active = getActiveOperation();
  const operationId = active?.cwd === cwd ? active.id : checkpoint.operationId;
  await updateOperation(operationId, {
    status: state,
    steps,
    resources: checkpoint.resources,
    revision: checkpoint.entries.at(-1)?.expectedTip,
  }, cwd);
}

async function resolvePushRemote(branch: string, cwd: string): Promise<string> {
  const keys = [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`];
  const configured = await Promise.all(keys.map(async (key) => {
    const result = await run("git", ["config", "--get", key], { cwd, reject: false });
    return result.exitCode === 0 ? result.stdout.trim() : "";
  }));
  const remotes = await getRemotes(cwd);
  const remote = configured.find(Boolean) || (remotes.includes("origin") ? "origin" : remotes[0]);
  if (!remote) throw new Error("No git remotes configured. Add a remote before submitting the stack.");
  return remote;
}

async function remoteBranchTip(remote: string, branch: string, cwd: string): Promise<string | null> {
  const result = await run("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { cwd, reject: false });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not inspect remote branch ${branch}.`);
  return result.stdout.trim().split(/\s+/)[0] || null;
}

async function assertExplicitSubmitTarget(plan: Array<{ branch: string }>, cwd: string): Promise<void> {
  const explicit = getFlags().repo;
  if (!explicit) return;
  const target = parseRepoFlag(explicit);
  if (!target) throw new Error("Could not resolve the explicit GitHub repository target.");
  for (const item of plan) {
    const remote = await resolvePushRemote(item.branch, cwd);
    const result = await run("git", ["remote", "get-url", "--all", "--push", remote], { cwd, reject: false });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error("Could not verify where stack branch " + item.branch + " will be pushed. Remove --repo or configure the push remote URL.");
    }
    for (const url of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const remoteTarget = githubRepository(url);
      if (!remoteTarget || remoteTarget.host.toLowerCase() !== target.host.toLowerCase() ||
          remoteTarget.nameWithOwner.toLowerCase() !== target.nameWithOwner.toLowerCase()) {
        throw new Error("Explicit --repo target " + target.host + "/" + target.nameWithOwner + " does not match push remote " + remote + " for " + item.branch + ". Refusing to push branches to one repository and open Pull Requests in another.");
      }
    }
  }
}

async function initializeRecovery(
  mode: StackRecoveryCheckpoint["mode"],
  selected: string,
  originalBranch: string,
  plan: Array<{ branch: string; parent: string; remote?: string }>,
  cwd: string,
  steps: string[] = plan.map((_, index) => `branch ${index + 1}`),
): Promise<StackRecoveryCheckpoint> {
  if (plan.length > 100) throw new Error("A stack operation can record at most 100 branches.");
  const existing = await readStackRecovery(cwd);
  if (existing) throw new Error("A " + existing.mode + " stack operation is unfinished. Resume it or run ggh stack restack --abort before starting another stack operation.");
  const operationId = await beginStackOperation(`stack ${mode}`, selected, steps, cwd) ?? randomUUID();
  const entries: StackRecoveryEntry[] = [];
  try {
    for (const [index, item] of plan.entries()) {
      const tip = await getBranchTip(item.branch, cwd);
      await protectStackTip(operationId, index, tip, cwd);
      entries.push({
        branch: item.branch,
        parent: item.parent,
        originalTip: tip,
        expectedTip: tip,
        state: "pending",
        ...(mode === "submit" ? { pushState: "pending" as const, remote: item.remote ?? await resolvePushRemote(item.branch, cwd) } : {}),
      });
    }
  } catch (error) {
    await clearProtectedStackTips(operationId, entries.length + 1, cwd);
    throw error;
  }
  const checkpoint: StackRecoveryCheckpoint = {
    schemaVersion: 1,
    operationId,
    mode,
    selected,
    originalBranch,
    entries,
    activeIndex: 0,
    resources: [],
  };
  try { await createStackRecovery(checkpoint, cwd); }
  catch (error) { await clearProtectedStackTips(operationId, entries.length, cwd); throw error; }
  return checkpoint;
}

async function discardRecovery(checkpoint: StackRecoveryCheckpoint, cwd: string): Promise<void> {
  await clearProtectedStackTips(checkpoint.operationId, checkpoint.entries.length, cwd);
  await clearStackRecovery(cwd);
}

async function restoreStackTips(checkpoint: StackRecoveryCheckpoint, cwd: string): Promise<void> {
  for (const entry of checkpoint.entries) {
    const actual = await getBranchTip(entry.branch, cwd);
    if (actual !== entry.expectedTip) throw new Error(`Branch ${entry.branch} changed during recovery. Its tip is ${actual}; expected ${entry.expectedTip}. The checkpoint and recovery refs were kept.`);
  }
  await execGitWithRetry(["checkout", "--detach"], { cwd });
  for (const entry of checkpoint.entries.slice().reverse()) {
    if (entry.expectedTip !== entry.originalTip) {
      await setBranchTipIfUnchanged(entry.branch, entry.originalTip, entry.expectedTip, cwd);
    }
  }
  await switchBranch(checkpoint.originalBranch, false, cwd);
}

async function replayStackFrom(checkpoint: StackRecoveryCheckpoint, index: number, cwd: string): Promise<number | null> {
  for (let current = index; current < checkpoint.entries.length; current += 1) {
    const entry = checkpoint.entries[current];
    if (!entry) continue;
    checkpoint.activeIndex = current;
    const actual = await getBranchTip(entry.branch, cwd);
    if (actual !== entry.expectedTip) {
      entry.state = "unknown";
      await writeStackRecovery(checkpoint, cwd);
      await saveStackProgress(checkpoint, { state: "partially_completed" }, cwd);
      throw new Error(`Branch ${entry.branch} changed after the stack plan. Expected ${entry.expectedTip}, found ${actual}. Recovery state was kept.`);
    }
    const result = await restackBranch(entry.branch, entry.parent, cwd);
    if (!result.ok) {
      entry.state = /conflict/i.test(result.message) ? "failed" : "unknown";
      await writeStackRecovery(checkpoint, cwd);
      await saveStackProgress(checkpoint, { state: "partially_completed" }, cwd);
      return current;
    }
    entry.expectedTip = await getBranchTip(entry.branch, cwd);
    entry.state = "completed";
    await recordParentTip(entry.branch, entry.parent, cwd);
    checkpoint.activeIndex = current + 1;
    await writeStackRecovery(checkpoint, cwd);
    await saveStackProgress(checkpoint, { state: "running" }, cwd);
  }
  checkpoint.activeIndex = checkpoint.entries.length;
  await writeStackRecovery(checkpoint, cwd);
  return null;
}

/** Renders the stack as a tree, marking branches that have drifted from their parent. */
function renderTree(
  graph: Map<string, StackNode>,
  roots: string[],
  defaultBranch = "main",
  remote?: Map<string, StackRemoteStatus>,
): string[] {
  const lines: string[] = [];

  function walk(branch: string, prefix: string, isLast: boolean, depth: number): void {
    const node = graph.get(branch);
    if (!node) return;

    const connector = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
    const marker = node.isCurrent ? pc.green("●") : pc.dim("○");
    const name = node.isCurrent ? pc.bold(pc.green(branch)) : branch;

    const meta: string[] = [];
    if (node.ahead > 0) meta.push(pc.cyan(`+${node.ahead}`));
    if (node.behind > 0) meta.push(pc.yellow(`${node.behind} behind parent`));
    if (node.parent === null && node.recordedParent && !node.parentExists) {
      meta.push(pc.yellow(`parent merged → ${defaultBranch}`));
    }
    if (remote) meta.push(remoteSummary(remote.get(branch)));
    const suffix = meta.length ? `  ${pc.dim("(")}${meta.join(pc.dim(", "))}${pc.dim(")")}` : "";

    lines.push(`${pc.dim(prefix)}${pc.dim(connector)}${marker} ${name}${suffix}`);

    const children = node.children.slice().sort();
    children.forEach((child, i) => {
      const nextPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : pc.dim("│") + "  ");
      walk(child, nextPrefix, i === children.length - 1, depth + 1);
    });
  }

  roots.forEach((root, i) => walk(root, "", i === roots.length - 1, 0));
  return lines;
}

/** At most 49 branches keep push, PR and link effects within one operation record. */
const MAX_SUBMIT_BRANCHES = 49;

interface SubmitEntryPlan { branch: string; parent: string; tip: string; parentTip: string | null; behind: number; remote: string; pushUrl: string }
/** Everything an approved submission binds: where it pushes, what it pushes, and what it opens. */
interface SubmitPlan { schemaVersion: 1; root: string; host: string; repository: string; selected: string; draft: boolean; nativeStack: boolean; allowStale: boolean; entries: SubmitEntryPlan[] }
interface SubmitProgress { completed: string[]; remaining: string[]; uncertain: string[] }

async function localTip(branch: string, cwd: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`], { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function githubRepository(url: string): { host: string; nameWithOwner: string } | null {
  const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
  if (!parsed) return null;
  return typeof parsed === "string" ? { host: "github.com", nameWithOwner: parsed } : { host: parsed.host.toLowerCase(), nameWithOwner: parsed.nameWithOwner };
}

/** The GitHub repository the Pull Requests open in: --repo, or the push remote's configured GitHub URL. */
async function submitRepository(remote: string, cwd: string): Promise<{ host: string; nameWithOwner: string }> {
  const explicit = getFlags().repo ? parseRepoFlag(getFlags().repo) : null;
  if (explicit) return { host: explicit.host.toLowerCase(), nameWithOwner: explicit.nameWithOwner };
  const configured = await run("git", ["config", "--get", `remote.${remote}.url`], { cwd, reject: false });
  const repository = configured.exitCode === 0 ? githubRepository(configured.stdout.trim()) : null;
  if (!repository) throw new Error("Push remote " + remote + " is not a GitHub repository URL. stack submit opens Pull Requests on GitHub; point " + remote + " at GitHub or pass --repo.");
  const environment = process.env.GH_REPO ? parseRepoFlag(process.env.GH_REPO) : null;
  if (environment && (environment.host.toLowerCase() !== repository.host || environment.nameWithOwner.toLowerCase() !== repository.nameWithOwner.toLowerCase())) {
    throw new Error("GH_REPO targets " + environment.nameWithOwner + ", but push remote " + remote + " points to " + repository.nameWithOwner + ". Refusing to push to one repository and open Pull Requests in another.");
  }
  return repository;
}

async function buildSubmitPlan(
  selected: string,
  chain: Array<{ branch: string; parent: string }>,
  graph: Map<string, StackNode>,
  options: { draft: boolean; nativeStack: boolean; allowStale: boolean },
  cwd: string,
): Promise<SubmitPlan> {
  if (chain.length > MAX_SUBMIT_BRANCHES) throw new Error("stack submit handles at most " + MAX_SUBMIT_BRANCHES + " branches per run. Submit a lower part of the stack first.");
  const root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  let target: { host: string; nameWithOwner: string } | undefined;
  const entries: SubmitEntryPlan[] = [];
  // Resolve each remote and each tip once; stacks usually share one remote and chain their tips.
  const destinations = new Map<string, { repository: { host: string; nameWithOwner: string }; pushUrl: string }>();
  const tips = new Map<string, string | null>();
  const tipOf = async (name: string) => tips.has(name) ? tips.get(name) ?? null : tips.set(name, await localTip(name, cwd)).get(name) ?? null;
  for (const item of chain) {
    const remote = await resolvePushRemote(item.branch, cwd);
    let destination = destinations.get(remote);
    if (!destination) {
      const pushUrl = await remotePushUrl(remote, cwd);
      if (hasUrlCredentials(pushUrl)) throw new Error("The push URL for remote " + remote + " embeds credentials. Use a credential helper instead; the URL will not be shown.");
      destination = { repository: await submitRepository(remote, cwd), pushUrl };
      destinations.set(remote, destination);
    }
    const { repository, pushUrl } = destination;
    if (target && (target.host !== repository.host || target.nameWithOwner.toLowerCase() !== repository.nameWithOwner.toLowerCase())) {
      throw new Error("Stack branches push to different GitHub repositories (" + target.nameWithOwner + " and " + repository.nameWithOwner + "). Configure one push remote for the stack.");
    }
    target ??= repository;
    const tip = await tipOf(item.branch);
    if (!tip) throw new Error("Branch " + item.branch + " has no commit to submit.");
    entries.push({ branch: item.branch, parent: item.parent, tip, parentTip: await tipOf(item.parent), behind: graph.get(item.branch)?.parent ? graph.get(item.branch)?.behind ?? 0 : 0, remote, pushUrl });
  }
  if (!target) throw new Error("Nothing to submit.");
  return { schemaVersion: 1, root, host: target.host, repository: target.nameWithOwner, selected, draft: options.draft, nativeStack: options.nativeStack, allowStale: options.allowStale, entries };
}

function submitSnapshot(plan: SubmitPlan): string {
  return createHash("sha256").update(JSON.stringify({ kind: "stack-submit", ...plan })).digest("hex");
}

function submitEffects(plan: Pick<SubmitPlan, "entries" | "nativeStack">): string[] {
  return [...plan.entries.flatMap((entry) => ["push:" + entry.branch, "create_pr:" + entry.branch]), ...(plan.nativeStack ? ["link_native_stack"] : [])];
}

/** Per-step effects: a started push or PR without a confirmed result is uncertain, not pending. */
function submitProgress(checkpoint: StackRecoveryCheckpoint, linkNative: boolean, native?: NativeStackRegistration): SubmitProgress {
  const progress: SubmitProgress = { completed: [], remaining: [], uncertain: [] };
  for (const entry of checkpoint.entries) {
    const pushed = entry.pushState === "completed";
    (pushed ? progress.completed : entry.pushState === "unknown" ? progress.uncertain : progress.remaining).push("push:" + entry.branch);
    (entry.pullRequestUrl ? progress.completed : pushed && (entry.state === "unknown" || entry.state === "failed") ? progress.uncertain : progress.remaining).push("create_pr:" + entry.branch);
  }
  if (linkNative) {
    if (native && "number" in native && (native.state === "created" || native.state === "extended" || native.state === "unchanged")) progress.completed.push("link_native_stack");
    else if (native?.state === "unavailable") progress.uncertain.push("link_native_stack");
    else progress.remaining.push("link_native_stack");
  }
  return progress;
}

function submitSteps(progress: SubmitProgress): OperationRecord["steps"] {
  return [
    ...progress.completed.map((name) => ({ name, state: "completed" as const })),
    ...progress.uncertain.map((name) => ({ name, state: "unknown" as const })),
    ...progress.remaining.map((name) => ({ name, state: "pending" as const })),
  ];
}

function describeSubmitPlan(plan: SubmitPlan, snapshotId: string): string {
  const remotes = [...new Map(plan.entries.map((entry) => [entry.remote, entry.pushUrl])).entries()].map(([remote, url]) => remote + " push → " + url);
  const rows = plan.entries.map((entry) => entry.branch + " " + entry.tip.slice(0, 12) + " → " + entry.parent + " " + (entry.parentTip?.slice(0, 12) ?? "(not local)") + (entry.behind ? "  " + entry.behind + " behind parent" : ""));
  return [plan.host + "/" + plan.repository, ...remotes, ...rows, (plan.draft ? "Draft" : "Ready for review") + " · " + (plan.nativeStack ? "link as a GitHub stack" : "no GitHub stack link"), "snapshot " + snapshotId].join("\n");
}

function requireSubmitInput(message: string, name: string, description: string, code: "missing_input" | "confirmation_required", alternatives?: string[]): void {
  const requiredInputs = [{ name, description, ...(alternatives ? { alternatives } : {}) }];
  fail(message, { code, requiredInputs });
  recordCommandIssue({ status: "needs_input", code, message, requiredInputs });
}

/** GitHub stacks are a single chain: each branch's parent is the branch below it. */
function isLinearStack(plan: Array<{ branch: string; parent: string }>): boolean {
  return plan.every((item, index) => index === 0 || item.parent === plan[index - 1]?.branch);
}

async function linkNativeStack(opened: Array<{ url: string }>): Promise<NativeStackRegistration> {
  const targets = opened.map((item) => parsePullRequestUrl(item.url));
  if (targets.some((target) => !target)) return { state: "skipped", reason: "A Pull Request URL could not be read." };
  return registerNativeStack(targets as PullRequestTarget[]);
}

export function registerStackCommand(program: Command): void {
  const stack = program
    .command("stack")
    .alias("stk")
    .description("Stacked branches: view, restack, and submit the chain");

  stack.command("list", { isDefault: true })
    .alias("ls")
    .description("Show the branch stack as a tree")
    .option("--all", "Show every branch, not just the current stack")
    .option("--remote", "Include GitHub Pull Request review and CI status")
    .action(async (options?: { all?: boolean; remote?: boolean }) => {
      header("Branch Stack");
      if (!(await requireGitRepo())) return;

      const [graph, defaultBranch] = await Promise.all([getStackGraph(), detectDefaultBranch()]);
      if (graph.size === 0) {
        if (jsonOut([])) return;
        p.log.info(pc.dim("No branches yet."));
        return;
      }

      if (!options?.remote && jsonOut([...graph.values()])) return;

      const current = await getCurrentBranch();
      let roots = [...graph.values()].filter((n) => !n.parent).map((n) => n.branch).sort();

      if (!options?.all) {
        // Narrow to the tree the current branch belongs to.
        const ancestors = getStackAncestors(graph, current);
        const rootOfCurrent = ancestors.at(-1) ?? current;
        if (roots.includes(rootOfCurrent)) roots = [rootOfCurrent];
      }

      let remote: Map<string, StackRemoteStatus> | undefined;
      if (options?.remote) {
        const visibleBranches = options.all
          ? [...graph.keys()]
          : [...new Set(roots.flatMap((root) => [root, ...getStackDescendants(graph, root)]))];
        remote = await remoteStatuses(visibleBranches, process.cwd());
        const visible = new Set(visibleBranches);
        if (jsonOut([...graph.values()]
          .filter((node) => visible.has(node.branch))
          .map((node) => ({ ...node, remote: remote?.get(node.branch) ?? { state: "unavailable" as const, reason: "Remote status was not collected." } })))) return;
      }

      for (const line of renderTree(graph, roots, defaultBranch, remote)) {
        p.log.message(line);
      }

      const drifted = [...graph.values()].filter((n) => n.behind > 0);
      if (drifted.length > 0) {
        p.log.warn(
          `${drifted.length} branch(es) are behind their parent. Run ${pc.bold(pc.cyan("ggh stack restack"))} to replay them.`,
        );
      }
      p.outro(pc.dim(options?.all ? "every branch" : "run with --all to see every branch"));
    });

  stack.command("on <parent>")
    .description("Record the parent of the current branch, adopting it into a stack")
    .action(async (parent: string) => {
      header("Set Stack Parent");
      if (!(await requireGitRepo())) return;
      await withStackMutationLock(process.cwd(), "stack on", async () => {
        const [detached, current] = await Promise.all([isDetachedHead(), getCurrentBranch()]);
        if (detached) {
          fail("Cannot stack a branch from a detached HEAD. Please checkout a named branch first.");
          return;
        }
        if (current === parent) {
          fail("A branch cannot be stacked on itself.");
          return;
        }
        const graph = await getStackGraph();
        const invalidName = validateBranchName(parent);
        if (invalidName || !graph.has(parent)) { fail(invalidName || `Parent branch "${parent}" does not exist locally.`); return; }
        if (getStackAncestors(graph, parent).includes(current)) { fail("Recording this parent would create a stack cycle."); return; }
        // Already recorded: rewriting the parent tip would move the fork point restack relies on.
        const recordedTip = await run("git", ["config", `branch.${current}.gh-merge-base-sha`], { reject: false });
        if (graph.get(current)?.recordedParent === parent && recordedTip.stdout.trim()) {
          if (jsonOut({ status: "no_op", branch: current, parent })) return;
          p.log.info(`${pc.bold(current)} is already stacked on ${pc.bold(parent)}.`);
          return;
        }
        if (dryRun(`record ${current} as stacked on ${parent}`)) return;
        await setBranchMergeBase(current, parent);
        if (jsonOut({ status: "succeeded", branch: current, parent, completed: ["stack_parent_recorded"] })) return;
        p.log.success(pc.green(`${pc.bold(current)} is now stacked on ${pc.bold(parent)}.`));
        p.outro("Done.");
      });
    });

  stack
    .command("restack [branch]")
    .description("Rebase a branch and everything above it onto their recorded parents")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--continue", "Continue a rebase in progress, then finish restacking")
    .option("--abort", "Abort the current rebase and restore original branch tips")
    .action(async (branch?: string, options?: { yes?: boolean; continue?: boolean; abort?: boolean }) => {
      header("Restack");
      if (!(await requireGitRepo())) return;
      const cwd = process.cwd();
      if (getFlags().repo) {
        fail("stack restack operates on local branches and does not accept --repo. Remove -R/--repo.");
        return;
      }
      let releaseLock: (() => Promise<void>) | undefined;
      if (!getFlags().dryRun) {
        try { releaseLock = await acquireStackOperationLock(cwd, "stack restack"); }
        catch (error) { fail(String(error)); return; }
      }
      try {
        const inRebase = await isRebaseInProgress(cwd);

        if (options?.continue || options?.abort) {
          let checkpoint: StackRecoveryCheckpoint | null;
          try { checkpoint = await readStackRecovery(cwd); }
          catch (error) { fail("Could not read stack recovery state: " + String(error)); return; }
          if (!checkpoint || checkpoint.mode !== "restack") {
            fail("No resumable stack restack was found. Start with ggh stack restack.");
            return;
          }
          const active = checkpoint.entries[checkpoint.activeIndex];
          if (inRebase) {
            const rebaseBranch = await getRebaseBranch(cwd);
            if (!active || rebaseBranch !== active.branch) {
              fail("The active Git rebase does not match the saved stack step. Recovery state was kept.");
              return;
            }
          }
          if (dryRun(options.abort ? "abort the active stack restack and restore saved branch tips" : "continue the active stack restack")) return;
          if (options.abort) {
            try {
              if (inRebase) await execGitWithRetry(["rebase", "--abort"], { cwd });
              await restoreStackTips(checkpoint, cwd);
              await saveStackProgress(checkpoint, { state: "cancelled" }, cwd).catch(() => undefined);
              await discardRecovery(checkpoint, cwd);
              p.cancel("Restack aborted. Original branch tips were restored.");
              jsonOut({ status: "cancelled", operationId: checkpoint.operationId, completed: [], remaining: [] });
            } catch (error) {
              fail("Could not safely restore the stack: " + String(error));
              jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.filter((entry) => entry.state !== "completed").map((entry) => entry.branch), resources: checkpoint.resources });
            }
            return;
          }
          if (inRebase) {
            try {
              await execGitWithRetry(["rebase", "--continue"], { cwd, env: { ...process.env, GIT_EDITOR: "true" } });
              if (active) {
                active.expectedTip = await getBranchTip(active.branch, cwd);
                active.state = "completed";
                await recordParentTip(active.branch, active.parent, cwd);
                checkpoint.activeIndex += 1;
                await writeStackRecovery(checkpoint, cwd);
                await saveStackProgress(checkpoint, { state: "running" }, cwd);
              }
            } catch (error) {
              fail("Failed to continue rebase: " + String(error));
              jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.slice(checkpoint.activeIndex).map((entry) => entry.branch), resources: checkpoint.resources });
              return;
            }
          } else if (active && active.state === "unknown") {
            fail("The active stack step has an unknown result. Inspect its branch tip before retrying.");
            jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.slice(checkpoint.activeIndex).map((entry) => entry.branch), resources: checkpoint.resources });
            return;
          }
          try {
            const stoppedAt = await replayStackFrom(checkpoint, checkpoint.activeIndex, cwd);
            if (stoppedAt !== null) {
              const stopped = checkpoint.entries[stoppedAt];
              const guidance = stopped?.state === "failed"
                ? "Resolve the conflict, then run ggh stack restack --continue. Use ggh stack restack --abort to restore original tips."
                : "The step result is uncertain. Inspect its branch tip or run ggh stack restack --abort if the saved tips still match.";
              fail("Restack stopped at " + stopped?.branch + ". " + guidance);
              jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.slice(stoppedAt).map((entry) => entry.branch), resources: checkpoint.resources });
              return;
            }
            await switchBranch(checkpoint.originalBranch, false, cwd);
            await saveStackProgress(checkpoint, { state: "succeeded" }, cwd);
            await discardRecovery(checkpoint, cwd);
            p.log.success(pc.green("Stack replayed cleanly."));
            jsonOut({ status: "succeeded", operationId: checkpoint.operationId, completed: checkpoint.entries.map((entry) => entry.branch), remaining: [] });
            p.outro("Done.");
          } catch (error) {
            if (!(await isRebaseInProgress(cwd))) await switchBranch(checkpoint.originalBranch, false, cwd).catch(() => undefined);
            fail("Restack recovery stopped: " + String(error));
            jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.filter((entry) => entry.state !== "completed").map((entry) => entry.branch), resources: checkpoint.resources });
          }
          return;
        }

        // A stopped restack leaves HEAD detached mid-rebase; name the unfinished work, not the symptom.
        const unfinished = await readStackRecovery(cwd).catch(() => null);
        if (unfinished?.mode === "restack" || inRebase) {
          fail(unfinished?.mode === "restack"
            ? `A stack restack of ${unfinished.selected} stopped before finishing. Resolve any conflicts, then run ggh stack restack --continue, or run ggh stack restack --abort to restore the original tips.`
            : "A rebase is already in progress. Finish it with ggh stack restack --continue or ggh stack restack --abort.", { code: "precondition_failed" });
          return;
        }
        if (await isDetachedHead(cwd)) { fail("Cannot restack from a detached HEAD. Checkout a named branch first.", { code: "precondition_failed" }); return; }
        const status = await getStatus(cwd);
        if (status.staged.length || status.unstaged.length || status.conflicts.length) {
          fail("Working tree has uncommitted changes. Commit or stash them before restacking.");
          return;
        }

        const [defaultBranch, original] = await Promise.all([detectDefaultBranch(cwd), getCurrentBranch(cwd)]);
        const start = branch || original;
        const graph = await getStackGraph(cwd);
        if (!graph.has(start)) { fail("Branch '" + start + "' not found."); return; }
        const order = [start, ...getStackDescendants(graph, start)].filter((name) =>
          graph.get(name)?.parent || (graph.get(name)?.recordedParent && !graph.get(name)?.parentExists),
        );
        const plan = order.flatMap((name) => {
          const node = graph.get(name);
          const parent = node?.parent ?? (node?.recordedParent && !node.parentExists ? defaultBranch : null);
          return parent ? [{ branch: name, parent }] : [];
        });
        if (plan.length === 0) {
          p.log.info(pc.dim(start + " has no recorded parent and nothing stacked on it."));
          jsonOut({ status: "succeeded", completed: [], remaining: [] });
          return;
        }
        p.log.step("Will replay " + plan.length + " branch(es):");
        for (const item of plan) p.log.message("  " + pc.cyan(item.branch) + " " + pc.dim("onto") + " " + pc.cyan(item.parent));
        if (dryRun("rebase " + plan.length + " branch(es)")) {
          jsonOut({ status: "planned", operation: "restack", selected: start, branches: plan });
          return;
        }
        if (!(await confirmOrAbort("Rebase " + plan.length + " branch(es)?", { assumeYes: options?.yes, cancelText: "Restack cancelled." }))) return;

        let checkpoint: StackRecoveryCheckpoint;
        try { checkpoint = await initializeRecovery("restack", start, original, plan, cwd); }
        catch (error) { fail("Could not start a durable restack: " + String(error)); return; }
        try {
          const stoppedAt = await replayStackFrom(checkpoint, 0, cwd);
          if (stoppedAt !== null) {
            const stopped = checkpoint.entries[stoppedAt];
            const guidance = stopped?.state === "failed"
              ? "Resolve the conflict, then run ggh stack restack --continue. Use ggh stack restack --abort to restore original tips."
              : "The step result is uncertain. Inspect its branch tip or run ggh stack restack --abort if the saved tips still match.";
            fail("Restack stopped at " + stopped?.branch + ". " + guidance);
            jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.slice(stoppedAt).map((entry) => entry.branch), resources: checkpoint.resources });
            return;
          }
          await switchBranch(original, false, cwd);
          await saveStackProgress(checkpoint, { state: "succeeded" }, cwd);
          await discardRecovery(checkpoint, cwd);
          p.log.success(pc.green("Stack replayed cleanly."));
          jsonOut({ status: "succeeded", operationId: checkpoint.operationId, completed: checkpoint.entries.map((entry) => entry.branch), remaining: [] });
          p.outro("Done.");
        } catch (error) {
          if (!(await isRebaseInProgress(cwd))) await switchBranch(original, false, cwd).catch(() => undefined);
          fail("Restack stopped: " + String(error));
          jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, completed: checkpoint.entries.filter((entry) => entry.state === "completed").map((entry) => entry.branch), remaining: checkpoint.entries.filter((entry) => entry.state !== "completed").map((entry) => entry.branch), resources: checkpoint.resources });
        }
      } finally {
        await releaseLock?.();
      }
    });

  stack
    .command("submit [branch]")
    .description("Push the selected stack and open a Pull Request for each branch against its parent")
    .option("-d, --draft", "Open every Pull Request as a draft")
    .option("--no-native-stack", "Do not link the Pull Requests as a GitHub stack")
    .option("--allow-stale", "Submit branches that are behind their parent instead of restacking first")
    .option("--approve-plan <sha256>", "Approve the exact dry-run snapshot, required for agents")
    .option("-y, --yes", "Skip the confirmation prompt; agents need --approve-plan instead")
    .action(async (branch?: string, options?: { draft?: boolean; yes?: boolean; nativeStack?: boolean; allowStale?: boolean; approvePlan?: string }) => {
      header("Submit Stack");
      if (!(await requireGitRepo())) return;
      const cwd = process.cwd();
      let releaseLock: (() => Promise<void>) | undefined;
      if (!getFlags().dryRun) {
        try { releaseLock = await acquireStackOperationLock(cwd, "stack submit"); }
        catch (error) { fail(String(error)); return; }
      }
      try {
        if (!branch && await isDetachedHead(cwd)) {
          fail("Cannot submit a stack from a detached HEAD. Checkout a named branch first.");
          return;
        }
        const [authed, original, graph, defaultBranch] = await Promise.all([
          requireAuth(),
          getCurrentBranch(cwd),
          getStackGraph(cwd),
          detectDefaultBranch(cwd),
        ]);
        if (!authed) return;
        const start = branch || original;
        if (!graph.has(start)) { fail("Branch '" + start + "' not found locally."); return; }
        const ancestors = getStackAncestors(graph, start).reverse();
        const selectedTree = [start, ...getStackDescendants(graph, start)];
        const chain = [...ancestors, ...selectedTree].filter((name, index, all) =>
          name !== defaultBranch && graph.has(name) && all.indexOf(name) === index,
        );
        if (chain.length === 0) {
          fail(start + " is not part of a stack. Use ggh stack on <parent> to record its parent.");
          return;
        }
        const plan = chain.map((name) => ({ branch: name, parent: graph.get(name)?.parent ?? defaultBranch }));
        try { await assertExplicitSubmitTarget(plan, cwd); }
        catch (error) { fail(String(error)); return; }
        const linkNative = options?.nativeStack !== false && plan.length > 1 && isLinearStack(plan);
        const linkText = linkNative ? " and link them as a GitHub stack" : "";
        let submission: SubmitPlan;
        try { submission = await buildSubmitPlan(start, plan, graph, { draft: Boolean(options?.draft), nativeStack: linkNative, allowStale: Boolean(options?.allowStale) }, cwd); }
        catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
        const snapshotId = submitSnapshot(submission);
        const effects = submitEffects(submission);
        const summary = { operation: "submit", selected: start, snapshotId, plan: submission, branches: plan, nativeStack: linkNative };
        p.log.step("Stack from the bottom up:");
        for (const item of plan) p.log.message("  " + pc.cyan(item.branch) + " " + pc.dim("→") + " " + pc.cyan(item.parent));
        p.note(describeSubmitPlan(submission, snapshotId), "Submission plan");

        const stale = submission.entries.filter((entry) => entry.behind > 0);
        if (stale.length && !options?.allowStale) {
          const message = stale.map((entry) => entry.branch + " is " + entry.behind + " behind " + entry.parent).join("; ") + ". Run ggh stack restack " + start + " first, or pass --allow-stale to submit them as they are.";
          requireSubmitInput(message, "--allow-stale", "Submit branches that are behind their parent without restacking.", "missing_input", ["ggh stack restack " + start]);
          jsonOut({ status: "needs_input", ...summary, stale: stale.map((entry) => ({ branch: entry.branch, parent: entry.parent, behind: entry.behind })), completed: [], remaining: effects });
          return;
        }
        if (options?.approvePlan !== undefined && (!/^[a-f0-9]{64}$/.test(options.approvePlan) || options.approvePlan !== snapshotId)) {
          requireSubmitInput("Stack submission snapshot does not match --approve-plan. Review a fresh --dry-run and approve its snapshotId.", "--approve-plan", "Review a fresh dry-run and supply its snapshotId.", "confirmation_required");
          jsonOut({ status: "needs_input", ...summary, completed: [], remaining: effects });
          return;
        }
        if (dryRun("push and open " + plan.length + " Pull Request(s)" + linkText)) {
          jsonOut({ status: "planned", ...summary, completed: [], remaining: effects });
          return;
        }
        // An agent's --yes is not an approval of what will be published.
        if (getFlags().agent && !options?.approvePlan) {
          requireSubmitInput("Review ggh stack submit --dry-run --agent, then supply --approve-plan <snapshotId>. --yes does not approve an agent submission.", "--approve-plan", "Review the dry-run plan and supply its snapshotId.", "confirmation_required");
          jsonOut({ status: "needs_input", ...summary, completed: [], remaining: effects });
          return;
        }
        if (!(await confirmOrAbort("Push and open Pull Requests for " + plan.length + " branch(es)" + linkText + "?", { assumeYes: options?.yes || Boolean(options?.approvePlan) }))) return;

        let checkpoint: StackRecoveryCheckpoint;
        try {
          const existing = await readStackRecovery(cwd);
          if (existing) {
            const matches = existing.mode === "submit" && existing.selected === start &&
              existing.entries.length === submission.entries.length && existing.entries.every((entry, index) => entry.branch === submission.entries[index]?.branch && entry.parent === submission.entries[index]?.parent && entry.remote === submission.entries[index]?.remote);
            if (!matches) throw new Error("Another stack operation is unfinished. Resume or abort it before starting this submission.");
            checkpoint = existing;
          } else {
            checkpoint = await initializeRecovery("submit", start, original, submission.entries, cwd, effects);
          }
        } catch (error) { fail("Could not start or resume stack submission: " + String(error)); return; }

        const opened: Array<{ branch: string; base: string; url: string }> = checkpoint.entries.flatMap((entry) =>
          entry.pullRequestUrl ? [{ branch: entry.branch, base: entry.parent, url: entry.pullRequestUrl }] : [],
        );
        const save = (state: OperationStatus) => saveStackProgress(checkpoint, state, cwd, submitSteps(submitProgress(checkpoint, linkNative)));
        // Keep the checkpoint and report every effect by name, so a retry resumes instead of repeating.
        const stop = async (message: string): Promise<void> => {
          await writeStackRecovery(checkpoint, cwd);
          await save({ state: "partially_completed" }).catch(() => undefined);
          fail(message);
          await switchBranch(original, false, cwd).catch(() => undefined);
          jsonOut({ status: "partially_completed", operationId: checkpoint.operationId, snapshotId, ...submitProgress(checkpoint, linkNative), opened, resources: checkpoint.resources, error: { message } });
        };
        const repo = submission.host + "/" + submission.repository;
        for (let index = 0; index < checkpoint.entries.length; index += 1) {
          const entry = checkpoint.entries[index];
          const planned = submission.entries[index];
          if (!entry || !planned) continue;
          checkpoint.activeIndex = index;
          const actual = await getBranchTip(entry.branch, cwd).catch(() => "");
          if (actual !== entry.originalTip || actual !== planned.tip) {
            entry.state = "unknown";
            await stop("Branch " + entry.branch + " changed after the submission plan. Expected " + entry.originalTip + ", found " + (actual || "unavailable") + ". Recovery state was kept.");
            return;
          }
          if (entry.state === "completed" && entry.pullRequestUrl) continue;

          if (entry.pushState === "unknown" && entry.remote) {
            try {
              if (await remoteBranchTip(entry.remote, entry.branch, cwd) === entry.expectedTip) {
                entry.pushState = "completed";
                await writeStackRecovery(checkpoint, cwd);
                await save({ state: "running" });
              }
            } catch (error) {
              entry.state = "unknown";
              await stop("Could not inspect the remote result for " + entry.branch + ": " + String(error));
              return;
            }
          }
          if (entry.pushState !== "completed") {
            let destination = "";
            try { destination = await remotePushUrl(planned.remote, cwd); }
            catch (error) { destination = error instanceof Error ? error.message : String(error); }
            if (destination !== planned.pushUrl) {
              await stop("The push URL for remote " + planned.remote + " changed after the submission plan. Nothing was pushed for " + entry.branch + ". Review a fresh --dry-run.");
              return;
            }
            const pushSpinner = p.spinner();
            pushSpinner.start("Pushing " + pc.cyan(entry.branch) + "...");
            try {
              await switchBranch(entry.branch, false, cwd);
              const upstream = await getRemoteTrackingBranch(cwd, entry.branch);
              const forceWithLease = upstream ? !(await isAncestor(upstream, entry.branch, cwd)) : false;
              if (forceWithLease) p.log.warn("Remote " + pc.cyan(upstream) + " is not an ancestor of " + pc.cyan(entry.branch) + "; pushing with --force-with-lease.");
              entry.pushState = "unknown";
              entry.state = "unknown";
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: "running" });
              await push({ remote: entry.remote, branch: entry.branch, setUpstream: true, forceWithLease, cwd });
              entry.pushState = "completed";
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: "running" });
              pushSpinner.stop(pc.green(entry.branch + " pushed."));
            } catch (error) {
              // GitHub rejected a push-protection violation outright: the push
              // definitively did not happen, so record it as failed, not unknown.
              const blocked = error instanceof PushProtectionError;
              entry.pushState = blocked ? "failed" : "unknown";
              entry.state = blocked ? "failed" : "unknown";
              pushSpinner.stop(pc.red((blocked ? "GitHub push protection blocked " : "Failed to push ") + entry.branch + "."));
              if (!blocked) { await stop(error instanceof Error ? error.message : String(error)); return; }
              const anyCompleted = checkpoint.entries.some((item) => item.state === "completed");
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: anyCompleted ? "partially_completed" : "failed" }).catch(() => undefined);
              failFromPush(error);
              // Removing the secret rewrites this branch, which invalidates the
              // saved plan; no remote outcome is uncertain, so drop the checkpoint.
              await discardRecovery(checkpoint, cwd).catch(() => undefined);
              p.log.info("After removing the secret, run ggh stack restack so descendants pick up the rewritten commits, then ggh stack submit again.");
              await switchBranch(original, false, cwd).catch(() => undefined);
              jsonOut({ status: anyCompleted ? "partially_completed" : "failed", operationId: checkpoint.operationId, snapshotId, ...submitProgress(checkpoint, linkNative), failed: ["push:" + entry.branch], pushProtection: error.details, opened, resources: checkpoint.resources, error: { message: error.message } });
              return;
            }
          }

          await switchBranch(entry.branch, false, cwd);
          try {
            const existing = await getActivePullRequest(cwd);
            if (existing) {
              entry.pullRequestUrl = existing.url;
              entry.state = "completed";
              if (!checkpoint.resources.includes(existing.url)) checkpoint.resources.push(existing.url);
              if (!opened.some((item) => item.branch === entry.branch)) opened.push({ branch: entry.branch, base: entry.parent, url: existing.url });
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: "running" });
              p.log.info(pc.cyan(entry.branch) + " already has Pull Request #" + existing.number + "; the push updated it.");
              continue;
            }
            const prSpinner = p.spinner();
            prSpinner.start("Opening Pull Request for " + pc.cyan(entry.branch) + " against " + pc.cyan(entry.parent) + "...");
            try {
              entry.state = "unknown";
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: "running" });
              const stackText = checkpoint.entries.map((item) => item.branch === entry.branch ? "- **" + item.branch + "** ← this Pull Request" : "- " + item.branch).join("\n");
              // The approved repository, never whichever repository gh would infer.
              const url = await createPullRequest({
                title: entry.branch,
                body: "Part of a stack. Base: `" + entry.parent + "`.\n\nStack:\n" + stackText,
                base: entry.parent,
                head: entry.branch,
                draft: submission.draft,
                cwd,
                repo,
                host: submission.host,
              });
              entry.pullRequestUrl = url;
              entry.state = "completed";
              if (!checkpoint.resources.includes(url)) checkpoint.resources.push(url);
              opened.push({ branch: entry.branch, base: entry.parent, url });
              await writeStackRecovery(checkpoint, cwd);
              await save({ state: "running" });
              prSpinner.stop(pc.green("Pull Request opened for " + entry.branch + "."));
            } catch (error) {
              entry.state = "unknown";
              prSpinner.stop(pc.red("Could not confirm a Pull Request for " + entry.branch + "."));
              await stop(error instanceof Error ? error.message : String(error));
              return;
            }
          } catch (error) {
            entry.state = "unknown";
            await stop(error instanceof Error ? error.message : String(error));
            return;
          }
        }

        await switchBranch(original, false, cwd).catch(() => undefined);
        await save({ state: "succeeded" });
        await discardRecovery(checkpoint, cwd);
        const nativeStack: NativeStackRegistration = linkNative ? await linkNativeStack(opened) : {
          state: "skipped",
          reason: options?.nativeStack === false ? "Disabled with --no-native-stack."
            : plan.length < 2 ? "A GitHub stack needs at least two pull requests."
              : "GitHub stacks are linear; this selection is not a single chain.",
        };
        if (jsonOut({ status: "succeeded", snapshotId, opened, nativeStack, ...submitProgress(checkpoint, linkNative, nativeStack) })) return;
        for (const entry of opened) p.log.message("  " + pc.cyan(entry.branch) + " → " + pc.cyan(entry.base) + "  " + pc.dim(entry.url));
        if (nativeStack.state === "created" || nativeStack.state === "extended") p.log.info("Linked as GitHub stack #" + nativeStack.number + ".");
        else if (nativeStack.state === "unchanged") p.log.info("GitHub stack #" + nativeStack.number + " already matches.");
        else if (linkNative && "reason" in nativeStack) p.log.warn("Not linked as a GitHub stack: " + nativeStack.reason);
        p.outro(pc.green(opened.length + " Pull Request(s) in the stack."));
      } finally {
        await releaseLock?.();
      }
    });

  stack.command("next")
    .description("Create a branch stacked on the current one")
    .argument("[name]", "Branch name")
    .action(async (name?: string) => {
      header("Stack a New Branch");
      if (!(await requireGitRepo())) return;
      await withStackMutationLock(process.cwd(), "stack next", async () => {
        if (await isDetachedHead()) {
          fail("Cannot stack a branch from a detached HEAD. Checkout a named branch first.");
          return;
        }
        const parent = await getCurrentBranch();

        let branch = name;
        if (!branch) {
          const typed = await promptInput({
            message: `New branch stacked on ${parent}:`,
            validate: (v) => {
              if (!v || !v.trim()) return "Branch name required";
              return validateBranchName(v.trim()) || undefined;
            },
          });
          if (!typed) {
            p.cancel("Cancelled.");
            return;
          }
          branch = typed.trim().replace(/\s+/g, "-");
        } else {
          const validationError = validateBranchName(branch);
          if (validationError) {
            fail(validationError);
            return;
          }
        }

        if (dryRun(`create ${branch} stacked on ${parent}`)) return;
        try {
          await switchBranch(branch, true, process.cwd(), parent);
          if (jsonOut({ branch, parent, created: true })) return;
          p.log.success(pc.green(`Created ${pc.bold(branch)} stacked on ${pc.bold(parent)}.`));
          p.outro("Done.");
        } catch (err) {
          failFromGitHub(err);
        }
      });
    });

  stack.command("checkout")
    .alias("co")
    .description("Pick a branch from the stack and switch to it")
    .action(async () => {
      header("Switch Within Stack");
      if (!(await requireGitRepo())) return;
      await withStackMutationLock(process.cwd(), "stack checkout", async () => {
        const graph = await getStackGraph();
        const items = [...graph.values()].map((n) => ({
          value: n.branch,
          label: n.isCurrent ? `* ${n.branch}` : n.branch,
          hint: n.parent ? `on ${n.parent}${n.behind > 0 ? ` · ${n.behind} behind` : ""}` : "root",
        }));
        const picked = await searchablePicker<string>({ title: "Switch to:", items, pageSize: 10 });
        if (!picked) {
          p.cancel("Cancelled.");
          return;
        }
        if (dryRun(`switch to ${picked}`)) return;
        try {
          await switchBranch(picked);
          p.log.success(pc.green(`Switched to ${pc.bold(picked)}.`));
          p.outro("Done.");
        } catch (err) {
          failFromGitHub(err);
        }
      });
    });
}
