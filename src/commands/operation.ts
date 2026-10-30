import { publicationSnapshot, assertPublicationApproval, PublicationApprovalError } from "../services/publication-approval.ts";
import { Command } from "commander";
import { addOperationEvidence, claimOperationResume, listOperations, operationLockStatus, previewOperationEvidence, pruneOperations, readOperation, unlockOperation, updateOperation } from "../services/operations.ts";
import { operationRecoveryGuide, preparePublicationResume } from "../services/publication-recovery.ts";
import { executePublication, publicationRequiredInput } from "../services/publication.ts";
import { readAttachmentBodyFile } from "../services/github/attachments.ts";
import { recordCommandIssue, setActiveOperation } from "../services/runtime.ts";
import { finishCommandOperation } from "../services/command-operations.ts";
import type { RequiredInput } from "../services/agent-contract.ts";
import { isDryRun } from "../utils/flags.ts";
import { confirmOrAbort, fail, header, jsonOut, p, pc } from "../utils/ui.ts";

export function registerOperationCommand(program: Command): void {
  const operation = program.command("operation").alias("op").description("List and inspect local operation records");

  operation.command("recover <id>")
    .description("Inspect completed, uncertain and remaining effects before recovery")
    .action(async (id: string) => {
      try {
        const guide = operationRecoveryGuide(await readOperation(id));
        if (jsonOut(guide)) return;
        header("Operation Recovery");
        p.log.message(`State: ${guide.state}\nCompleted: ${guide.completed.join(", ") || "none"}\nRemaining: ${guide.remaining.join(", ") || "none"}\nUncertain: ${guide.uncertain.join(", ") || "none"}`);
        for (const command of guide.inspection) p.log.message(command);
        p.log.info(guide.resumable ? `Resume with ggh operation resume ${id}; required content must be supplied again.` : guide.guidance ?? "This operation is already complete.");
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });

  operation.command("resume <id>")
    .description("Reconcile and resume a saved publication plan after explicit approval")
    .option("-t, --title <title>", "Supply the PR title again")
    .option("-b, --body <body>", "Supply the PR body again")
    .option("-F, --body-file <file>", "Read the PR body from an explicit UTF-8 file")
    .option("--approve-plan <sha256>", "Approve the exact dry-run snapshot")
    .option("--description <text>", "Supply the repository description again")
    .option("--attach <file>", "Supply an unconfirmed attachment again", (value: string, files: string[]) => [...files, value], [])
    .option("-y, --yes", "Approve reconciliation and the remaining publication effects")
    .action(async (id: string, options: { approvePlan?: string; title?: string; body?: string; bodyFile?: string; description?: string; attach?: string[]; yes?: boolean }) => {
      let release: (() => Promise<void>) | undefined;
      try {
        if (options.body !== undefined && options.bodyFile !== undefined) { fail("Choose --body or --body-file.", { code: "invalid_arguments" }); return; }
        let record = await readOperation(id);
        let guide = operationRecoveryGuide(record);
        if (record.status.state === "succeeded" || record.status.state === "no_op") {
          if (!jsonOut({ status: "no_op", reason: "already_completed", ...guide })) p.log.info("This operation is already complete.");
          return;
        }
        if (!record.resume) {
          fail(guide.guidance ?? "Inspect the operation.", { code: "precondition_failed" });
          jsonOut({ status: "failed", ...guide });
          return;
        }
        if (!isDryRun()) {
          release = await claimOperationResume(id);
          record = await readOperation(id);
          guide = operationRecoveryGuide(record);
          if (record.status.state === "succeeded" || record.status.state === "no_op") {
            if (!jsonOut({ status: "no_op", reason: "already_completed", ...guide })) p.log.info("This operation is already complete.");
            return;
          }
          if (!record.resume) throw new Error("Publication recovery metadata changed. Inspect the operation before retrying.");
        }
        if (record.steps.length > 0 && record.steps.every(step => step.state === "completed")) {
          if (!jsonOut({ status: "no_op", reason: "effects_already_completed", ...guide })) p.log.info("All recorded publication effects completed. Inspect the recorded resources; nothing will be replayed.");
          return;
        }
        const prepared = await preparePublicationResume(record);
        if (prepared.status !== "ready") {
          if (prepared.status === "needs_input") recordCommandIssue({ status: "needs_input", code: "missing_input", message: prepared.message, requiredInputs: [publicationRequiredInput(record.command === "repo create" ? "repo" : "pr", prepared.required, prepared.message)] });
          fail(prepared.message, prepared.status === "failed" ? { code: "precondition_failed" } : {});
          jsonOut({ ...prepared, ...guide });
          return;
        }
        const requiredInputs: RequiredInput[] = [];
        if (record.resume.requiresPrContent) {
          if (!options.title?.trim()) requiredInputs.push({ name: "--title", description: "Supply the intended title again." });
          if (options.body === undefined && options.bodyFile === undefined) requiredInputs.push({ name: "body", alternatives: ["--body", "--body-file"], description: "Supply the intended body again." });
        }
        const uploadsComplete = record.steps.some(step => step.name === "upload_attachments" && step.state === "completed");
        if (uploadsComplete && options.attach?.length) { fail("Uploads are already confirmed. Use their recorded URLs in the supplied body; no files will be uploaded again.", { code: "invalid_arguments" }); return; }
        if (record.resume.requiresAttachments && !uploadsComplete && !options.attach?.length) requiredInputs.push({ name: "--attach", description: "Inspect the resource and supply only files whose upload is not confirmed." });
        if (guide.requiredContent?.description && prepared.plan.steps.includes("create_repository") && options.description === undefined) requiredInputs.push({ name: "--description", description: "Supply the repository description again." });
        const body = options.bodyFile === undefined ? options.body : await readAttachmentBodyFile(options.bodyFile);
        const plan = prepared.plan.kind === "repo" && options.description !== undefined ? { ...prepared.plan, description: options.description } : prepared.plan;
        const content = plan.kind === "pr" ? { title: options.title ?? "", body: body ?? "", attachments: options.attach, draft: record.resume.draft, web: record.resume.creationMode === "browser" } : undefined;
        const snapshotId = requiredInputs.length ? undefined : await publicationSnapshot(plan, content);
        if (options.approvePlan && !snapshotId) throw new Error("Supply the required content before approving a publication snapshot.");
        if (snapshotId) assertPublicationApproval(options.approvePlan, snapshotId);
        if (isDryRun()) {
          if (!jsonOut({ status: "planned", operationId: id, snapshotId, plan, requiredInputs, completed: guide.completed })) p.log.info(`Would resume ${prepared.plan.target}: ${prepared.plan.steps.join(", ")}.`);
          return;
        }
        if (requiredInputs.length) {
          const message = "Recovery requires explicit content inputs. Nothing was uploaded or published.";
          recordCommandIssue({ status: "needs_input", code: "missing_input", message, requiredInputs });
          fail(message);
          jsonOut({ status: "needs_input", requiredInputs, ...guide });
          return;
        }
        p.note(`${plan.host}/${plan.target} (${plan.visibility})\n${plan.remote}: ${plan.remoteUrl}\n${plan.steps.join(" → ")}${plan.headTip ? `\n${plan.head} ${plan.headTip.slice(0, 12)}` : ""}`, "Recovery publication plan");
        if (!(await confirmOrAbort("Resume this publication after inspecting its completed effects?", { assumeYes: options.yes || Boolean(options.approvePlan) }))) return;
        if (snapshotId) assertPublicationApproval(snapshotId, await publicationSnapshot(plan, content));
        await updateOperation(id, { status: { state: "running" } });
        setActiveOperation({ id: record.id, cwd: record.resume.plan.cwd, command: record.command });
        const result = await executePublication(plan, content, { claimHeld: true, priorCompleted: guide.completed, intent: record.resume, approvedSnapshot: snapshotId });
        if (result.status !== "succeeded") fail(result.error ?? "Publication recovery did not complete.");
        if (!jsonOut({ ...result, completed: [...new Set([...guide.completed, ...result.completed])], operationId: id })) {
          if (result.url) p.log.message(result.url);
          p.outro(result.status === "succeeded" ? "Publication recovered." : "Inspect completed and remaining effects before retrying.");
        }
      } catch (error) {
        if (error instanceof PublicationApprovalError) recordCommandIssue(error.issue);
        fail(error instanceof Error ? error.message : String(error));
      }
      finally { try { await finishCommandOperation(); } finally { await release?.(); } }
    });

  operation.command("unlock <id>")
    .description("Recover an abandoned operation update lock; never unlock a known live writer")
    .option("--unknown-owner", "Confirm other ggh commands have stopped when legacy lock ownership is unknown")
    .option("-y, --yes", "Authorize lock recovery")
    .action(async (id: string, options: { yes?: boolean; unknownOwner?: boolean }) => {
      try {
        const lock = await operationLockStatus(id);
        if (isDryRun()) {
          if (jsonOut({ status: "planned", operationId: id, lock })) return;
          p.log.info(`Would inspect and recover ${lock.state} lock for operation ${id}.`);
          return;
        }
        if (!options.yes && !(await confirmOrAbort("Recover this operation lock after checking other ggh commands have stopped?"))) return;
        const result = await unlockOperation(id, { authorized: true, allowUnknown: options.unknownOwner });
        if (jsonOut(result)) return;
        p.log.success("Operation lock recovered.");
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });

  operation.command("list", { isDefault: true })
    .description("List recent local operations")
    .option("--limit <n>", "Maximum records to show", "50")
    .action(async (options: { limit?: string }) => {
      header("Local Operations");
      try {
        const rawLimit = parseIntegerOption(options.limit ?? "50", "Limit", 1, 100);
        const records = (await listOperations()).slice(0, rawLimit);
        if (jsonOut(records)) return;
        if (records.length === 0) p.log.info("No operation records.");
        for (const record of records) p.log.message(`${record.id}  ${record.status.state}  ${record.command}${record.target ? `  ${record.target}` : ""}`);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });

  operation.command("view <id>")
    .description("View one local operation record")
    .action(async (id: string) => {
      header("Operation");
      try {
        const record = await readOperation(id);
        if (jsonOut(record)) return;
        p.log.message(`${record.id}\n${record.command}\nStatus: ${record.status.state}${record.target ? `\nTarget: ${record.target}` : ""}${record.revision ? `\nRevision: ${record.revision}` : ""}`);
        for (const step of record.steps) p.log.message(`  ${step.state}  ${step.name}`);
        for (const resource of record.resources) p.log.message(`  Resource: ${resource}`);
        for (const evidence of record.evidence) p.log.message(`  Evidence: ${evidence.path} (${evidence.revision})`);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });

  operation.command("evidence <id> <file>")
    .description("Associate a local file with the operation revision")
    .action(async (id: string, file: string) => {
      header("Operation Evidence");
      try {
        if (isDryRun()) {
          const preview = await previewOperationEvidence(id, file);
          const result = {
            dryRun: true,
            operationId: preview.operationId,
            evidence: { path: preview.path, revision: preview.revision },
          };
          if (jsonOut(result)) return;
          p.log.info(`Would associate ${pc.cyan(preview.path)} with revision ${pc.bold(preview.revision)}.`);
          return;
        }
        const record = await addOperationEvidence(id, file);
        if (jsonOut(record)) return;
        p.log.success(`Associated ${pc.cyan(file)} with revision ${pc.bold(record.revision ?? "unknown")}. The file was not copied or checked.`);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });

  operation.command("prune")
    .description("Remove old local operation records")
    .option("--older-than <days>", "Remove records last updated before this many days", "90")
    .option("-y, --yes", "Authorize removal without a prompt")
    .action(async (options: { olderThan?: string; yes?: boolean }) => {
      header("Prune Operation Records");
      try {
        const days = parseIntegerOption(options.olderThan ?? "90", "Age", 1, 36500);
        const before = new Date(Date.now() - days * 86_400_000);
        if (isDryRun()) {
          const stale = (await listOperations()).filter((record) => Date.parse(record.updatedAt) < before.getTime());
          if (jsonOut({ dryRun: true, ids: stale.map((record) => record.id) })) return;
          p.log.info(`Would remove ${stale.length} record(s).`);
          return;
        }
        if (!options.yes && !(await confirmOrAbort("Remove old operation records?"))) return;
        const removed = await pruneOperations({ before, authorized: true });
        if (jsonOut({ removed })) return;
        p.log.success(`Removed ${removed.length} old record(s).`);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
}

function parseIntegerOption(value: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}
