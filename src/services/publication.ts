import { publicationSnapshot, assertPublicationApproval, type PublicationContent } from "./publication-approval.ts";
import { basename, resolve } from "node:path";
import { getActiveOperation, setActiveOperation } from "./runtime.ts";
import { claimOperationResume, updateOperation } from "./operations.ts";
import { publicationIntent, type PublicationIntent } from "./publication-intent.ts";
import { run } from "../utils/exec.ts";
import {
  classifyGitHubError,
  GitHubError,
  createRepository,
  getActiveHost,
  getGitHubAuthStatus,
  gh,
  ghGlobal,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseRepoFlag,
  createPullRequest,
  editPullRequest,
  prepareAttachmentPlan,
  PartialGitHubMutationError,
  PartialAttachmentOperationError,
} from "./github.ts";
import { execGitWithRetry } from "./git/exec.ts";
import { getRepoRoot } from "./git/branch.ts";
import { detectPullRequestBase } from "./git/sync.ts";

export type RepositoryVisibility = "public" | "private" | "internal";

export type PublicationRequest =
  | {
      kind: "repo";
      cwd?: string;
      source?: string;
      name?: string;
      description?: string;
      visibility?: RepositoryVisibility;
      remote?: string;
      push?: boolean;
    }
  | {
      kind: "pr";
      cwd?: string;
      source?: string;
      name?: string;
      visibility?: RepositoryVisibility;
      base?: string;
      remote?: string;
    };

export type PublicationStep =
  | "create_repository"
  | "add_remote"
  | "push_base"
  | "push_head"
  | "set_base_upstream"
  | "set_head_upstream"
  | "create_pull_request"
  | "open_create_page"
  | "upload_attachments";

export interface RepositoryPlan {
  kind: "repo";
  cwd: string;
  root?: string;
  source?: string;
  host: string;
  target: string;
  remote: string;
  remoteUrl: string;
  visibility: RepositoryVisibility;
  description?: string;
  push: boolean;
  head?: string;
  headTip?: string;
  remoteHeadTip?: string;
  remoteAtPrepare?: string;
  steps: PublicationStep[];
}

export interface PullRequestPlan {
  kind: "pr";
  cwd: string;
  root: string;
  source?: string;
  host: string;
  target: string;
  remote: string;
  remoteUrl: string;
  visibility: RepositoryVisibility;
  remoteAtPrepare?: string;
  createRepository: boolean;
  head: string;
  headTip: string;
  remoteHeadTip?: string;
  base: string;
  baseTip: string;
  localBaseTip?: string;
  remoteBaseTip?: string;
  mergeBaseTip: string;
  steps: PublicationStep[];
}

export type PublicationPlan = RepositoryPlan | PullRequestPlan;

export type PreparePublicationResult =
  | { status: "ready"; plan: PublicationPlan }
  | {
      status: "needs_input";
      required: "name" | "base" | "branch" | "repository";
      message: string;
    };

export interface PublicationResult {
  status: "succeeded" | "partially_completed" | "failed";
  target: string;
  completed: PublicationStep[];
  remaining: PublicationStep[];
  url?: string;
  error?: string;
  attachments?: { uploaded: Array<{ file: string; url: string }>; remainingFiles: string[]; phase: "storage_upload" | "github_mutation" };
}

interface RemoteInfo {
  name: string;
  url: string;
  host: string;
  target: string | null;
}

async function git(
  args: string[],
  cwd: string,
  reject = true,
): Promise<string> {
  const result = await run("git", args, { cwd, reject });
  return result.stdout.trim();
}

function githubTarget(url: string): { host: string; target: string } | null {
  const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
  if (typeof parsed === "string") return { host: "github.com", target: parsed };
  return parsed
    ? { host: parsed.host.toLowerCase(), target: parsed.nameWithOwner }
    : null;
}

async function remotes(cwd: string): Promise<RemoteInfo[]> {
  const names = (await git(["remote"], cwd, false))
    .split(/\r?\n/)
    .filter(Boolean);
  return Promise.all(
    names.map(async (name) => {
      const url = await git(["config", "--get", `remote.${name}.url`], cwd);
      const repository = githubTarget(url);
      return {
        name,
        url,
        host: repository?.host ?? "",
        target: repository?.target ?? null,
      };
    }),
  );
}

async function tip(ref: string, cwd: string): Promise<string | null> {
  const value = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    cwd,
    false,
  );
  return value || null;
}

function validBranch(branch: string): boolean {
  return Boolean(branch) && !branch.startsWith("-") && !branch.includes("\0");
}

function validTarget(target: string): boolean {
  const [owner, repository, ...extra] = target.split("/");
  if (!owner || !repository || extra.length > 0) return false;
  return (
    /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) &&
    /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
}

async function validRemoteName(name: string, cwd: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  const result = await run(
    "git",
    ["check-ref-format", `refs/remotes/${name}`],
    { cwd, reject: false },
  );
  return result.exitCode === 0;
}

function repositoryUrl(
  host: string,
  target: string,
  protocol: "https" | "ssh" | undefined,
): string {
  return protocol === "ssh"
    ? `git@${host}:${target}.git`
    : `https://${host}/${target}.git`;
}

interface TargetIdentity {
  host: string;
  target: string;
}

function parseTargetName(
  value: string | undefined,
  host: string,
  owner: string,
): TargetIdentity | null {
  if (!value?.trim()) return null;
  const parts = value.trim().split("/");
  if (parts.length === 1) return { host, target: `${owner}/${parts[0]}` };
  if (parts.length === 2) return { host, target: value.trim() };
  if (parts.length === 3)
    return { host: parts[0] ?? "", target: `${parts[1]}/${parts[2]}` };
  return null;
}

async function isAncestor(
  ancestor: string,
  descendant: string,
  cwd: string,
): Promise<boolean> {
  const result = await run(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd, reject: false },
  );
  return result.exitCode === 0;
}

async function isValidBranch(branch: string, cwd: string): Promise<boolean> {
  return (
    validBranch(branch) &&
    (await git(["check-ref-format", "--branch", branch], cwd, false)) === branch
  );
}

function chooseRemote(
  items: RemoteInfo[],
  requested?: string,
): RemoteInfo | null {
  if (requested) return items.find((item) => item.name === requested) ?? null;
  return (
    items.find((item) => item.name === "origin") ??
    (items.length === 1 ? (items[0] ?? null) : null)
  );
}

export async function preparePublication(
  request: PublicationRequest,
): Promise<PreparePublicationResult> {
  const cwd = request.cwd ?? process.cwd();
  let root: string | undefined;
  try {
    root = await getRepoRoot(
      request.source ? resolve(cwd, request.source) : cwd,
    );
  } catch {
    if (request.source)
      return {
        status: "needs_input",
        required: "repository",
        message: `Source "${request.source}" is not a Git repository.`,
      };
  }

  const items = root ? await remotes(root) : [];
  const selected = chooseRemote(items, request.remote);
  if (
    !request.remote &&
    !items.some((item) => item.name === "origin") &&
    items.length > 1
  ) {
    return {
      status: "needs_input",
      required: "repository",
      message:
        "Choose a remote because this repository has multiple non-origin remotes.",
    };
  }
  if (selected && !selected.target) {
    return {
      status: "needs_input",
      required: "repository",
      message: `Remote "${selected.name}" is not a supported GitHub repository URL. Use a credential-free GitHub URL. The remote will not be changed.`,
    };
  }

  let flagRepo: ReturnType<typeof parseRepoFlag>;
  try {
    flagRepo = parseRepoFlag();
  } catch (error) {
    return {
      status: "needs_input",
      required: "repository",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const requestedHost = process.env.GH_HOST?.trim().toLowerCase();
  const nameParts = request.name?.trim().split("/") ?? [];
  const explicitNameHost =
    nameParts.length === 3 ? nameParts[0]?.toLowerCase() : undefined;
  if (
    requestedHost &&
    selected &&
    selected.host.toLowerCase() !== requestedHost
  ) {
    return {
      status: "needs_input",
      required: "repository",
      message: `Remote "${selected.name}" uses ${selected.host}, but GH_HOST targets ${requestedHost}.`,
    };
  }
  const host = (
    selected?.host ??
    flagRepo?.host ??
    explicitNameHost ??
    requestedHost ??
    getActiveHost()
  ).toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/.test(host)) {
    return {
      status: "needs_input",
      required: "repository",
      message: `Invalid GitHub host "${host}".`,
    };
  }
  const account = await getGitHubAuthStatus(host);
  if (!account.authenticated || !account.login) {
    throw new GitHubError(
      account.notInstalled ? "not_installed" : "not_authenticated",
      account.notInstalled
        ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
        : "GitHub CLI must be authenticated with an account name to prepare publication.",
    );
  }
  const accountHost = account.host ?? host;
  if (accountHost.toLowerCase() !== host.toLowerCase()) {
    return {
      status: "needs_input",
      required: "repository",
      message: `Authenticated GitHub host ${accountHost} does not match target host ${host}.`,
    };
  }
  const nameOwner = selected?.target?.split("/")[0] ?? account.login;
  const nameIdentity = parseTargetName(request.name, host, nameOwner);
  if (nameIdentity && !validTarget(nameIdentity.target))
    return {
      status: "needs_input",
      required: "name",
      message: "Use a repository name such as `project` or `owner/project`.",
    };
  if (
    selected &&
    nameIdentity &&
    (nameIdentity.host.toLowerCase() !== selected.host.toLowerCase() ||
      nameIdentity.target.toLowerCase() !== selected.target?.toLowerCase())
  ) {
    return {
      status: "needs_input",
      required: "repository",
      message: `Requested repository ${nameIdentity.target} conflicts with remote "${selected.name}" (${selected.target}).`,
    };
  }
  if (
    selected &&
    flagRepo &&
    (flagRepo.host.toLowerCase() !== selected.host.toLowerCase() ||
      flagRepo.nameWithOwner.toLowerCase() !== selected.target?.toLowerCase())
  ) {
    return {
      status: "needs_input",
      required: "repository",
      message: `GH_REPO targets ${flagRepo.nameWithOwner}, but remote "${selected.name}" points to ${selected.target}.`,
    };
  }
  if (
    flagRepo &&
    (flagRepo.host.toLowerCase() !== host.toLowerCase() ||
      (nameIdentity &&
        flagRepo.nameWithOwner.toLowerCase() !==
          nameIdentity.target.toLowerCase()))
  ) {
    return {
      status: "needs_input",
      required: "repository",
      message: `GH_REPO targets ${flagRepo.nameWithOwner} and conflicts with the requested publication target.`,
    };
  }

  if (request.kind === "repo") {
    const folderName = root ? basename(root) : undefined;
    const inferred =
      selected?.target ??
      (folderName ? `${account.login}/${folderName}` : null);
    const target =
      selected?.target ??
      flagRepo?.nameWithOwner ??
      nameIdentity?.target ??
      inferred;
    if (!target)
      return {
        status: "needs_input",
        required: "name",
        message: "Choose a repository name.",
      };
    if (!validTarget(target))
      return {
        status: "needs_input",
        required: "name",
        message: "Use a repository name such as `project` or `owner/project`.",
      };
    let visibility = request.visibility ?? "private";
    const push = request.push ?? Boolean(root);
    const remoteName = request.remote ?? selected?.name ?? "origin";
    if (!(await validRemoteName(remoteName, root ?? cwd)))
      return {
        status: "needs_input",
        required: "repository",
        message: `Remote name "${remoteName}" is invalid.`,
      };
    if (push && !root)
      return {
        status: "needs_input",
        required: "repository",
        message: "A local Git repository is required to push.",
      };
    const head = root
      ? await git(["branch", "--show-current"], root, false)
      : undefined;
    const headTip = root && head ? await tip("HEAD", root) : null;
    if (push && (!head || !headTip))
      return {
        status: "needs_input",
        required: "repository",
        message:
          "A checked out branch with at least one commit is required to push.",
      };
    const remoteUrl = selected?.url ?? repositoryUrl(host, target, account.protocol);
    const steps: PublicationStep[] = selected ? [] : ["create_repository"];
    if (root && !selected) steps.push("add_remote");
    let remoteHeadTip: string | null = null;
    if (selected && push && head && root) {
      try {
        remoteHeadTip = await remoteBranchTip(selected.name, head, root);
      } catch (error) {
        return {
          status: "needs_input",
          required: "repository",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (push && root && head && headTip) {
      if (
        remoteHeadTip &&
        remoteHeadTip !== headTip &&
        !(await isAncestor(remoteHeadTip, headTip, root))
      ) {
        return {
          status: "needs_input",
          required: "branch",
          message: `Remote branch "${head}" has commits that are not in the local branch.`,
        };
      }
      if (remoteHeadTip !== headTip) steps.push("push_head");
      else if (!(await hasBranchUpstream(remoteName, head, root))) steps.push("set_head_upstream");
    }
    if (selected) {
      const current = await inspectExistingRepository({ cwd, host, target });
      if (current.exists !== true) return { status: "needs_input", required: "repository", message: current.exists === "unknown" ? current.error : `Repository ${target} is unavailable. Check access before publication.` };
      visibility = current.visibility === "PUBLIC" ? "public" : current.visibility === "INTERNAL" ? "internal" : "private";
    }
    const plan: RepositoryPlan = {
      kind: "repo",
      cwd,
      root,
      ...(root ? { source: root } : {}),
      host,
      target,
      remote: remoteName,
      remoteUrl,
      visibility,
      ...(request.description ? { description: request.description } : {}),
      push,
      ...(head ? { head } : {}),
      ...(headTip ? { headTip } : {}),
      ...(remoteHeadTip ? { remoteHeadTip } : {}),
      ...(selected ? { remoteAtPrepare: selected.url } : {}),
      steps,
    };
    return { status: "ready", plan };
  }

  if (!root)
    return {
      status: "needs_input",
      required: "repository",
      message: "A local Git repository is required to open a pull request.",
    };
  const inferredTarget = `${account.login}/${basename(root)}`;
  const target =
    selected?.target ??
    flagRepo?.nameWithOwner ??
    nameIdentity?.target ??
    inferredTarget;
  if (!validTarget(target))
    return {
      status: "needs_input",
      required: "name",
      message: "Use a repository name such as `project` or `owner/project`.",
    };
  const head = await git(["branch", "--show-current"], root, false);
  const headTip = head ? await tip("HEAD", root) : null;
  if (!(await isValidBranch(head, root)) || !headTip)
    return {
      status: "needs_input",
      required: "branch",
      message:
        "Check out a named branch with at least one commit before opening a pull request.",
    };
  const baseName =
    request.base?.trim() || (await detectPullRequestBase(root).catch(() => ""));
  if (!baseName)
    return {
      status: "needs_input",
      required: "base",
      message:
        "Specify a base branch because the default is missing or ambiguous.",
    };
  if (!(await isValidBranch(baseName, root)) || baseName === head)
    return {
      status: "needs_input",
      required: "base",
      message:
        "Specify a valid base branch that differs from the current branch.",
    };
  const localBaseTip =
    (await tip(`refs/heads/${baseName}`, root)) ??
    (selected
      ? await tip(`refs/remotes/${selected.name}/${baseName}`, root)
      : null);
  if (!localBaseTip)
    return {
      status: "needs_input",
      required: "base",
      message: `Base branch "${baseName}" is not available locally. Fetch it before preparing the pull request.`,
    };
  const steps: PublicationStep[] = [];
  const createRepositoryForPr = !selected;
  const remoteName = selected?.name ?? request.remote ?? "origin";
  if (!(await validRemoteName(remoteName, root)))
    return {
      status: "needs_input",
      required: "repository",
      message: `Remote name "${remoteName}" is invalid.`,
    };
  const remoteUrl = selected?.url ?? repositoryUrl(host, target, account.protocol);
  let remoteBaseTip: string | null = null;
  let remoteHeadTip: string | null = null;
  if (selected) {
    try {
      [remoteBaseTip, remoteHeadTip] = await Promise.all([
        remoteBranchTip(remoteName, baseName, root),
        remoteBranchTip(remoteName, head, root),
      ]);
    } catch (error) {
      return {
        status: "needs_input",
        required: "repository",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let baseTip = localBaseTip;
  if (remoteBaseTip && remoteBaseTip !== localBaseTip) {
    const available = await run("git", ["cat-file", "-e", `${remoteBaseTip}^{commit}`], { cwd: root, reject: false });
    if (available.exitCode !== 0) return { status: "needs_input", required: "base", message: `Remote base "${baseName}" is newer than the local comparison. Run git fetch ${remoteName} ${baseName}, then prepare the plan again.` };
    baseTip = remoteBaseTip;
  }
    if (
      remoteHeadTip &&
      remoteHeadTip !== headTip &&
      !(await isAncestor(remoteHeadTip, headTip, root))
    ) {
      return {
        status: "needs_input",
        required: "branch",
        message: `Remote branch "${head}" has commits that are not in the local branch.`,
      };
    }
  const mergeBase = await run("git", ["merge-base", baseTip, headTip], {
    cwd: root,
    reject: false,
  });
  if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim())
    return {
      status: "needs_input",
      required: "base",
      message: `Branches "${baseName}" and "${head}" have no common commit.`,
    };
  const commitsAhead = await git(
    ["rev-list", "--count", `${baseTip}..${headTip}`],
    root,
    false,
  );
  if (Number.parseInt(commitsAhead, 10) < 1)
    return {
      status: "needs_input",
      required: "branch",
      message: `Branch "${head}" has no commits that differ from "${baseName}".`,
    };
  if (createRepositoryForPr) steps.push("create_repository", "add_remote");
  if (!remoteBaseTip) steps.push("push_base");
  else if (remoteBaseTip === localBaseTip && await tip(`refs/heads/${baseName}`, root) && !(await hasBranchUpstream(remoteName, baseName, root))) steps.push("set_base_upstream");
  if (remoteHeadTip !== headTip) steps.push("push_head");
  else if (!(await hasBranchUpstream(remoteName, head, root))) steps.push("set_head_upstream");
  let visibility = request.visibility ?? "private";
  if (selected) {
    const current = await inspectExistingRepository({ cwd, host, target });
    if (current.exists !== true) return { status: "needs_input", required: "repository", message: current.exists === "unknown" ? current.error : `Repository ${target} is unavailable. Check access before publication.` };
    visibility = current.visibility === "PUBLIC" ? "public" : current.visibility === "INTERNAL" ? "internal" : "private";
  }
  const planMergeBase = mergeBase.stdout.trim();
  steps.push("create_pull_request");
  return {
    status: "ready",
    plan: {
      kind: "pr",
      cwd,
      root,
      source: root,
      host,
      target,
      remote: remoteName,
      remoteUrl,
      visibility,
      createRepository: createRepositoryForPr,
      ...(selected ? { remoteAtPrepare: selected.url } : {}),
      head,
      headTip,
      ...(remoteHeadTip ? { remoteHeadTip } : {}),
      base: baseName,
      baseTip,
      localBaseTip,
      ...(remoteBaseTip ? { remoteBaseTip } : {}),
      mergeBaseTip: planMergeBase,
      steps,
    },
  };
}

async function currentRemotes(root: string): Promise<RemoteInfo[]> {
  return remotes(root);
}

async function remoteBranchTip(
  remote: string,
  branch: string,
  cwd: string,
): Promise<string | null> {
  const result = await run(
    "git",
    ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || `Could not inspect remote branch ${branch}.`,
    );
  return result.stdout.trim().split(/\s+/)[0] || null;
}

async function recheck(plan: PublicationPlan): Promise<string | null> {
  if (!plan.root) return null;
  const root = await getRepoRoot(plan.root);
  if (root !== plan.root)
    return "Repository location changed after publication was prepared.";
  const items = await currentRemotes(root);
  const existing = items.find((item) => item.name === plan.remote);
  if (plan.remoteAtPrepare && existing?.url !== plan.remoteAtPrepare)
    return `Remote "${plan.remote}" changed after publication was prepared.`;
  if (!plan.remoteAtPrepare && existing && existing.url !== plan.remoteUrl)
    return `Remote "${plan.remote}" was added after publication was prepared and points elsewhere. No remote will be overwritten.`;
  if (existing) {
    const repository = await inspectExistingRepository(plan);
    if (repository.exists !== true) return repository.exists === "unknown" ? repository.error : `Repository ${plan.target} no longer exists.`;
    const visibilityError = existingVisibilityError(plan, repository);
    if (visibilityError) return visibilityError.message;
  }
  if (plan.kind === "pr") {
    if (
      (await git(["branch", "--show-current"], root, false)) !== plan.head ||
      (await tip("HEAD", root)) !== plan.headTip
    )
      return "The checked out branch changed after publication was prepared.";
    const baseNow =
      (await tip(`refs/heads/${plan.base}`, root)) ??
      (await tip(`refs/remotes/${plan.remote}/${plan.base}`, root));
    if (baseNow !== (plan.localBaseTip ?? plan.baseTip))
      return `Base branch "${plan.base}" changed after publication was prepared.`;
    if (plan.remoteAtPrepare) {
      const remoteBaseNow = await remoteBranchTip(plan.remote, plan.base, root);
      if (remoteBaseNow !== (plan.remoteBaseTip ?? null) && remoteBaseNow !== (plan.steps.includes("push_base") ? plan.baseTip : null)) return `Remote base "${plan.base}" changed. Prepare and approve a new publication plan.`;
      const remoteHeadNow = await remoteBranchTip(plan.remote, plan.head, root);
      if (remoteHeadNow !== (plan.remoteHeadTip ?? null) && remoteHeadNow !== plan.headTip) return `Remote head "${plan.head}" changed. Prepare and approve a new publication plan.`;
    }
    const mergeBase = await git(
      ["merge-base", plan.baseTip, plan.headTip],
      root,
      false,
    );
    if (mergeBase !== plan.mergeBaseTip)
      return `Branches "${plan.base}" and "${plan.head}" changed their common baseline.`;
    const count = Number.parseInt(
      await git(
        ["rev-list", "--count", `${plan.baseTip}..${plan.headTip}`],
        root,
        false,
      ),
      10,
    );
    if (count < 1)
      return `Branch "${plan.head}" no longer has commits beyond "${plan.base}".`;
  } else if (plan.headTip && (await tip("HEAD", root)) !== plan.headTip) {
    return "The checked out commit changed after publication was prepared.";
  }
  return null;
}

function githubEnv(plan: Pick<PublicationPlan, "host" | "target">): NodeJS.ProcessEnv {
  return { GH_HOST: plan.host, GH_REPO: plan.target };
}

async function inspectExistingRepository(
  plan: Pick<PublicationPlan, "cwd" | "host" | "target">,
): Promise<
  | {
      exists: true;
      url: string;
      isPrivate: boolean;
      visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
    }
  | { exists: false }
  | { exists: "unknown"; error: string }
> {
  const result = await ghGlobal(
    ["api", `repos/${plan.target}`, "--hostname", plan.host],
    { cwd: plan.cwd, reject: false, env: githubEnv(plan) },
  );
  if (result.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "html_url" in parsed &&
        typeof parsed.html_url === "string" &&
        "private" in parsed &&
        typeof parsed.private === "boolean" &&
        "visibility" in parsed &&
        (parsed.visibility === "public" ||
          parsed.visibility === "private" ||
          parsed.visibility === "internal")
      ) {
        return {
          exists: true,
          url: parsed.html_url,
          isPrivate: parsed.private,
          visibility: parsed.visibility === "public" ? "PUBLIC" : parsed.visibility === "private" ? "PRIVATE" : "INTERNAL",
        };
      }
      return {
        exists: "unknown",
        error: "GitHub returned repository data without URL and exact visibility.",
      };
    } catch {
      return {
        exists: "unknown",
        error: "GitHub returned invalid repository data.",
      };
    }
  }
  if (/\bHTTP 404\b/i.test(result.stderr)) return { exists: false };
  const classified = classifyGitHubError(
    new Error(
      result.stderr || `gh api exited with code ${result.exitCode}`,
    ),
    "repository view",
  );
  return { exists: "unknown", error: classified.message };
}

function existingVisibilityError(
  plan: PublicationPlan,
  repository: { visibility: "PUBLIC" | "PRIVATE" | "INTERNAL" },
): Error | null {
  const expected = plan.visibility.toUpperCase();
  if (repository.visibility !== expected) {
    return new Error(
      `Repository ${plan.target} has ${repository.visibility.toLowerCase()} visibility, but this publication requires ${plan.visibility}.`,
    );
  }
  return null;
}

async function matchingPullRequest(
  plan: PullRequestPlan,
): Promise<string | null> {
  const result = await gh(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      plan.head,
      "--base",
      plan.base,
      "--json",
      "url",
    ],
    { cwd: plan.root, reject: false, env: githubEnv(plan) },
  );
  if (result.exitCode !== 0)
    throw classifyGitHubError(
      new Error(
        result.stderr || `gh pr list exited with code ${result.exitCode}`,
      ),
      "pull request lookup",
    );
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed))
      throw new Error("GitHub returned invalid pull request data.");
    const existing = parsed.find(
      (item: unknown): item is { url: string } =>
        typeof item === "object" &&
        item !== null &&
        "url" in item &&
        typeof item.url === "string",
    );
    return existing?.url ?? null;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("GitHub returned invalid pull request data.", {
      cause: error,
    });
  }
}

async function pushHeadFastForward(
  plan: PublicationPlan,
  branch: string,
  headTip: string,
  cwd: string,
): Promise<void> {
  const remoteTip = await remoteBranchTip(plan.remote, branch, cwd);
  if (remoteTip === headTip) return;
  if (remoteTip && !(await isAncestor(remoteTip, headTip, cwd))) {
    throw new Error(
      `Remote branch "${branch}" has commits that are not in the local branch.`,
    );
  }
  await execGitWithRetry(
    ["push", "--", plan.remote, `${headTip}:refs/heads/${branch}`],
    { cwd },
  );
}

function matchRefPattern(pattern: string, ref: string): string | null {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === ref ? "" : null;
  const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
  return ref.startsWith(prefix) && ref.endsWith(suffix) && ref.length >= prefix.length + suffix.length
    ? ref.slice(prefix.length, ref.length - suffix.length) : null;
}

async function establishBranchUpstream(
  remote: string,
  branch: string,
  expectedTip: string,
  cwd: string,
): Promise<void> {
  if ((await tip(`refs/heads/${branch}`, cwd)) !== expectedTip) return;
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  const source = `refs/heads/${branch}`;
  const specs = (await git(["config", "--get-all", `remote.${remote}.fetch`], cwd, false)).split("\n").filter(Boolean);
  if (specs.some(spec => spec.startsWith("^") && matchRefPattern(spec.slice(1), source) !== null)) {
    throw new Error(`Remote fetch settings exclude "${branch}". Update remote.${remote}.fetch before configuring its upstream.`);
  }
  const mapped = specs.some(spec => {
    const [from, to] = spec.replace(/^\+/, "").split(":");
    if (!from || !to) return false;
    const capture = matchRefPattern(from, source);
    return capture !== null && to.replace("*", () => capture) === trackingRef;
  });
  if (!mapped) await execGitWithRetry(["remote", "set-branches", "--add", remote, branch], { cwd });
  await execGitWithRetry(["update-ref", trackingRef, expectedTip], { cwd });
  await execGitWithRetry(
    ["branch", "--set-upstream-to", `${remote}/${branch}`, branch],
    { cwd },
  );
}

async function hasBranchUpstream(remote: string, branch: string, cwd: string): Promise<boolean> {
  const [trackedRemote, trackedBranch] = await Promise.all([
    git(["config", "--get", `branch.${branch}.remote`], cwd, false),
    git(["config", "--get", `branch.${branch}.merge`], cwd, false),
  ]);
  return trackedRemote === remote && trackedBranch === `refs/heads/${branch}`;
}

export async function executePublication(
  plan: PublicationPlan,
  prContent?: PublicationContent,
  context: { claimHeld?: boolean; priorCompleted?: readonly string[]; intent?: PublicationIntent; approvedSnapshot?: string } = {},
): Promise<PublicationResult> {
  if (context.approvedSnapshot) assertPublicationApproval(context.approvedSnapshot, await publicationSnapshot(plan, prContent));
  const active = getActiveOperation();
  if (active && !context.claimHeld && !active.releaseClaim) {
    const releaseClaim = await claimOperationResume(active.id, active.cwd);
    setActiveOperation({ ...active, releaseClaim });
  }
  return executePublicationSteps(plan, prContent, context);
}

async function executePublicationSteps(
  plan: PublicationPlan,
  prContent: PublicationContent | undefined,
  context: { priorCompleted?: readonly string[]; intent?: PublicationIntent; approvedSnapshot?: string },
): Promise<PublicationResult> {
  const completed: PublicationStep[] = [];
  const creationStep: PublicationStep = prContent?.web ? "open_create_page" : "create_pull_request";
  const executionSteps = plan.steps.map(step => step === "create_pull_request" ? creationStep : step);
  if (plan.kind === "pr" && prContent?.attachments?.length && !executionSteps.includes("upload_attachments")) executionSteps.push("upload_attachments");
  const remaining = [...executionSteps];
  let url: string | undefined;
  const active = getActiveOperation();
  const intent = context.intent ?? publicationIntent(plan, { attachments: prContent?.attachments, draft: prContent?.draft, web: prContent?.web });
  const priorCompleted = context.priorCompleted ?? [];
  const persistProgress = async (): Promise<void> => {
    if (!active) return;
    await updateOperation(active.id, {
      target: `${plan.host}/${plan.target}`,
      steps: [...new Set([...priorCompleted, ...executionSteps, ...remaining])].map(name => ({ name, state: priorCompleted.includes(name) || completed.some(step => step === name) ? "completed" : "pending" })),
      resume: intent,
      ...(url ? { resources: [url] } : {}),
    }, active.cwd);
  };
  const complete = async (...steps: PublicationStep[]): Promise<void> => {
    for (const step of steps) {
      if (!completed.includes(step)) completed.push(step);
      const index = remaining.indexOf(step);
      if (index !== -1) remaining.splice(index, 1);
    }
    await persistProgress();
  };
  const configureUpstream = async (step: "set_base_upstream" | "set_head_upstream", branch: string, expectedTip: string, cwd: string): Promise<void> => {
    try { await establishBranchUpstream(plan.remote, branch, expectedTip, cwd); }
    catch (error) {
      if (!remaining.includes(step)) remaining.unshift(step);
      await persistProgress();
      throw error;
    }
    if (remaining.includes(step)) {
      await complete(step);

    }
  };
  const fail = (error: unknown): PublicationResult => ({
    status: completed.length || error instanceof PartialAttachmentOperationError ? "partially_completed" : "failed",
    target: plan.target,
    completed,
    remaining: [...remaining],
    ...(url ? { url } : {}),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof PartialAttachmentOperationError ? { attachments: { uploaded: error.uploadedAttachments.map(item => ({ file: item.file.path, url: item.url })), remainingFiles: error.remainingFiles.map(file => file.path), phase: error.phase } } : {}),
  });
  if (
    plan.kind === "pr" &&
    (!prContent?.title.trim() || typeof prContent.body !== "string")
  )
    return fail(new Error("Pull request title and body are required."));
  try {
    if (context.approvedSnapshot) assertPublicationApproval(context.approvedSnapshot, await publicationSnapshot(plan, prContent));
    const changed = await recheck(plan);
    if (changed) return fail(new Error(changed));
    await persistProgress();
    if (plan.kind === "pr") {
      await prepareAttachmentPlan({ attachments: prContent?.attachments, operation: "pr-create", recipient: plan.target, repo: `${plan.host}/${plan.target}`, host: plan.host, visibility: plan.createRepository ? plan.visibility === "public" ? "public" : "private" : "unknown", cwd: plan.cwd });
      if (!prContent)
        return fail(new Error("Pull request title and body are required."));
      if (plan.createRepository && remaining.includes("create_repository")) {
        const current = await inspectExistingRepository(plan);
        if (current.exists === "unknown") return fail(new Error(current.error));
        if (current.exists) {
          const visibilityError = existingVisibilityError(plan, current);
          if (visibilityError) return fail(visibilityError);
          url = current.url;
        } else {
          try {
            url = await createRepository(
              { name: plan.target, visibility: plan.visibility, host: plan.host },
              plan.cwd,
            );
          } catch (error) {
            const retryCheck = await inspectExistingRepository(plan);
            if (retryCheck.exists === "unknown" || !retryCheck.exists)
              return fail(error);
            const visibilityError = existingVisibilityError(plan, retryCheck);
            if (visibilityError) return fail(visibilityError);
            url = retryCheck.url;
          }
        }
        await complete("create_repository");

      }
      if (remaining.includes("add_remote")) {
        const current = (await currentRemotes(plan.root)).find(
          (item) => item.name === plan.remote,
        );
        if (!current)
          await execGitWithRetry(
            ["remote", "add", plan.remote, plan.remoteUrl],
            { cwd: plan.root },
          );
        else if (current.url !== plan.remoteUrl)
          return fail(
            new Error(
              `Remote "${plan.remote}" points elsewhere and will not be overwritten.`,
            ),
          );
        await complete("add_remote");

      }
      if (remaining.includes("push_base")) {
        const baseRef = await remoteBranchTip(
          plan.remote,
          plan.base,
          plan.root,
        );
        if (baseRef && baseRef !== plan.baseTip)
          return fail(
            new Error(
              `Remote base branch "${plan.base}" appeared with a different commit and will not be overwritten.`,
            ),
          );
        if (!baseRef)
          await execGitWithRetry(
            [
              "push",
              "--",
              plan.remote,
              `${plan.baseTip}:refs/heads/${plan.base}`,
            ],
            { cwd: plan.root },
          );
        await complete("push_base");

        await configureUpstream("set_base_upstream", plan.base, plan.baseTip, plan.root);
      }
      if (remaining.includes("set_base_upstream")) await configureUpstream("set_base_upstream", plan.base, plan.baseTip, plan.root);
      if (remaining.includes("push_head")) {
        await pushHeadFastForward(plan, plan.head, plan.headTip, plan.root);
        await complete("push_head");

        await configureUpstream("set_head_upstream", plan.head, plan.headTip, plan.root);
      }
      if (remaining.includes("set_head_upstream")) await configureUpstream("set_head_upstream", plan.head, plan.headTip, plan.root);
      const existingPullRequest = prContent.web ? null : await matchingPullRequest(plan);
      if (existingPullRequest) {
        url = existingPullRequest;
        await complete("create_pull_request");

        if (prContent.attachments?.length) {
          try { await editPullRequest(Number(new URL(url).pathname.split("/").at(-1)), { attachments: prContent.attachments, repo: `${plan.host}/${plan.target}`, host: plan.host }, plan.cwd); }
          catch (error) {
            if (!remaining.includes("upload_attachments")) remaining.push("upload_attachments");
            return fail(error);
          }
          await complete("upload_attachments");
        }
        return {
          status: "succeeded",
          target: plan.target,
          completed,
          remaining,
          url,
        };
      }
      try {
        url = await createPullRequest({
          title: prContent.title, body: prContent.body, draft: prContent.draft, web: prContent.web,
          base: plan.base, head: plan.head, cwd: plan.cwd, repo: `${plan.host}/${plan.target}`,
          host: plan.host, attachments: prContent.attachments,
          visibility: plan.createRepository ? plan.visibility === "public" ? "public" : "private" : "unknown",
        });
        await complete(creationStep, ...(prContent.attachments?.length ? ["upload_attachments" as const] : []));

      } catch (error) {
        if (prContent.web) return fail(error);
        if (error instanceof PartialAttachmentOperationError) {
          if (error.phase === "github_mutation" && error.remainingFiles.length === 0) await complete("upload_attachments");
          else if (!remaining.includes("upload_attachments")) remaining.push("upload_attachments");
          return fail(error);
        }
        if (error instanceof PartialGitHubMutationError) {
          url = error.resourceUrl;
          await complete("create_pull_request");

          if (!remaining.includes("upload_attachments")) remaining.push("upload_attachments");
          return fail(error);
        }
        try {
          url = (await matchingPullRequest(plan)) ?? undefined;
        } catch {
          return fail(error);
        }
        if (!url) return fail(error);
        await complete("create_pull_request");
        if (prContent.attachments?.length) return fail(new Error("The pull request exists, but attachment outcomes are uncertain. Inspect its body before supplying any remaining files.", { cause: error }));

      }
      return {
        status: "succeeded",
        target: plan.target,
        completed,
        remaining,
        ...(url ? { url } : {}),
      };
    }

    if (remaining.includes("create_repository")) {
      const current = await inspectExistingRepository(plan);
      if (current.exists === "unknown") return fail(new Error(current.error));
      if (current.exists) {
        const visibilityError = existingVisibilityError(plan, current);
        if (visibilityError) return fail(visibilityError);
        url = current.url;
      } else {
        try {
          url = await createRepository(
            {
              name: plan.target,
              visibility: plan.visibility,
              description: plan.description,
              host: plan.host,
            },
            plan.cwd,
          );
        } catch (error) {
          const retryCheck = await inspectExistingRepository(plan);
          if (retryCheck.exists === "unknown") return fail(error);
          if (!retryCheck.exists) return fail(error);
          const visibilityError = existingVisibilityError(plan, retryCheck);
          if (visibilityError) return fail(visibilityError);
          url = retryCheck.url;
        }
      }
      await complete("create_repository");

    } else if (!url) {
      const existing = await inspectExistingRepository(plan);
      if (existing.exists === "unknown") return fail(new Error(existing.error));
      if (!existing.exists)
        return fail(new Error(`Repository ${plan.target} no longer exists.`));
      const visibilityError = existingVisibilityError(plan, existing);
      if (visibilityError) return fail(visibilityError);
      url = existing.url;
    }
    if (remaining.includes("add_remote") && plan.root) {
      const present = (await currentRemotes(plan.root)).find(
        (item) => item.name === plan.remote,
      );
      if (!present)
        await execGitWithRetry(["remote", "add", plan.remote, plan.remoteUrl], {
          cwd: plan.root,
        });
      else if (present.url !== plan.remoteUrl)
        return fail(
          new Error(
            `Remote "${plan.remote}" now points elsewhere and will not be overwritten.`,
          ),
        );
      await complete("add_remote");

    }
    if (
      remaining.includes("push_head") &&
      plan.root &&
      plan.head &&
      plan.headTip
    ) {
      await pushHeadFastForward(plan, plan.head, plan.headTip, plan.root);
      await complete("push_head");

      await configureUpstream("set_head_upstream", plan.head, plan.headTip, plan.root);
    }
    if (remaining.includes("set_head_upstream") && plan.root && plan.head && plan.headTip) await configureUpstream("set_head_upstream", plan.head, plan.headTip, plan.root);
    return {
      status: "succeeded",
      target: plan.target,
      completed,
      remaining,
      ...(url ? { url } : {}),
    };
  } catch (error) {
    return fail(error);
  }
}
