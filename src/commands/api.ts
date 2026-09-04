import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { ghApi, ghApiPassthrough } from "../services/github.ts";
import { emitJson, fail, header, p, pc } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

export function registerApiCommand(program: Command): void {
  program
    .command("api <endpoint...>")
    .description("Authenticated GitHub API request (passthrough to `gh api`)")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      header("GitHub API");
      if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
        p.log.message("Usage: ggh api <endpoint> [gh api flags]");
        p.log.message("Example: ggh api repos/{owner}/{repo} --jq .topics");
        p.log.message("All calls honour --dry-run. -R owner/name supplies GH_REPO.");
        return;
      }
      // gh owns argument boundaries, method inference, GraphQL and placeholders.
      // A method-regex is not sufficient to decide whether a request can mutate.
      if (dryRun(`call GitHub API ${args[0] ?? ""}`)) {
        if (getFlags().json) emitJson({ endpoint: args[0], dryRun: true });
        return;
      }
      if (!getFlags().json) {
        process.exitCode = await ghApiPassthrough(args);
        return;
      }
      const s = p.spinner();
      s.start(`Requesting ${pc.dim(args[0] ?? "")}...`);
      const request = args.includes("--paginate") && !args.includes("--slurp") ? [...args, "--slurp"] : args;
      const result = await ghApi(request, { reject: false });
      if (result.exitCode !== 0) {
        s.stop("Request failed.");
        fail(result.stderr.trim() || "GitHub API request failed.");
        return;
      }
      try {
        const data: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : null;
        s.stop("Loaded.");
        emitJson(data);
      } catch {
        s.stop("Invalid JSON response.");
        fail("The API response is not JSON. Remove --json or flags that produce text/headers.");
      }
    });
}
