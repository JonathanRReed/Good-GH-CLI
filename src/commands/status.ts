import { Command } from "commander";
import { checkSubmodules, getAheadBehind, getAheadOfDefault, getRepoRoot, getStatus, worktreeList } from "../services/git.ts";
import { getActivePullRequest, getGitHubAuthStatus, type GitHubAccount } from "../services/github.ts";
import { getConfig } from "../services/config.ts";
import { buildAttemptChain, getAvailableProviders, getProviderById, PROVIDER_ORDER } from "../services/ai/index.ts";
import { emitJson, header, p, pc } from "../utils/ui.ts";
import { getFlags } from "../services/runtime.ts";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .alias("st")
    .description("Repository, GitHub, and AI provider status in one place")
    .action(async () => {
      header("System & Repository Status");

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
          getAvailableProviders(),
        ]);

      const config = getConfig();
      const detected = new Set(availableProviders.map((provider) => provider.id));

      if (getFlags().json) {
        emitJson({
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
            active: config.ai_provider || "codex",
            providers: PROVIDER_ORDER.map((id) => ({
              id,
              detected: detected.has(id),
              model: getProviderById(id).defaultModel,
            })),
            chain: buildAttemptChain().map((a) => `${a.provider.id}/${a.model}`),
          },
        });
        return;
      }

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
      p.log.step(pc.bold("AI Integration (Zero API Keys)"));
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

      if (detected.size === 0) {
        p.log.warn(
          pc.yellow("No AI provider detected. Sign in with `codex login` or `grok login`, or use `ggh commit -m`."),
        );
      }

      p.outro(pc.dim("All systems operational."));
    });
}
