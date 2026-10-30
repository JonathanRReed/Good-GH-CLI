import { editPrDraft, readPrDraft, PrDraftEditorError, type PrDraftSession } from "../services/pr-draft-editor.ts";
import { quoteShellArgument } from "../utils/command-args.ts";
import { resolve } from "node:path";
import { publicationSnapshot, assertPublicationApproval, PublicationApprovalError } from "../services/publication-approval.ts";
import type { Command } from "commander";
import { getFlags, isNonInteractive, recordCommandIssue } from "../services/runtime.ts";
import { findPrTemplate, findPrTemplateByName, getBranchDiff, getBranchDiffStat, getCommitsSinceBase, listPrTemplates } from "../services/git.ts";
import { preparePublication, executePublication, type PullRequestPlan } from "../services/publication.ts";
import { prepareAttachmentPlan } from "../services/github.ts";
import { readAttachmentBodyFile } from "../services/github/attachments.ts";
import { generatePrWithFallback, type AIAttempt, type AIAttemptFailure } from "../services/ai/index.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import { dryRun } from "../utils/flags.ts";
import { confirmOrAbort, jsonOut, fail, failFromGitHub, failPublication, formatAIFallback, header, p, promptInput, reportAIFailure } from "../utils/ui.ts";

export interface PrCreateOptions {
  approvePlan?: string; title?: string; body?: string; bodyFile?: string; base?: string; draft?: boolean;
  editor?: boolean | string; web?: boolean; issue?: string; yes?: boolean; ai?: boolean; template?: string;
  repoName?: string; remote?: string; attachments?: string[]; priorCompleted?: string[];
}

function sanitizePrTitle(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, "").trim();
}


function reportRetainedDraft(path: string, options: PrCreateOptions): void {
  const quote = process.platform === "win32" ? (value: string) => "'" + value.replace(/'/g, "''") + "'" : quoteShellArgument;
  const args = ["ggh", "pr", "create", "--editor", quote(path)];
  const values: [string, string | undefined][] = [["--base", options.base], ["--issue", options.issue], ["--repo-name", options.repoName], ["--remote", options.remote]];
  for (const [flag, value] of values) {
    if (value !== undefined) args.push(flag, quote(value));
  }
  if (options.draft) args.push("--draft");
  if (options.web) args.push("--web");
  if (getFlags().repo) args.push("--repo", quote(getFlags().repo ?? ""));
  for (const attachment of options.attachments ?? []) args.push("--attach", quote(attachment));
  if (getFlags().aiDisabled) args.push("--no-ai");
  p.log.info(`Draft saved at ${path}. Reopen${process.platform === "win32" ? " in PowerShell" : ""} with: ${args.join(" ")}`);
}

export async function openPullRequest(options: PrCreateOptions): Promise<void> {
  header("Create Pull Request");
  if (options.body !== undefined && options.bodyFile !== undefined) { fail("Choose --body or --body-file."); return; }
  if (options.issue && !/^#?[1-9]\d*$/.test(options.issue)) { fail("Issue must be a positive issue number."); return; }
  if (options.web && options.attachments?.length) { fail("Attachments need direct creation. Omit --web."); return; }
  if (typeof options.editor === "string" && (options.title !== undefined || options.body !== undefined || options.bodyFile !== undefined)) { fail("Choose --editor FILE or explicit title/body options."); return; }
  if (options.editor !== undefined && !getFlags().dryRun && (isNonInteractive() || getFlags().json || getFlags().agent)) {
    const message = "The editor needs an interactive terminal. Run ggh pr create --editor in a terminal, or pass --title and --body-file with --yes.";
    recordCommandIssue({ status: "needs_input", code: "missing_input", requiredInputs: [{ name: "interactive terminal", description: message }], message });
    fail(message); jsonOut({ status: "needs_input", message }); return;
  }
  let editorSession: PrDraftSession | undefined;
  try {
    let prepared = await preparePublication({ kind: "pr", base: options.base, name: options.repoName, remote: options.remote });
    if (prepared.status === "needs_input" && prepared.required === "base" && !isNonInteractive()) {
      const base = await promptInput({ message: prepared.message + " Base branch:" });
      if (!base) { p.cancel("Cancelled."); return; }
      prepared = await preparePublication({ kind: "pr", base, name: options.repoName, remote: options.remote });
    }
    if (prepared.status === "needs_input") {
      recordCommandIssue({ status: "needs_input", code: "missing_input", requiredInputs: [{ name: prepared.required, description: prepared.message }], message: prepared.message });
      fail(prepared.message);
      jsonOut(options.priorCompleted?.length ? { ...prepared, status: "partially_completed", completed: options.priorCompleted } : prepared);
      return;
    }
    if (prepared.plan.kind !== "pr") throw new Error("Expected a pull request publication plan.");
    const plan: PullRequestPlan = prepared.plan;
    options = { ...options, base: plan.base, repoName: plan.target, remote: plan.remote };
    const steps = plan.steps.map(step => options.web && step === "create_pull_request" ? "open_create_page" : step);
    await prepareAttachmentPlan({ attachments: options.attachments, operation: "pr-create", recipient: plan.target, repo: `${plan.host}/${plan.target}`, host: plan.host, visibility: plan.createRepository ? plan.visibility === "public" ? "public" : "private" : "unknown", cwd: plan.cwd });
    let template: string | null = null;
    if (options.template) {
      template = await findPrTemplateByName(options.template, plan.root);
      if (!template) {
        const available = await listPrTemplates(plan.root);
        fail(`Template "${options.template}" not found.${available.length ? ` Available: ${available.map(item => item.name).join(", ")}` : ""}`);
        return;
      }
    } else template = await findPrTemplate(plan.root);
    const [commits, diff, diffStat] = await Promise.all([
      getCommitsSinceBase(plan.baseTip, 100, plan.root), getBranchDiff(plan.baseTip, plan.root), getBranchDiffStat(plan.baseTip, plan.root),
    ]);
    let title = options.title;
    let body = options.bodyFile === undefined ? options.body : await readAttachmentBodyFile(options.bodyFile);
    if (typeof options.editor !== "string" && (title === undefined || body === undefined) && !getFlags().aiDisabled && !getFlags().dryRun) {
      const spinner = p.spinner(); spinner.start("Writing the pull request with AI...");
      try {
        const { result, providerName, model } = await generatePrWithFallback({ branch: plan.head, baseBranch: plan.base, diff: sanitizeDiffForAI(diff).diff, diffStat, commitSummary: commits.join("\n"), template: template ?? undefined, issue: options.issue }, undefined, (failure: AIAttemptFailure, next?: AIAttempt) => spinner.message(formatAIFallback(failure, next)));
        title ??= result.title; body ??= result.body;
        spinner.stop(`Draft written by ${providerName} [${model}].`);
      } catch (error) { spinner.stop("Using commit history."); reportAIFailure(error, "AI generation failed:"); }
    }
    title = sanitizePrTitle(title ?? commits.at(-1) ?? `Changes from ${plan.head}`).slice(0, 256);
    body = body ?? template ?? commits.map(commit => `- ${commit}`).join("\n");
    if (!title) { fail("Pull request title cannot be empty."); return; }
    if (options.editor !== undefined) {
      if (getFlags().dryRun) {
        if (typeof options.editor === "string") ({ title, body } = readPrDraft(resolve(plan.cwd, options.editor)));
        p.log.info("Editor not run. This snapshot is provisional until the draft is edited.");
      } else {
        editorSession = await editPrDraft({ title, body }, plan.cwd, typeof options.editor === "string" ? options.editor : undefined);
        ({ title, body } = editorSession.draft);
      }
    }
    if (options.issue) {
      body += `\n\nRefs #${options.issue.replace(/^#/, "")}`;
    }
    const content = { title, body, draft: options.draft, web: options.web, attachments: options.attachments };
    const snapshotId = await publicationSnapshot(plan, content);
    assertPublicationApproval(options.approvePlan, snapshotId);
    p.note(`${plan.host}/${plan.target} (${plan.visibility})\n${plan.remote}: ${plan.remoteUrl}\n${plan.base} ${plan.baseTip.slice(0, 12)} ← ${plan.head} ${plan.headTip.slice(0, 12)}\n${steps.join(" → ")}\n${options.draft ? "Draft pull request" : "Ready for review"} · ${options.web ? "Open browser create page" : "Create pull request directly"}\n\n${title}\n${body}`, "Publication plan");
    if (dryRun(`publish ${plan.target}: ${steps.join(", ")}${options.attachments?.length ? `; attach ${options.attachments.join(", ")}` : ""}`)) {
      jsonOut({ status: "planned", snapshotId, plan, target: plan.target, host: plan.host, base: plan.base, head: plan.head, title, body, steps, attachments: options.attachments ?? [], ...(options.editor !== undefined ? { editorRun: false, snapshotProvisional: true } : {}) });
      return;
    }
    if (!(await confirmOrAbort(`Publish ${plan.head} and ${options.web ? "open the create page" : "open a pull request"} against ${plan.base}?`, { assumeYes: options.yes || Boolean(options.approvePlan) }))) {
      if (editorSession) reportRetainedDraft(editorSession.path, options);
      if (isNonInteractive()) jsonOut({ status: options.priorCompleted?.length ? "partially_completed" : "needs_input", completed: options.priorCompleted ?? [], snapshotId, plan, target: plan.target, host: plan.host, base: plan.base, head: plan.head, title, body, steps, attachments: options.attachments ?? [] });
      return;
    }
    const result = await executePublication(plan, content, { approvedSnapshot: snapshotId });
    if (result.status === "succeeded" && !options.web) editorSession?.removeGeneratedDraft();
    else if (editorSession) reportRetainedDraft(editorSession.path, options);
    const completed = [...(options.priorCompleted ?? []), ...result.completed];
    const status = result.status === "failed" && options.priorCompleted?.length ? "partially_completed" : result.status;
    if (status !== "succeeded") failPublication(result, "Publication did not complete.");
    if (jsonOut({ ...result, status, completed, title, body, base: plan.base, head: plan.head, draft: Boolean(options.draft), ...(options.web ? { action: "open_create_page" } : {}) })) return;
    if (result.url) p.log.message(result.url);
    if (status === "succeeded") p.outro(options.web ? "Finish creating the pull request in your browser." : "Pull request ready.");
    else p.log.info(`Completed: ${completed.join(", ") || "none"}. Remaining: ${result.remaining.join(", ") || "none"}. Inspect the target before retrying.`);
  } catch (error) {
        if (error instanceof PrDraftEditorError && error.retainedPath) reportRetainedDraft(error.retainedPath, options);
        else if (editorSession) reportRetainedDraft(editorSession.path, options);
        if (error instanceof PublicationApprovalError) recordCommandIssue(error.issue);
        failFromGitHub(error);
      }
}

export function registerPrCreateCommand(pr: Command): void {
  pr.command("create")
    .description("Publish the current branch and open a pull request")
    .option("-t, --title <title>", "Pull request title")
    .option("-b, --body <body>", "Pull request body")
    .option("-F, --body-file <file>", "Read the body from a local UTF-8 file")
    .option("--editor [file]", "Edit a multiline PR draft in your configured editor, or reopen a draft file")
    .option("--base <branch>", "Existing base branch")
    .option("--repo-name <name>", "Name for a new remote repository")
    .option("--remote <name>", "Remote to add or reuse")
    .option("-d, --draft", "Open as a draft")
    .option("-w, --web", "Open the create page instead")
    .option("-i, --issue <issue>", "Reference an issue number")
    .option("--approve-plan <sha256>", "Approve the exact dry-run snapshot")
    .option("-y, --yes", "Authorize the complete publication plan")
    .option("--no-ai", "Use commits and templates without AI")
    .option("--template <name>", "Use a named pull request template")
    .option("--attach <file>", "Attach an image or video, optionally path#alt text", (value: string, files: string[]) => [...files, value], [])
    .action(async (options: PrCreateOptions & { attach?: string[] }) => openPullRequest({ ...options, attachments: options.attach }));
}
