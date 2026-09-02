import { Command } from "commander";
import { execa } from "execa";
import { isGitRepo } from "../services/git.ts";
import { header, p } from "../utils/ui.ts";

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .alias("graph")
    .description("Display a compact, colorized Git DAG graph of commits and branches (Lazygit/Tig style)")
    .option("-n, --count <number>", "Number of commits to display", "20")
    .option("-a, --all", "Show commits from all branches")
    .option("-s, --stat", "Show file change diff stats")
    .action(async (options?: { count?: string; all?: boolean; stat?: boolean }) => {
      header("Git Commit Graph");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const count = options?.count || "20";
      const args = [
        "log",
        "--graph",
        `--max-count=${count}`,
        "--color=always",
        "--pretty=format:%C(yellow)%h%Creset -%C(red)%d%Creset %s %C(green)(%cr) %C(bold blue)<%an>%Creset",
      ];

      if (options?.all) {
        args.push("--all");
      }

      if (options?.stat) {
        args.push("--stat");
      }

      try {
        await execa("git", args, { stdio: "inherit" });
      } catch {
        // Ignored if user exits early with q
      }
    });
}
