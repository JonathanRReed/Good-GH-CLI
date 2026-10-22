import { samePath } from "../services/projects/paths.ts";
import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchSettings, pushTarget } from "../services/git/push-target.ts";
import { run } from "../utils/exec.ts";
import { getFlags } from "../services/runtime.ts";
import { checkSubmodules, getAheadBehind, getAheadOfDefault, getRepoRoot, getRemotes, getStatus, worktreeList } from "../services/git.ts";
import { getActivePullRequest, getGitHubAuthStatus, type GitHubAccount } from "../services/github.ts";
import { getConfig } from "../services/config.ts";
import { buildAttemptChain, getStatusProviders, getProviderById, PROVIDER_ORDER } from "../services/ai/index.ts";
import { fail, header, p, pc, jsonOut } from "../utils/ui.ts";
import { isDryRun } from "../utils/flags.ts";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .alias("st")
    .description("Repository, GitHub, and AI provider status in one place")
    .option("--full", "Include raw porcelain-v2 records in agent output")
    .option("--remote", "Include GitHub authentication and pull request probes")
    .option("--providers", "Include AI provider probes")
    .option("--watch", "Refresh the status display every N seconds (default 5)")
    .option("--interval <seconds>", "Refresh interval in seconds (default 5)", "5")
    .action(async (options?: { watch?: boolean; interval?: string; remote?: boolean; providers?: boolean; full?: boolean }) => {
      if (options?.watch) {
        const parsed = Number.parseInt(options.interval ?? "5", 10);
        const intervalSec = Number.isFinite(parsed) ? Math.min(Math.max(2, parsed), 300) : 5;
        if (getFlags().json) {
          fail("--watch is not compatible with --json.");
          return;
        }
        await watchStatus(intervalSec);
        return;
      }
      await renderStatus(options);
    });
}

async function renderStatus(options?: { remote?: boolean; providers?: boolean; full?: boolean }): Promise<void> {
  if (getFlags().json) {
    await renderMachineStatus(options);
    return;
  }
  header("System & Repository Status");

  if (isDryRun()) {
    p.log.info(pc.dim("dry run · status is read-only, proceeding with normal probes"));
  }

  // Probe everything in parallel — all of these are independent
  const [gitStatus, root, wtList, drift, aheadOfDefault, activePr, ghStatus, submodules, availableProviders] =
    await Promise.all([
      getStatus(),
      getRepoRoot().catch(() => ""),
      worktreeList().catch(() => []),
      getAheadBehind().catch(() => ({ ahead: 0, behind: 0, hasUpstream: false })),
      getAheadOfDefault().catch(() => 0),
      getActivePullRequest().catch(() => null),
      getGitHubAuthStatus().catch((): GitHubAccount => ({ authenticated: false })),
      checkSubmodules().catch(() => []),
      getStatusProviders(),
    ]);

  const config = getConfig();
  const detected = new Set(availableProviders.map((provider) => provider.id));

  if (jsonOut({
      repository: gitStatus.isRepo
        ? {
            root,
            branch: gitStatus.branch,
            detached: Boolean(gitStatus.isDetached),
            ahead: drift.ahead,
            behind: drift.behind,
            hasUpstream: drift.hasUpstream,
            aheadOfDefault,
            staged: gitStatus.staged.length,
            unstaged: gitStatus.unstaged.length,
            untracked: gitStatus.untracked.length,
            conflicts: gitStatus.conflicts.length,
            worktrees: wtList.length,
            submodules,
          }
        : null,
      pullRequest: activePr,
      github: ghStatus,
      ai: {
        enabled: config.ai_enabled,
        optional: true,
        active: config.ai_provider || "codex",
        providers: PROVIDER_ORDER.map((id) => ({
          id,
          detected: detected.has(id),
          model: getProviderById(id).defaultModel,
        })),
        chain: buildAttemptChain().map((a) => `${a.provider.id}/${a.model}`),
      },
    })) return;

  // Git Status
  if (!gitStatus.isRepo) {
    p.log.warn(pc.yellow("Not currently inside a Git repository."));
  } else {
    let driftStr = pc.dim("(no upstream)");
    if (drift.hasUpstream) {
      if (drift.ahead === 0 && drift.behind === 0) {
        driftStr = pc.green("(in sync with remote)");
      } else {
        const parts: string[] = [];
        if (drift.ahead > 0) parts.push(pc.yellow(`ahead ${drift.ahead}`));
        if (drift.behind > 0) parts.push(pc.cyan(`behind ${drift.behind}`));
        driftStr = pc.bold(`(${parts.join(", ")})`);
      }
    }
    if (aheadOfDefault > 0) {
      driftStr += ` ${pc.magenta(`[${aheadOfDefault} ahead of main]`)}`;
    }

    p.log.step(pc.bold("Git Repository"));
    p.log.message(`  Root:     ${pc.cyan(root)}`);
    p.log.message(`  Branch:   ${pc.green(gitStatus.branch)} ${driftStr}`);

    if (activePr) {
      p.log.message(`  Pull Req: ${pc.bold(pc.green(`#${activePr.number}`))} ${activePr.title} (${pc.cyan(activePr.state)})`);
      p.log.message(`            ${pc.dim(activePr.url)}`);
    }

    p.log.message(
      `  Changes:  ${gitStatus.staged.length} staged, ${gitStatus.unstaged.length} unstaged, ${gitStatus.untracked.length} untracked`,
    );
    p.log.message(`  Worktrees: ${wtList.length} active`);

    if (submodules.length > 0) {
      p.log.message(`  Submodules: ${submodules.length} tracked`);
      for (const s of submodules) {
        const color = s.status === "dirty" ? pc.yellow : s.status === "conflict" ? pc.red : pc.dim;
        p.log.message(`    ${pc.dim("•")} ${s.name}: ${color(s.status)} (${s.commit.slice(0, 7)})`);
      }
    }
  }

  // GitHub Status
  p.log.step(pc.bold("GitHub CLI"));
  if (ghStatus.notInstalled) {
    p.log.message(`  Status:   ${pc.yellow("Not installed")} (install from https://cli.github.com)`);
  } else if (ghStatus.authenticated) {
    p.log.message(
      `  Status:   ${pc.green("Authenticated")} as ${pc.cyan(ghStatus.login || "user")} (${ghStatus.protocol || "https"})`,
    );
  } else {
    p.log.message(`  Status:   ${pc.yellow("Not authenticated")} (run \`gh auth login\`)`);
  }

  // AI Status
  p.log.step(pc.bold(config.ai_enabled ? "AI integration (optional, enabled)" : "AI integration (optional, disabled)"));
  for (const id of PROVIDER_ORDER) {
    const provider = getProviderById(id);
    const label = provider.displayName.padEnd(16);
    p.log.message(
      `  ${label} ${detected.has(id) ? pc.green("Ready") : pc.dim("Not detected")} ${pc.dim("·")} ${pc.cyan(
        (config[`${id}_model` as keyof typeof config] as string) || provider.defaultModel,
      )}`,
    );
  }
  p.log.message(`  Active:          ${pc.bold(pc.magenta(config.ai_provider || "codex"))}`);
  p.log.message(
    `  Fallback: ${pc.dim(buildAttemptChain().map((a) => `${a.provider.id}/${a.model}`).join(" → "))}`,
  );

  if (config.ai_enabled && detected.size === 0) {
    p.log.warn(
      pc.yellow("No AI provider detected. Sign in with `codex login` or `grok login`, or use `ggh commit -m`."),
    );
  }

  const githubOk = !ghStatus.notInstalled && ghStatus.authenticated;
  if (githubOk) {
    p.outro(pc.dim(gitStatus.isRepo ? "GitHub authenticated. Local repository status checked." : "GitHub authenticated. Open a Git repository to check local work."));
  } else {
    p.outro(pc.yellow("GitHub setup needs attention. Local status checks are available."));
  }
}

async function renderMachineStatus(options?: { remote?: boolean; providers?: boolean; full?: boolean }): Promise<void> {
  const agent = getFlags().agent;
  const [gitStatus, root, branchInfo, gitDir] = await Promise.all([
    agent ? Promise.resolve(null) : getStatus(), getRepoRoot().catch(() => ""),
    run("git", ["status", "--porcelain=v2", "--branch", "-z", agent ? "-uall" : "--untracked-files=no"], { reject: false }),
    run("git", ["rev-parse", "--absolute-git-dir"], { reject: false }),
  ]);
  if (root && branchInfo.exitCode !== 0) throw new Error(branchInfo.stderr || "Cannot read Git status.");
  let branch: string | null = null;
  let head: string | null = null;
  const rawChanges: string[] = [];
  const changes: Array<[xy: string, path: string] | [xy: string, path: string, origPath: string]> = [];
  const submodules: Array<[path: string, marker: string]> = [];
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  let rename: [xy: string, path: string] | undefined;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const field of branchInfo.stdout.split("\0")) {
    if (!field) continue;
    if (rename) { rawChanges.push(field); changes.push([...rename, field]); rename = undefined; continue; }
    if (field.startsWith("# branch.head ")) branch = field.slice(14) === "(detached)" ? null : field.slice(14);
    if (field.startsWith("# branch.oid ")) head = field.slice(13) === "(initial)" ? null : field.slice(13);
    if (!field.startsWith("# ")) {
      rawChanges.push(field);
      if (field.startsWith("? ") || field.startsWith("! ")) {
        changes.push([field.startsWith("? ") ? "??" : "!!", field.slice(2)]);
        if (field.startsWith("? ")) counts.untracked++;
      } else {
        // Split only the fixed metadata prefix. Paths may contain spaces and newlines.
        const match = /^(1|2) (\S{2}) (\S{4}) (?:\S+ ){5}([\s\S]*)$/.exec(field);
        const unmerged = /^u (\S{2}) (\S{4}) (?:\S+ ){7}([\s\S]*)$/.exec(field);
        const xy = unmerged?.[1] ?? match?.[2];
        const marker = unmerged?.[2] ?? match?.[3];
        let path = unmerged?.[3] ?? match?.[4];
        if (!xy || !marker || path === undefined) throw new Error("Invalid porcelain-v2 change record.");
        if (field.startsWith("2 ")) {
          const separator = path.indexOf(" ");
          if (separator < 0) throw new Error("Invalid porcelain-v2 rename record.");
          path = path.slice(separator + 1);
          rename = [xy, path];
        } else changes.push([xy, path]);
        if (marker !== "N...") submodules.push([path, marker]);
        if (unmerged) counts.conflicts++;
        else {
          if (xy[0] !== ".") counts.staged++;
          if (xy[1] !== ".") counts.unstaged++;
        }
      }
    }
    if (field.startsWith("# branch.upstream ")) upstream = field.slice(18);
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
    if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]); }
  }
  const directory = gitDir.stdout.trim();
  let operation: string | null = null;
  for (const [file, name] of [
    ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["sequencer", "sequencer"], ["BISECT_LOG", "bisect"],
  ] as const) {
    if (directory && existsSync(join(directory, file))) { operation = name; break; }
  }
  const probes = {
    ...(options?.remote ? { pullRequest: await getActivePullRequest().catch(() => null), github: await getGitHubAuthStatus() } : {}),
    ...(options?.providers ? { ai: { enabled: getConfig().ai_enabled, providers: (await getStatusProviders()).map(provider => provider.id) } } : {}),
  };
  if (agent) {
    if (!root) { jsonOut(null); return; }
    const [settings, remotes] = await Promise.all([branchSettings(root), getRemotes(root)]);
    const remote = branch ? pushTarget(branch, remotes, settings) : null;
    const destination = remote ? remote.remote === "." ? remote.branch : `${remote.remote}/${remote.branch}` : null;
    const base = branch ? settings.get(`branch.${branch}.gh-merge-base`) : undefined;
    const fetchPath = join(directory, "FETCH_HEAD");
    jsonOut({
      ...(!samePath(root, process.cwd()) ? { root } : {}), branch, head,
      ...(upstream ? { upstream } : {}), ...(ahead ? { ahead } : {}), ...(behind ? { behind } : {}),
      ...Object.fromEntries(Object.entries(counts).filter(([, count]) => count !== 0)),
      ...(operation ? { operation } : {}), ...(changes.length ? { changes } : {}),
      ...(submodules.length ? { submodules } : {}), ...(options?.full ? { rawChanges } : {}),
      ...(base ? { base } : {}), ...(destination !== upstream ? { push: destination } : {}),
      ...(existsSync(fetchPath) ? { fetchedAt: statSync(fetchPath).mtime.toISOString() } : {}), ...probes,
    });
    return;
  }
  const result = {
    repository: gitStatus?.isRepo ? {
      root, branch: gitStatus.isDetached ? null : gitStatus.branch, detached: Boolean(gitStatus.isDetached),
      upstream, ahead, behind, staged: gitStatus.staged.length, unstaged: gitStatus.unstaged.length,
      untracked: gitStatus.untracked.length, conflicts: gitStatus.conflicts.length, operation,
    } : null,
    ...probes,
  };
  jsonOut(result);
}

async function watchStatus(intervalSec: number): Promise<void> {
  let running = true;

  // Allow Ctrl-C to exit cleanly
  const onSigint = () => {
    running = false;
    process.off("SIGINT", onSigint);
  };
  process.on("SIGINT", onSigint);

  while (running) {
    // Terminal chrome goes to stderr so piped stdout stays clean.
    process.stderr.write("\x1b[2J\x1b[H"); // clear screen + move cursor to top-left
    await renderStatus();
    if (!running) break;
    p.log.info(pc.dim(`Refreshing in ${intervalSec}s — press Ctrl-C to exit.`));
    await sleep(intervalSec * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
