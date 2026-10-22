import type { Command } from "commander";
import { getFlags, recordCommandIssue, setCommandCancellation } from "../services/runtime.ts";
import { buildTidyPlan, type TidyOptions } from "../services/projects/tidy-plan.ts";
import { assertTidyApproval, executeTidyPlan } from "../services/projects/tidy-execute.ts";
import { auditTidyPlan, renderTidyAudit } from "../services/projects/tidy-audit.ts";
import { findLost } from "../services/projects/lost.ts";
import { confirmOrAbort, fail, jsonOut, p } from "../utils/ui.ts";
import { cleanupProjects } from "./lost.ts";
import { fetchCleanupClones } from "../services/projects/cleanup-fetch.ts";
import { formatTidyPlan, type CleanupViewOptions } from "../services/projects/cleanup-view.ts";
import { fitProjectLine } from "../services/projects/view.ts";

export { formatTidyPlan as renderTidyPlan } from "../services/projects/cleanup-view.ts";
interface TidyCommandOptions extends TidyOptions, CleanupViewOptions { all?: boolean; fetch?: boolean; yes?: boolean; approvePlan?: string; audit?: string; proceedWithoutAudit?: boolean }
export function registerTidyCommand(program: Command): void {
  const append = (value: string, previous: string[]) => [...previous, value];
  program.command("tidy [projects...]").description("Preview and approve guarded clone cleanup")
    .option("--audit <provider>", "Audit metadata with codex, claude, grok, or ollama; requires AI permission")
    .option("--proceed-without-audit", "Explicitly allow the original plan if the requested audit fails")
    .option("--all", "Plan cleanup across all indexed projects")
    .option("--fetch", "Fetch and prune remote-tracking refs once per clone before planning")
    .option("--wide", "Show full line values")
    .option("--verbose", "Expand kept targets, host worktrees, and hints")
    .option("--remote-branches", "Include proven merged branches on your own origin")
    .option("--allow-ignored <path>", "Approve ignored files for this exact checkout in a new plan", append, [])
    .option("--allow-unknown <path>", "Approve unknown provenance for this exact checkout in a new plan", append, [])
    .option("--stale-days <days>", "Report repositories inactive for this many days", Number, 120)
    .option("-y, --yes", "Approve the displayed snapshot without prompting")
    .option("--approve-plan <id>", "Approve an exact dry-run snapshot, required for agents")
    .action(async (names: string[], options: TidyCommandOptions) => {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.on("SIGINT", interrupt);
      setCommandCancellation(interrupt);
      try {
        if (options.proceedWithoutAudit && !options.audit) throw new Error("--proceed-without-audit requires --audit");
        const { clones, coverage } = await cleanupProjects(names, Boolean(options.all));
        if (options.fetch) await fetchCleanupClones(clones, "tidy", controller.signal);
        const originalPlan = await buildTidyPlan(clones, { remoteBranches: options.remoteBranches, allowIgnored: options.allowIgnored, allowUnknown: options.allowUnknown, staleDays: options.staleDays });
        const audited = options.audit ? await auditTidyPlan(originalPlan, { provider: options.audit, approvePlan: options.approvePlan }) : undefined;
        const plan = audited?.plan ?? originalPlan;
        const lost = await findLost(clones);
        const payload = { schemaVersion: 1, plan, lost, coverage, ...(audited ? { audit: audited.audit } : {}) };
        const count = plan.clones.reduce((n, clone) => n + clone.actions.length, 0);
        if (!getFlags().json) {
          if (audited) for (const line of renderTidyAudit(originalPlan, audited.audit)) p.log.message(fitProjectLine(line, options));
          for (const line of formatTidyPlan(plan, { ...options, coverage, clones })) p.log.message(line);
          const unpublished = lost.clones.reduce((sum, clone) => sum + clone.uniqueCommits, 0);
          const stashes = lost.items.filter(item => item.kind === "stash").reduce((sum, item) => sum + item.count, 0);
          p.log.message(fitProjectLine(`Unpublished: ${unpublished} unique commits; ${stashes} stashes. Inspect with ggh lost.`, options));
          for (const warning of lost.warnings) p.log.message(fitProjectLine(`UNKNOWN ${warning.target}: ${warning.reason}`, options));
        }
        if (audited?.audit.state === "failed" && !options.proceedWithoutAudit) {
          fail(`Audit failed: ${audited.audit.reason}. Cleanup refused; use --proceed-without-audit to approve the original plan`, { code: "operation_failed" });
          jsonOut({ ...payload, status: "failed", outcomes: [] }); return;
        }
        if (options.approvePlan !== undefined) {
          try { assertTidyApproval(options.approvePlan, plan); }
          catch (error) {
            const message = error instanceof Error ? error.message : "Approval changed";
            fail(message, { code: "confirmation_required", requiredInputs: [{ name: "--approve-plan", description: "Review the fresh plan and supply its snapshotId" }] });
            recordCommandIssue({ status: "needs_input", code: "confirmation_required", message, requiredInputs: [{ name: "--approve-plan", description: "Review the fresh plan and supply its snapshotId" }] });
            jsonOut({ ...payload, status: "needs_input" }); return;
          }
        }
        if (getFlags().dryRun) { jsonOut({ ...payload, status: "planned" }); return; }
        if (!count) { jsonOut({ ...payload, status: "no_op", outcomes: [] }); return; }
        if (controller.signal.aborted) { jsonOut({ ...payload, status: "cancelled", outcomes: [] }); return; }
        if (getFlags().agent && !options.approvePlan) {
          const message = "Review tidy --dry-run and supply --approve-plan <snapshotId>";
          fail(message, { code: "confirmation_required", requiredInputs: [{ name: "--approve-plan", description: message }] });
          recordCommandIssue({ status: "needs_input", code: "confirmation_required", message, requiredInputs: [{ name: "--approve-plan", description: "Review the fresh plan and supply its snapshotId" }] });
          jsonOut({ ...payload, status: "needs_input" }); return;
        }
        if (!options.approvePlan && !(await confirmOrAbort(`Apply ${count} tidy action(s) from snapshot ${plan.snapshotId}?`, { assumeYes: options.yes }))) { jsonOut({ ...payload, status: "needs_input" }); return; }
        const outcomes = await executeTidyPlan(plan, clones, { approvedSnapshot: plan.snapshotId, signal: controller.signal });
        const completed = outcomes.filter(outcome => outcome.state === "completed").map(outcome => outcome.id);
        const remaining = outcomes.filter(outcome => outcome.state !== "completed").map(outcome => outcome.id);
        const uncertain = outcomes.filter(outcome => outcome.state === "uncertain").map(outcome => outcome.id);
        const status = controller.signal.aborted ? "cancelled" : remaining.length ? completed.length ? "partially_completed" : "failed" : "succeeded";
        if (remaining.length && !controller.signal.aborted) fail(`${remaining.length} tidy action(s) did not complete; inspect their journal records`, { code: uncertain.length ? "outcome_uncertain" : "operation_failed" });
        if (!jsonOut({ ...payload, status, outcomes, completed, remaining, uncertain })) {
          for (const outcome of outcomes) p.log.message(fitProjectLine(`${outcome.state} ${outcome.kind} [${outcome.id}]: ${outcome.reason}  journal ${outcome.operationId}`, options));
          p.log.message(fitProjectLine(`${completed.length} completed, ${outcomes.filter(item => item.state === "refused").length} refused, ${outcomes.filter(item => item.state === "skipped").length} skipped, ${outcomes.filter(item => item.state === "failed").length} failed, ${uncertain.length} uncertain`, options));
        }
      } catch (error) { fail(error instanceof Error ? error.message : "Tidy failed"); }
      finally { setCommandCancellation(undefined); process.off("SIGINT", interrupt); }
    });
}
