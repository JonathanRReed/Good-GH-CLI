import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  cancelWorkflowRun,
  getFailedRunLog,
  listWorkflowRuns,
  requireAuth,
  rerunWorkflowRun,
  viewWorkflowRun,
  type WorkflowRun,
} from "../services/github.ts";
import { getCurrentBranch, requireGitRepo } from "../services/git.ts";
import { generateReleaseNotesWithFallback } from "../services/ai/index.ts";
import { dryRun } from "../utils/flags.ts";
import { sanitizeForAI } from "../utils/diff.ts";
import {
  confirmOrAbort, jsonOut,
  data,
  emitJson,
  fail,
  failFromGitHub,
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
    case "success":
      return pc.green("✓ success");
    case "failure":
      return pc.red("✖ failure");
    case "cancelled":
      return pc.dim("• cancelled");
    case "skipped":
      return pc.dim("• skipped");
    default:
      return pc.yellow("▲ " + (run.conclusion || "unknown"));
  }
}

/** Trims a CI log to the tail, which is where the actual failure almost always is. */
function tailLog(log: string, maxChars = 30_000): string {
  if (log.length <= maxChars) return log;
  return `[log truncated to the last ${maxChars} characters]\n` + log.slice(-maxChars);
}

/** Sanitizes a CI log before it is sent to an AI provider. */
export function prepareLogForAI(log: string, maxChars = 30_000): { text: string; redactedCount: number } {
  const prepared = sanitizeForAI(log, maxChars);
  return { text: prepared.text, redactedCount: prepared.redactedCount };
}

export function registerRunCommand(program: Command): void {
  const runCmd = program
    .command("run [runId]")
    .alias("runs")
    .description("Inspect Actions runs, and explain failures with AI")
    .option("-b, --branch <branch>", "Filter to a branch (defaults to the current one)")
    .option("-s, --status <status>", "Filter by status, e.g. failure, in_progress")
    .option("-w, --workflow <name>", "Filter by workflow name")
    .option("--all-branches", "Do not filter by branch")
    .option("--limit <n>", "Maximum runs to list", "30")
    .option("-y, --yes", "Skip confirmation prompts for re-run")
    .action(async (runId?: string, options?: {
      branch?: string; status?: string; workflow?: string; allBranches?: boolean; limit?: string; yes?: boolean;
    }) => {
      header("GitHub Actions");
      const [isRepo, authed] = await Promise.all([requireGitRepo(), requireAuth()]);
      if (!isRepo || !authed) return;

      if (runId) {
        const id = Number.parseInt(runId, 10);
        if (Number.isNaN(id)) {
          fail(`Invalid run ID: ${runId}`);
          return;
        }
        await showRun(id, options?.yes);
        return;
      }

      const branch = options?.allBranches
        ? undefined
        : options?.branch || (await getCurrentBranch());

      // Read-only: --dry-run does not block listing.
      const s = p.spinner();
      s.start(`Fetching workflow runs${branch ? ` for ${branch}` : ""}...`);
      let runs: WorkflowRun[];
      try {
        runs = await listWorkflowRuns({
          limit: Number.parseInt(options?.limit ?? "30", 10) || 30,
          branch,
          status: options?.status,
          workflow: options?.workflow,
        });
        s.stop(`Loaded ${pc.green(String(runs.length))} run(s).`);
      } catch (err) {
        s.stop(pc.red("Failed to fetch runs."));
        failFromGitHub(err);
        return;
      }

      if (jsonOut(runs)) return;
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
      await showRun(picked, (options as { yes?: boolean } | undefined)?.yes);
    });

  async function showRun(id: number, assumeYes?: boolean): Promise<void> {
    let detail;
    try {
      detail = await viewWorkflowRun(id);
    } catch (err) {
      failFromGitHub(err);
      return;
    }
    if (!detail) {
      fail(`Run ${id} not found.`);
      return;
    }

    if (jsonOut(detail)) return;

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
      if (dryRun(`re-run the failed jobs of ${id}`)) return;
      if (!(await confirmOrAbort(`Re-run failed jobs for run ${id}?`, { assumeYes, cancelText: null }))) return;
      try {
        await rerunWorkflowRun(id, { failedOnly: true });
        p.log.success(pc.green("Re-run requested."));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
      return;
    }

    const logSpinner = p.spinner();
    logSpinner.start("Downloading the failed job log...");
    let log: string;
    try {
      log = await getFailedRunLog(id);
      logSpinner.stop(log ? "Log downloaded." : pc.yellow("No log available."));
    } catch (err) {
      logSpinner.stop(pc.red("Failed to download log."));
      failFromGitHub(err);
      return;
    }
    if (!log.trim()) return;

    if (action === "log") {
      p.outro(pc.dim("Raw log follows on stdout."));
      data(log.endsWith("\n") ? log.slice(0, -1) : log);
      return;
    }

    const prepared = prepareLogForAI(log);
    if (prepared.redactedCount > 0) {
      p.log.info(pc.dim(`${prepared.redactedCount} secret-like value(s) redacted from the log before AI analysis.`));
    }

    const aiSpinner = p.spinner();
    aiSpinner.start("Reading the log...");
    try {
      const { result, providerName, model } = await generateReleaseNotesWithFallback({
        tag: `CI failure in ${run.workflowName}`,
        commits: [
          "You are triaging a failed GitHub Actions run. From the log below, report:",
          "### What failed — the job and step, named exactly",
          "### Why — the actual error, quoted",
          "### Fix — the most likely change, concretely",
          "Ignore setup noise and warnings. If the log is inconclusive, say so.",
          "",
          tailLog(prepared.text),
        ],
      });
      aiSpinner.stop(`Triaged by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
      p.note(result, "CI Failure");
      p.outro(pc.dim(run.url));
    } catch (err) {
      aiSpinner.stop(pc.yellow("Could not explain the failure."));
      reportAIFailure(err, "AI triage failed:");
      p.log.info(pc.dim(`Run \`ggh run ${id}\` again and choose "Print the failed log".`));
      if (getFlags().json) {
        emitJson({ id, error: "ai-failed" });
      }
      process.exitCode = 1;
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
        fail(`Invalid run ID: ${runId}`);
        return;
      }
      if (dryRun(`re-run ${id}`)) return;
      if (!(await confirmOrAbort(`Re-run ${options?.failed ? "failed jobs of " : ""}run ${id}?`, { assumeYes: options?.yes, cancelText: null }))) return;
      try {
        await rerunWorkflowRun(id, { failedOnly: options?.failed });
        p.log.success(pc.green("Re-run requested."));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
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
        fail(`Invalid run ID: ${runId}`);
        return;
      }
      if (dryRun(`cancel ${id}`)) return;
      if (!(await confirmOrAbort(`Cancel run ${id}?`, { assumeYes: options?.yes, cancelText: null }))) return;
      try {
        await cancelWorkflowRun(id);
        p.log.success(pc.green("Cancellation requested."));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });
}
