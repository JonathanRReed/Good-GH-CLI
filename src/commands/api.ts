import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { ghApi, ghApiPassthrough, parseRepoFlag } from "../services/github.ts";
import { emitJson, fail, header, p, pc } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

const MUTATING_API = /(^|\s)(-X\s*(POST|PUT|PATCH|DELETE)|--method\s+(POST|PUT|PATCH|DELETE)|--input\b|-F\b|--field\b)/i;

export function registerApiCommand(program: Command): void {
  program
    .command("api <endpoint...>")
    .description("Authenticated GitHub API request (passthrough to `gh api`)")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (endpoint: string[]) => {
      header("GitHub API");

      // Passthrough owns every flag (helpOption(false) above), so answer
      // --help here instead of sending it to the API as an endpoint.
      if (endpoint.length === 1 && (endpoint[0] === "--help" || endpoint[0] === "-h")) {
        p.log.message("  Usage: ggh api <endpoint...> [gh api flags]");
        p.log.message("  Example: ggh api repos/{owner}/{repo} --jq .topics");
        p.log.message("  Mutating calls honour --dry-run. `-R owner/name` fills {owner}/{repo}.");
        p.outro("Done.");
        return;
      }

      const joined = endpoint.length > 1 ? endpoint.join("/") : endpoint[0];
      if (!joined) {
        fail("API endpoint required.");
        return;
      }

      const parsed = parseRepoFlag();
      let path = joined;
      if (path.includes("{owner}") || path.includes("{repo}")) {
        if (!parsed) {
          fail("This endpoint needs an owner/repo. Pass `-R owner/repo` or run inside a repository.");
          return;
        }
        path = path
          .replace(/\{owner\}/g, parsed.owner)
          .replace(/\{repo\}/g, parsed.repo);
      }

      if (getFlags().json) {
        if (MUTATING_API.test(endpoint.join(" ")) && dryRun(`call GitHub API ${path}`)) {
          emitJson({ endpoint: path, dryRun: true });
          return;
        }
        const s = p.spinner();
        s.start(`Requesting ${pc.dim(path)}...`);
        const result = await ghApi([path], { reject: false });
        if (result.exitCode !== 0) {
          s.stop(pc.red("Request failed."));
          fail(result.stderr.trim() || "GitHub API request failed.");
          return;
        }
        const data = parseJsonResponse(result.stdout, null);
        s.stop(data ? "Loaded." : "Empty response.");
        emitJson(data);
        return;
      }

      if (MUTATING_API.test(endpoint.join(" ")) && dryRun(`call GitHub API ${path}`)) {
        return;
      }
      const code = await ghApiPassthrough([path]);
      process.exitCode = code;
    });
}
