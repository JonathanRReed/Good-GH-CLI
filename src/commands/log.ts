import { Command } from "commander";
import { run } from "../utils/exec.ts";
import { isGitRepo } from "../services/git.ts";
import { fail, header, pc } from "../utils/ui.ts";

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
        fail("Not a git repository.");
        return;
      }

      const countArg = options?.count || "20";
      const count = Number.parseInt(countArg, 10);
      if (Number.isNaN(count) || count < 1) {
        fail(`Invalid commit count: "${countArg}". Please pass a positive number (e.g. ${pc.cyan("ggh log -n 50")}).`);
        return;
      }

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
        await run("git", args, { stdio: "inherit" });
      } catch {
        // Ignored if user exits early with q
      }
    });
}
