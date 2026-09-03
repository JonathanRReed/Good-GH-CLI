import { Command } from "commander";
import {
  cancelWorkflowRun,
  getFailedRunLog,
  getGitHubAuthStatus,
  listWorkflowRuns,
  rerunWorkflowRun,
  viewWorkflowRun,
  type WorkflowRun,
} from "../services/github.ts";
import { getCurrentBranch, isGitRepo } from "../services/git.ts";
import { generateReleaseNotesWithFallback } from "../services/ai/index.ts";
import { getFlags } from "../services/runtime.ts";
import { isDryRun } from "../utils/flags.ts";
import {
  confirmPrompt,
  emitJson,
  fail,
  header,
  p,
  pc,
  reportAIFailure,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

function conclusionTag(run: { status: string; conclusion: string }): string {
  if (run.status !== "completed") return pc.yellow("◷ " + run.status.replace("_", " "));
  switch (run.conclusion) {
    case "success": return pc.green("✓ success");
    case "failure": return pc.red("✖ failure");
    case "cancelled": return pc.dim("• cancelled");
    case "skipped": return pc.dim("• skipped");
    default: return pc.yellow("▲ " + (run.conclusion || "unknown"));
  }
}

async function requireAuth(): Promise<boolean> {
  const auth = await getGitHubAuthStatus();
  if (auth.authenticated) return true;
  fail(
    auth.notInstalled
      ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
      : "GitHub CLI is not authenticated. Run `gh auth login`.",
  );
  return false;
}

/** Trims a CI log to the tail, which is where the actual failure almost always is. */
function tailLog(log: string, maxChars = 30_000): string {
  if (log.length <= maxChars) return log;
  return `[log truncated to the last ${maxChars} characters]\n` + log.slice(-maxChars);
}

export function registerRunCommand(program: Command): void {
  const runCmd = program
    .command("run [runId]")
    .alias("runs")
    .description("Inspect GitHub Actions runs, and explain failures with AI")
    .option("-b, --branch <branch>", "Filter to a branch (defaults to the current one)")
    .option("-s, --status <status>", "Filter by status, e.g. failure, in_progress")
    .option("-w, --workflow <name>", "Filter by workflow name")
    .option("--all-branches", "Do not filter by branch")
    .option("--limit <n>", "Maximum runs to list", "20")
    .action(async (runId?: string, options?: {
      branch?: string; status?: string; workflow?: string; allBranches?: boolean; limit?: string;
    }) => {
      header("GitHub Actions");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      if (!(await requireAuth())) return;

      if (runId) {
        const id = Number.parseInt(runId, 10);
        if (Number.isNaN(id)) {
          fail(`Invalid run id: ${runId}`);
          return;
        }
        await showRun(id);
        return;
      }

      const branch = options?.allBranches
        ? undefined
        : options?.branch || (await getCurrentBranch());

      const s = p.spinner();
      s.start(`Fetching workflow runs${branch ? ` for ${branch}` : ""}...`);
      const runs = await listWorkflowRuns({
        limit: Number.parseInt(options?.limit ?? "20", 10) || 20,
        branch,
        status: options?.status,
        workflow: options?.workflow,
      });
      s.stop(`Loaded ${pc.green(String(runs.length))} run(s).`);

      if (getFlags().json) {
        emitJson(runs);
        return;
      }
      if (runs.length === 0) {
        p.log.info(pc.dim("No workflow runs matched."));
        return;
      }

      const picked = await searchablePicker<number>({
        title: "Select a run:",
        items: runs.map((r: WorkflowRun) => ({
          value: r.databaseId,
          label: `${r.workflowName} · ${r.displayTitle}`,
          hint: `${r.status === "completed" ? r.conclusion : r.status} · ${r.headBranch} · ${r.createdAt.slice(0, 10)}`,
        })),
        pageSize: 10,
      });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      await showRun(picked);
    });

  async function showRun(id: number): Promise<void> {
    const detail = await viewWorkflowRun(id);
    if (!detail) {
      fail(`Run ${id} not found.`);
      return;
    }

    if (getFlags().json) {
      emitJson(detail);
      return;
    }

    const { run, jobs } = detail;
    p.log.step(`${pc.bold(run.workflowName)} ${pc.dim("·")} ${run.displayTitle}`);
    p.log.message(`  Status: ${conclusionTag(run)}`);
    p.log.message(`  Branch: ${pc.cyan(run.headBranch)} ${pc.dim("·")} ${run.event}`);

    const failed = jobs.filter((j) => j.conclusion === "failure");
    for (const job of jobs) {
      p.log.message(`  ${conclusionTag(job)} ${job.name}`);
      for (const step of job.steps ?? []) {
        if (step.conclusion === "failure") {
          p.log.message(`      ${pc.red("↳")} failed at step ${step.number}: ${pc.bold(step.name)}`);
        }
      }
    }

    if (failed.length === 0) {
      p.outro(pc.dim(run.url));
      return;
    }

    const action = await selectMenu<string>({
      message: `${failed.length} job(s) failed. What next?`,
      options: [
        { value: "explain", label: "Explain the failure with AI", hint: "reads the failed job log" },
        { value: "log", label: "Print the failed log", hint: "raw output" },
        { value: "rerun", label: "Re-run failed jobs" },
        { value: "cancel", label: "Do nothing" },
      ],
      initialValue: "explain",
    });
    if (!action || action === "cancel") return;

    if (action === "rerun") {
      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would re-run the failed jobs of ${id}`);
        return;
      }
      const confirmed = await confirmPrompt({ message: `Re-run failed jobs for run ${id}?`, initialValue: true });
      if (!confirmed) return;
      try {
        await rerunWorkflowRun(id, { failedOnly: true });
        p.log.success(pc.green("Re-run requested."));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
      return;
    }

    const logSpinner = p.spinner();
    logSpinner.start("Downloading the failed job log...");
    const log = await getFailedRunLog(id);
    logSpinner.stop(log ? "Log downloaded." : pc.yellow("No log available."));
    if (!log.trim()) return;

    if (action === "log") {
      p.outro(pc.dim("Raw log follows on stdout."));
      process.stdout.write(log);
      return;
    }

    const aiSpinner = p.spinner();
    aiSpinner.start("Reading the log...");
    try {
      // The release-notes channel is a plain-markdown-out prompt, which is exactly
      // the shape CI triage needs.
      const { result, providerName, model } = await generateReleaseNotesWithFallback({
        tag: `CI failure in ${run.workflowName}`,
        commits: [
          "You are triaging a failed GitHub Actions run. From the log below, report:",
          "### What failed — the job and step, named exactly",
          "### Why — the actual error, quoted",
          "### Fix — the most likely change, concretely",
          "Ignore setup noise and warnings. If the log is inconclusive, say so.",
          "",
          tailLog(log),
        ],
      });
      aiSpinner.stop(`Triaged by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
      p.note(result, "CI Failure");
      p.outro(pc.dim(run.url));
    } catch (err) {
      aiSpinner.stop(pc.yellow("Could not explain the failure."));
      reportAIFailure(err, "AI triage failed:");
      p.log.info(pc.dim(`Run \`ggh run ${id}\` again and choose "Print the failed log".`));
    }
  }

  runCmd.command("rerun <runId>")
    .description("Re-run a workflow run")
    .option("-f, --failed", "Re-run only the failed jobs")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (runId: string, options?: { failed?: boolean; yes?: boolean }) => {
      header("Re-run Workflow");
      if (!(await requireAuth())) return;
      const id = Number.parseInt(runId, 10);
      if (Number.isNaN(id)) {
        fail(`Invalid run id: ${runId}`);
        return;
      }
      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would re-run ${id}`);
        return;
      }
      const confirmed = await confirmPrompt({
        message: `Re-run ${options?.failed ? "failed jobs of " : ""}run ${id}?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) return;
      try {
        await rerunWorkflowRun(id, { failedOnly: options?.failed });
        p.log.success(pc.green("Re-run requested."));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });

  runCmd.command("cancel <runId>")
    .description("Cancel a workflow run")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (runId: string, options?: { yes?: boolean }) => {
      header("Cancel Workflow");
      if (!(await requireAuth())) return;
      const id = Number.parseInt(runId, 10);
      if (Number.isNaN(id)) {
        fail(`Invalid run id: ${runId}`);
        return;
      }
      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would cancel ${id}`);
        return;
      }
      const confirmed = await confirmPrompt({
        message: `Cancel run ${id}?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) return;
      try {
        await cancelWorkflowRun(id);
        p.log.success(pc.green("Cancellation requested."));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });
}
