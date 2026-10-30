import { Command, Option } from "commander";
import { lstatSync, readdirSync } from "node:fs";
import { clone } from "../services/git.ts";
import { alreadyCloned, CloneCancelledError, cloneDestination, cloneTransport, redactCloneCredentials } from "../services/git/clone.ts";
import { getGitHubAuthStatus, searchRepositories, type RepositoryItem } from "../services/github.ts";
import { listCloneRepositories, matchCloneRepositories } from "../services/github/clone-repos.ts";
import { registerProject } from "../services/projects/index-store.ts";
import { getConfig, type CloneMode } from "../services/config.ts";
import { getFlags, isNonInteractive, recordCommandIssue } from "../services/runtime.ts";
import { fail, failFromGitHub, header, jsonOut, p, promptInput, searchablePicker, selectMenu } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";
import type { CloneResult } from "../services/agent-contract.ts";

interface CloneOptions {
  fast?: boolean;
  blobless?: boolean;
  shallow?: boolean;
  to?: string;
  ask?: boolean;
  protocol?: "ssh" | "https";
  refresh?: boolean;
}

function needsInput(message: string): void {
  process.exitCode = 1;
  recordCommandIssue({ status: "needs_input", code: "missing_input", message, requiredInputs: [{ name: "repo", description: "Pass an exact OWNER/REPO or repository URL and --to <directory> if choosing a destination." }] });
  p.log.error(message);
}

function pickerItems(repos: RepositoryItem[]) {
  return repos.map(repo => ({ value: repo.nameWithOwner, label: repo.nameWithOwner, hint: repo.description?.slice(0, 60) ?? "" }));
}

export function registerCloneCommand(program: Command): void {
  program
    .command("clone [repo]")
    .alias("get")
    .description("Search for and clone a repository")
    .option("--fast, --blobless", "Use a blobless clone (--filter=blob:none)")
    .option("--shallow", "Clone only the latest commit (--depth 1)")
    .option("--to <dir>", "Clone into this directory")
    .option("--ask", "Prompt for the destination")
    .addOption(new Option("--protocol <protocol>", "Choose the clone transport").choices(["ssh", "https"]))
    .option("--refresh", "Bypass the cached repository list")
    .option("--dry-run", "Show the repository and destination without cloning")
    .action(async (repoArg: string | undefined, options: CloneOptions) => {
      header("Clone");
      if (options.ask && isNonInteractive()) {
        needsInput("--ask requires an interactive terminal. Pass --to <directory> or omit --ask.");
        return;
      }
      let selected = repoArg?.trim();
      let result: CloneResult | undefined;
      try {
        if (!selected || (!selected.includes("/") && !selected.includes(":"))) {
          const all = await listCloneRepositories(options.refresh);
          const matches = selected ? matchCloneRepositories(all, selected) : all;
          const global = selected ? await searchRepositories(selected, { limit: 30 }) : [];
          const candidates = [...new Map([...matches, ...global].map(repo => [repo.nameWithOwner.toLowerCase(), repo])).values()];
          if (selected && candidates.length === 1) {
            selected = candidates[0]!.nameWithOwner;
          } else if (isNonInteractive()) {
            needsInput(candidates.length ? "Choose an exact OWNER/REPO from candidates." : "Pass an exact OWNER/REPO or repository URL.");
            jsonOut({ version: 1, candidates: candidates.map(repo => ({ repo: repo.nameWithOwner, destination: cloneDestination(repo.nameWithOwner, { cloneRoot: getConfig().clone_root, to: options.to }) })) });
            return;
          } else {
            selected = await searchablePicker({
              title: "Repository to clone:", items: pickerItems(candidates), pageSize: 8,
              matchesQuery: (item, query) => matchCloneRepositories([{ nameWithOwner: item.value, description: item.hint }], query).length > 0,
              onSearchGitHub: async query => pickerItems(await searchRepositories(query, { limit: 30 })),
            }) ?? undefined;
            if (!selected) { p.cancel("Clone cancelled."); return; }
          }
        }
        const auth = await getGitHubAuthStatus();
        const transport = cloneTransport(selected, auth.protocol ?? "https", options.protocol, auth.host);
        const config = getConfig();
        let destination = cloneDestination(selected, { cloneRoot: config.clone_root, to: options.to });
        if (options.ask) {
          const input = await promptInput({ message: "Clone into:", defaultValue: destination });
          if (!input) { p.cancel("Clone cancelled."); return; }
          destination = cloneDestination(selected, { to: input });
        }
        p.log.message(`Destination: ${destination}`);
        const isFast = options.fast || options.blobless;
        let mode: CloneMode = isFast ? "blobless" : options.shallow ? "shallow" : config.default_clone_mode ?? "standard";
        result = { version: 1, destination, repo: redactCloneCredentials(selected), mode, protocol: transport.protocol, fallbackUsed: false, alreadyCloned: false };
        // Record the resolved target even when validation or cloning fails.
        jsonOut(result);
        let exists = false;
        try {
          const stat = lstatSync(destination);
          exists = true;
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Destination must be a directory, not a symlink.");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (exists && await alreadyCloned(transport.url, destination)) {
          jsonOut({ ...result, status: "no_op", alreadyCloned: true });
          p.log.success(`already cloned at ${destination}`);
          return;
        }
        if (exists && readdirSync(destination).length) throw new Error(`Refusing non-empty destination '${destination}': it is not a clone of the same repository.`);
        if (!isFast && !options.shallow && !isNonInteractive() && !getFlags().dryRun) {
          const pick = await selectMenu<CloneMode>({ message: "Clone mode:", options: [
            { value: "standard", label: "Standard" },
            { value: "blobless", label: "Blobless" },
            { value: "shallow", label: "Shallow" },
          ] });
          if (!pick) { p.cancel("Clone cancelled."); return; }
          mode = pick;
          result.mode = mode;
        }
        if (dryRun(`clone ${result.repo} [${mode}] into ${destination}`)) { jsonOut(result); return; }
        const progress = p.spinner();
        progress.start(`Cloning ${result.repo} into ${destination}`);
        try {
          const outcome = await clone(transport.url, destination, mode, process.cwd(), {
            transport,
            onProgress: line => progress.message(line),
            onFallback: () => { if (result) { result.fallbackUsed = true; result.protocol = "https"; } progress.message("SSH authentication or host-key check failed; retrying once over HTTPS."); },
          });
          jsonOut({ ...result, ...outcome });
          progress.stop(`Cloned at ${destination}`);
          // Index the checkout ggh just created, so `ggh go` and `ggh projects`
          // find it immediately, even outside every scan root. The clone itself
          // already succeeded, so an index problem must not fail the command.
          try { await registerProject(destination); } catch (error) { p.log.warn(`Cloned, but could not add it to the project index: ${error instanceof Error ? error.message : String(error)}`); }
        } catch (error) {
          progress.stop("Clone failed.");
          jsonOut({ ...result, status: error instanceof CloneCancelledError ? "cancelled" : "failed", error: { message: redactCloneCredentials(error instanceof Error ? error.message : String(error)) } });
          if (error instanceof CloneCancelledError) {
            process.exitCode = 130;
            recordCommandIssue({ status: "cancelled", code: "cancelled", message: error.message });
          } else fail(redactCloneCredentials(error instanceof Error ? error.message : String(error)));
        }
      } catch (error) {
        if (result) jsonOut({ ...result, status: "failed", error: { message: redactCloneCredentials(error instanceof Error ? error.message : String(error)) } });
        failFromGitHub(error);
      }
    });
}
