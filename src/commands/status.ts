import { Command } from "commander";
import { checkSubmodules, getAheadBehind, getAheadOfDefault, getRepoRoot, getStatus, worktreeList } from "../services/git.ts";
import { getActivePullRequest, getGitHubAuthStatus } from "../services/github.ts";
import { getConfig } from "../services/config.ts";
import { CodexProvider } from "../services/ai/codex.ts";
import { GrokProvider } from "../services/ai/grok.ts";
import { header, p, pc } from "../utils/ui.ts";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show comprehensive repository, worktree, GitHub, and AI status")
    .action(async () => {
      header("System & Repository Status");

      // Git Status
      const gitStatus = await getStatus();
      if (!gitStatus.isRepo) {
        p.log.warn(pc.yellow("Not currently inside a Git repository."));
      } else {
        const root = await getRepoRoot();
        const wtList = await worktreeList();
        const drift = await getAheadBehind();
        const aheadOfDefault = await getAheadOfDefault();
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

        const activePr = await getActivePullRequest();
        if (activePr) {
          p.log.message(`  Pull Req: ${pc.bold(pc.green(`#${activePr.number}`))} ${activePr.title} (${pc.cyan(activePr.state)})`);
          p.log.message(`            ${pc.dim(activePr.url)}`);
        }

        p.log.message(
          `  Changes:  ${gitStatus.staged.length} staged, ${gitStatus.unstaged.length} unstaged, ${gitStatus.untracked.length} untracked`,
        );
        p.log.message(`  Worktrees: ${wtList.length} active`);

        const submodules = await checkSubmodules();
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
      const ghStatus = await getGitHubAuthStatus();
      if (ghStatus.authenticated) {
        p.log.message(
          `  Status:   ${pc.green("Authenticated")} as ${pc.cyan(ghStatus.login || "user")} (${ghStatus.protocol || "https"})`,
        );
      } else {
        p.log.message(`  Status:   ${pc.yellow("Not authenticated")} (run \`gh auth login\`)`);
      }

      // AI Status
      const config = getConfig();
      const codex = new CodexProvider();
      const grok = new GrokProvider();
      const codexOk = await codex.isAvailable();
      const grokOk = await grok.isAvailable();

      p.log.step(pc.bold("AI Integration (Zero API Keys)"));
      p.log.message(
        `  Codex (Luna): ${codexOk ? pc.green("Ready") : pc.dim("Not detected")} (model: ${pc.cyan(config.codex_model || codex.defaultModel)})`,
      );
      p.log.message(
        `  Grok:         ${grokOk ? pc.green("Ready") : pc.dim("Not detected")} (model: ${pc.cyan(config.grok_model || grok.defaultModel)})`,
      );
      p.log.message(`  Active:       ${pc.bold(pc.magenta(config.ai_provider || "codex"))}`);

      p.outro(pc.dim("All systems operational."));
    });
}
