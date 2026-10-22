import type { Command } from "commander";
import { getFlags, recordCommandIssue, setCommandCancellation } from "../services/runtime.ts";
import { startOperation, updateOperation } from "../services/operations.ts";
import { acquireProcessLock } from "../services/process-lock.ts";
import { projectGit } from "../services/projects/git.ts";
import { buildTidyPlan, type TidyPlan, type TidyOptions } from "../services/projects/tidy-plan.ts";
import { assertTidyApproval, executeTidyPlan, tidyLockPath } from "../services/projects/tidy-execute.ts";
import { findLost } from "../services/projects/lost.ts";
import { confirmOrAbort, fail, jsonOut, p } from "../utils/ui.ts";
import { cleanupProjects, renderLost } from "./lost.ts";

export function renderTidyPlan(plan: TidyPlan): string[] {
  const lines = [`Tidy plan ${plan.snapshotId}`];
  for (const clone of plan.clones) {
    lines.push(`${clone.name}  ${clone.commonDir}`, `  Remote-tracking refs last fetched: ${clone.fetchedAt ? `${clone.fetchedAt} (${Math.max(0, Math.floor((Date.now() - Date.parse(clone.fetchedAt)) / 86400000))} days ago)` : "unknown"}. Remote state may have changed.`);
    for (const action of clone.actions) {
      const target = action.kind === "remove-checkout" ? action.checkout.path : action.kind === "prune-worktree-metadata" ? action.entries.map(entry => entry.path).join(", ") : action.branch;
      lines.push(`  ${action.kind}  ${target}  [${action.id}]`, `    proof: ${JSON.stringify(action.proof)}`);
      if (action.kind === "delete-remote-branch") lines.push(`    destination: ${action.destination}; expected-OID lease ${action.tip}; cached owner ${action.login}`);
      if (action.kind === "remove-checkout") lines.push(`    checkout: ${action.checkoutIdentity}; clean files: ${action.fileState}; ignored override ${action.allowIgnored}; unknown-owner override ${action.allowUnknown}`);
      if (action.kind === "prune-worktree-metadata") lines.push(`    Git prune preview: ${JSON.stringify(action.dryRun)}; default expiry retained`);
    }
    for (const kept of clone.kept) lines.push(`  KEEP ${kept.target}: ${kept.reason}`);
    for (const host of clone.hostManual) lines.push(`  HOST-MANUAL ${host.target}: ${host.reason}`);
    for (const hint of clone.hints) lines.push(`  ${hint.kind} ${hint.reason}`);
  }
  return lines;
}
interface TidyCommandOptions extends TidyOptions { all?: boolean; fetch?: boolean; yes?: boolean; approvePlan?: string }
export function registerTidyCommand(program: Command): void {
  const append = (value: string, previous: string[]) => [...previous, value];
  program.command("tidy [projects...]").description("Preview and approve guarded clone cleanup")
    .option("--all", "Plan cleanup across all indexed projects")
    .option("--fetch", "Fetch and prune remote-tracking refs once per clone before planning")
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
        const { clones, coverage } = await cleanupProjects(names, Boolean(options.all));
        if (options.fetch) for (const clone of clones) {
          if (controller.signal.aborted) break;
          const release = await acquireProcessLock(tidyLockPath(clone.commonDir), 30000);
          try {
            const operation = await startOperation({ command: "tidy fetch", steps: ["fetch"], cwd: clone.commonDir });
            await updateOperation(operation.id, { steps: [{ name: "fetch", state: "uncertain" }] }, clone.commonDir);
            try {
              await projectGit(clone.commonDir, ["fetch", "--prune"], Date.now() + 30000);
              await updateOperation(operation.id, { steps: [{ name: "fetch", state: "completed" }], status: { state: "succeeded" } }, clone.commonDir);
            } catch (error) {
              await updateOperation(operation.id, { steps: [{ name: "fetch", state: "uncertain" }], status: { state: "partially_completed" } }, clone.commonDir);
              throw error;
            }
          } finally { await release(); }
        }
        const plan = await buildTidyPlan(clones, { remoteBranches: options.remoteBranches, allowIgnored: options.allowIgnored, allowUnknown: options.allowUnknown, staleDays: options.staleDays });
        const lost = await findLost(clones);
        const payload = { schemaVersion: 1, plan, lost, coverage };
        const count = plan.clones.reduce((n, clone) => n + clone.actions.length, 0);
        if (!getFlags().json) {
          for (const line of renderTidyPlan(plan)) p.log.message(line);
          for (const line of renderLost(lost)) p.log.message(line);
          for (const gap of coverage.skipped) p.log.warn(`${gap.path}: ${gap.reason}`);
          if (coverage.truncated) p.log.warn("Discovery is incomplete: scan depth reached");
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
          for (const outcome of outcomes) p.log.message(`${outcome.state} ${outcome.kind} [${outcome.id}]: ${outcome.reason}  journal ${outcome.operationId}`);
          p.log.message(`${completed.length} completed, ${outcomes.filter(item => item.state === "refused").length} refused, ${outcomes.filter(item => item.state === "skipped").length} skipped, ${outcomes.filter(item => item.state === "failed").length} failed, ${uncertain.length} uncertain`);
        }
      } catch (error) { fail(error instanceof Error ? error.message : "Tidy failed"); }
      finally { setCommandCancellation(undefined); process.off("SIGINT", interrupt); }
    });
}
