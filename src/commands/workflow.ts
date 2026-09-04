import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import {
  clampLimit,
  getCurrentRepositoryNameWithOwner,
  gh,
  ghApi,
  requireAuth,
} from "../services/github.ts";
import { requireGitRepo } from "../services/git.ts";
import { invalidateCache } from "../services/cache.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command("workflow [action] [id]")
    .alias("workflows")
    .description("List, view, run, enable, and disable GitHub Actions workflows")
    .option("--limit <n>", "Maximum workflows to list", "30")
    .option("-y, --yes", "Skip confirmation for mutating actions")
    .action(async (action?: string, id?: string, options?: { limit?: string; yes?: boolean }) => {
      header("GitHub Actions Workflows");

      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !id)) {
        await listWorkflows(options?.limit);
        return;
      }

      if (subcommand === "view" && id) {
        await viewWorkflow(id);
        return;
      }

      if (subcommand === "run" && id) {
        await runWorkflow(id, options);
        return;
      }

      if (subcommand === "enable" && id) {
        await toggleWorkflow("enable", id, options);
        return;
      }

      if (subcommand === "disable" && id) {
        await toggleWorkflow("disable", id, options);
        return;
      }

      unknownAction("workflow", action, ["list", "view", "run", "enable", "disable"]);
    });

  workflow
    .command("list")
    .description("List workflows")
    .option("--limit <n>", "Maximum workflows to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Actions Workflows");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await listWorkflows(options?.limit);
    });

  workflow
    .command("view <id>")
    .description("View a workflow")
    .action(async (id: string) => {
      header("GitHub Actions Workflows");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await viewWorkflow(id);
    });

  workflow
    .command("run <id>")
    .description("Run a workflow")
    .option("-y, --yes", "Skip confirmation for mutating actions")
    .action(async (id: string, options?: { yes?: boolean }) => {
      header("GitHub Actions Workflows");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await runWorkflow(id, options);
    });

  workflow
    .command("enable <id>")
    .description("Enable a workflow")
    .option("-y, --yes", "Skip confirmation for mutating actions")
    .action(async (id: string, options?: { yes?: boolean }) => {
      header("GitHub Actions Workflows");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await toggleWorkflow("enable", id, options);
    });

  workflow
    .command("disable <id>")
    .description("Disable a workflow")
    .option("-y, --yes", "Skip confirmation for mutating actions")
    .action(async (id: string, options?: { yes?: boolean }) => {
      header("GitHub Actions Workflows");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await toggleWorkflow("disable", id, options);
    });

  async function listWorkflows(limit?: string): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const max = clampLimit(Number.parseInt(limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching workflows...");
    try {
      const { stdout } = await gh(["workflow", "list", "-L", String(max), "--json", "id,name,path,state"]);
      const rows = parseJsonResponse<unknown[]>(stdout, []);
      s.stop(`Loaded ${pc.green(String(rows.length))} workflow(s).`);
      if (jsonOut(rows)) return;
      if (rows.length === 0) {
        p.log.info(pc.dim("No workflows found."));
        return;
      }
      for (const row of rows as Array<{ id: number; name: string; path: string; state: string }>) {
        p.log.message(`  ${pc.bold(row.name)} ${pc.dim(`(${row.id})`)} ${pc.cyan(row.state)} ${pc.dim(row.path)}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch workflows."));
      failFromGitHub(err);
    }
  }

  async function viewWorkflow(id: string): Promise<void> {
    const s = p.spinner();
    s.start(`Fetching workflow ${id}...`);
    try {
      const repo = await getCurrentRepositoryNameWithOwner();
      if (!repo) {
        s.stop(pc.red("No repository."));
        fail("Could not determine the repository.");
        return;
      }
      const { stdout } = await ghApi([`/repos/${repo}/actions/workflows/${id}`], { reject: false });
      const data = parseJsonResponse(stdout, null);
      s.stop(data ? "Loaded." : "Not found.");
      if (!data) {
        fail(`Workflow ${id} not found.`);
        return;
      }
      if (jsonOut(data)) return;
      const wf = data as { id: number; name: string; path: string; state: string; html_url?: string };
      p.log.step(pc.bold(wf.name));
      p.log.message(`  ID:    ${wf.id}`);
      p.log.message(`  Path:  ${pc.dim(wf.path)}`);
      p.log.message(`  State: ${pc.cyan(wf.state)}`);
      if (wf.html_url) p.log.message(`  URL:   ${pc.dim(wf.html_url)}`);
    } catch (err) {
      s.stop(pc.red("Failed to fetch workflow."));
      failFromGitHub(err);
    }
  }

  async function runWorkflow(id: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`run workflow ${id}`)) return;
    if (!(await confirmOrAbort(`Run workflow ${pc.bold(id)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Running workflow ${id}...`);
    try {
      await gh(["workflow", "run", id]);
      invalidateCache("run-list:");
      s.stop(pc.green("Workflow run requested."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to run workflow."));
      failFromGitHub(err);
    }
  }

  async function toggleWorkflow(
    action: "enable" | "disable",
    id: string,
    options?: { yes?: boolean },
  ): Promise<void> {
    if (dryRun(`${action} workflow ${id}`)) return;
    if (!(await confirmOrAbort(`${action === "enable" ? "Enable" : "Disable"} workflow ${pc.bold(id)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`${action === "enable" ? "Enabling" : "Disabling"} workflow ${id}...`);
    try {
      await gh(["workflow", action, id]);
      s.stop(pc.green(`Workflow ${id} ${action}d.`));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }
}
