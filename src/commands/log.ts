import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { run } from "../utils/exec.ts";
import { requireGitRepo } from "../services/git.ts";
import { emitJson, fail, header, pc } from "../utils/ui.ts";

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .alias("graph")
    .description("Colourised commit graph")
    .option("-n, --count <number>", "Number of commits to display", "20")
    .option("-a, --all", "Show commits from all branches")
    .option("-s, --stat", "Show file change diff stats")
    .allowUnknownOption(true)
    .action(async (options?: { count?: string; all?: boolean; stat?: boolean }, command?: Command) => {
      header("Git Commit Graph");

      if (!(await requireGitRepo())) return;

      const countArg = options?.count || "20";
      const count = Number.parseInt(countArg, 10);
      if (Number.isNaN(count) || count < 1) {
        fail(`Invalid commit count: "${countArg}". Please pass a positive number (e.g. ${pc.cyan("ggh log -n 50")}).`);
        return;
      }

      const extra = command?.args ?? [];

      if (getFlags().json) {
        const format = "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ai%x1f%D%x1f%x00";
        const args = ["log", `--max-count=${count}`, format, ...extra];
        if (options?.all) args.push("--all");

        try {
          const { stdout } = await run("git", args, {});
          const records = stdout
            .split("\0")
            .filter(Boolean)
            .map((record) => {
              const [hash, abbrev, subject, author, email, date, refs] = record.split("\x1f");
              return {
                hash: (hash || "").trim(),
                abbrev: (abbrev || "").trim(),
                subject: subject || "",
                author: author || "",
                email: email || "",
                date: date || "",
                refs: (refs || "").replace(/^HEAD\s*(?:->|,)?\s*/, "").trim(),
              };
            });
          emitJson(records);
        } catch {
          // Ignored if user exits early with q
        }
        return;
      }

      const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
      const pretty = useColor
        ? "--pretty=format:%C(yellow)%h%Creset -%C(red)%d%Creset %s %C(green)(%cr) %C(bold blue)<%an>%Creset"
        : "--pretty=format:%h -%d %s (%cr) <%an>";

      const args = ["log", "--graph", `--max-count=${count}`, useColor ? "--color=always" : "--color=never", pretty, ...extra];

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
