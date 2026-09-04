import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { clampLimit, ghGlobal, requireAuth } from "../services/github.ts";
import { fail, failFromGitHub, header, p, pc, jsonOut } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

export function registerSearchCommand(program: Command): void {
  program
    .command("search [type] [query...]")
    .description("Search issues, pull requests, repositories, or code on GitHub")
    .option("--limit <n>", "Maximum results", "30")
    .option("-s, --sort <sort>", "Sort field")
    .option("--order <order>", "Sort order: asc or desc")
    .option("--dry-run", "Show the search command without executing it")
    .action(async (
      type?: string,
      query?: string[],
      options?: { limit?: string; sort?: string; order?: string },
    ) => {
      header("GitHub Search");

      if (!(await requireAuth())) return;

      const kind = type?.toLowerCase() ?? "issues";
      if (!["issues", "prs", "pulls", "repositories", "repos", "code"].includes(kind)) {
        fail(`Unknown search type: ${type}. Try issues, prs, repos, or code.`);
        return;
      }

      const normalized =
        kind === "pulls" ? "prs" : kind === "repositories" ? "repos" : kind;
      const searchType = normalized as "issues" | "prs" | "repos" | "code";

      if (!query || query.length === 0) {
        fail("Search query required.");
        return;
      }

      const max = clampLimit(Number.parseInt(options?.limit ?? "30", 10));
      const args = ["search", searchType, ...(query ?? [])];
      if (options?.sort) args.push("--sort", options.sort);
      if (options?.order) args.push("--order", options.order);
      args.push("--limit", String(max));

      let fields: string;
      switch (searchType) {
        case "issues":
        case "prs":
          fields = "number,title,state,url";
          break;
        case "repos":
          fields = "fullName,description,stargazers,updatedAt";
          break;
        case "code":
        default:
          fields = "path,url,repository";
          break;
      }
      args.push("--json", fields);

      if (dryRun(`run: gh ${args.join(" ")}`)) {
        p.outro(pc.dim("No search was executed."));
        return;
      }

      const s = p.spinner();
      s.start(`Searching ${searchType}...`);
      try {
        const { stdout } = await ghGlobal(args);
        const rows = parseJsonResponse<unknown[]>(stdout, []);
        s.stop(`Found ${pc.green(String(rows.length))} result(s).`);
        if (jsonOut(rows)) return;
        if (rows.length === 0) {
          p.log.info(pc.dim(`No ${searchType} matched.`));
          return;
        }
        for (const row of rows as Record<string, unknown>[]) {
          p.log.message(`  ${pc.cyan(String(row.number ?? row.fullName ?? row.path ?? ""))} ${pc.bold(String(row.title ?? row.description ?? row.repository ?? ""))}`);
        }
      } catch (err) {
        s.stop(pc.red("Search failed."));
        failFromGitHub(err);
      }
    });
}
