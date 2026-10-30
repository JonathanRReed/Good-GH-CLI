import type { Command } from "commander";
import { getFlags, isNonInteractive, recordCommandIssue, recordCompletedEffect } from "../services/runtime.ts";
import {
  findIssuePlans,
  getActiveHost,
  getCurrentRepositoryNameWithOwner,
  IssuePlanTargetError,
  parseRepoFlag,
  readAttachmentBodyFile,
  readIssuePlan,
  requireAuth,
  saveIssuePlan,
  type IssueArtifact,
} from "../services/github.ts";
import { assertPublicationApproval, digest, issuePlanSnapshot, PublicationApprovalError } from "../services/publication-approval.ts";
import { dryRun } from "../utils/flags.ts";
import { parsePositiveSafeInteger } from "../utils/numeric-target.ts";
import { data } from "../utils/output.ts";
import { confirmOrAbort, fail, failFromGitHub, header, jsonOut, p, pc } from "../utils/ui.ts";

export interface IssuePlanOptions { name?: string; show?: boolean; approvePlan?: string; yes?: boolean }

const DEFAULT_PLAN_NAME = "Plan";
const MAX_PLAN_NAME_LENGTH = 255;

/** GitHub may store a plan without its trailing newline; that alone is not a change. */
function samePlanContent(current: string, next: string): boolean {
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
  return normalize(current) === normalize(next);
}

function planName(value: string | undefined): string | undefined {
  const name = (value ?? DEFAULT_PLAN_NAME).trim();
  // GitHub rejects parentheses in artifact names; control characters never round-trip.
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > MAX_PLAN_NAME_LENGTH || /[\x00-\x1f\x7f()]/.test(name)) return undefined;
  return name;
}

/** Refuses when more than one plan shares the name, so an edit never lands on a guess. */
function refuseAmbiguous(issue: number, name: string, matches: IssueArtifact[]): void {
  const list = matches.map(item => `#${item.number}${item.url ? ` ${item.url}` : ""}`).join(", ");
  fail(`Issue #${issue} has ${matches.length} plans named "${name}": ${list}. Rename or delete the extras with gh issue artifact, or pass --name for a different plan.`, { code: "invalid_arguments" });
  jsonOut({ status: "failed", reason: "ambiguous_name", issue, name, candidates: matches });
}

async function showIssuePlan(issue: number, name: string): Promise<void> {
  const matches = await findIssuePlans(issue, name);
  if (matches.length > 1) { refuseAmbiguous(issue, name, matches); return; }
  const match = matches[0];
  if (!match) {
    fail(`Issue #${issue} has no plan named "${name}". Save one with: ggh issue plan ${issue} <file>${name === DEFAULT_PLAN_NAME ? "" : ` --name '${name}'`}`, { code: "not_found" });
    return;
  }
  const plan = await readIssuePlan(issue, match.number);
  if (jsonOut({ issue, number: plan.number, name: plan.name, url: plan.url, updatedAt: plan.updatedAt, body: plan.body })) return;
  data(plan.body.replace(/\n+$/, ""));
}

async function saveIssuePlanCommand(issue: number, file: string | undefined, name: string, options: IssuePlanOptions): Promise<void> {
  if (file === undefined) {
    const message = "Pass a plan file, or - to read standard input. Read the current plan with --show.";
    fail(message, { code: "missing_input", requiredInputs: [{ name: "file", description: message }] });
    return;
  }
  let body: string;
  try {
    body = readAttachmentBodyFile(file);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), { code: "invalid_arguments" });
    return;
  }
  if (!body.trim()) { fail("The plan is empty. Write the plan to a file or standard input first.", { code: "invalid_arguments" }); return; }

  const repo = await getCurrentRepositoryNameWithOwner();
  if (!repo) { fail("Run inside a GitHub repository or pass -R owner/name.", { code: "missing_input" }); return; }
  const host = parseRepoFlag()?.host ?? getActiveHost();

  const matches = await findIssuePlans(issue, name);
  if (matches.length > 1) { refuseAmbiguous(issue, name, matches); return; }
  const match = matches[0];
  const existing = match ? await readIssuePlan(issue, match.number) : undefined;
  const action = !existing ? "create" : samePlanContent(existing.body, body) ? "no_op" : "edit";
  const content = { sha256: digest(body), bytes: Buffer.byteLength(body) };
  const snapshotId = issuePlanSnapshot({
    host, repo, issue, name, action, artifactNumber: existing?.number ?? null,
    currentSha256: existing ? digest(existing.body) : null, contentSha256: content.sha256,
  });
  assertPublicationApproval(options.approvePlan, snapshotId);
  const summary = {
    snapshotId, target: `${host}/${repo}#${issue}`, repo, host, issue, name, action,
    artifact: existing ? { number: existing.number, url: existing.url } : null, content,
  };
  const verb = action === "create" ? "Create" : action === "edit" ? "Save a new version of" : "Keep";
  p.note(`${host}/${repo} issue #${issue}\n${verb} plan "${name}"${existing ? ` (artifact #${existing.number})` : ""}\n${content.bytes} bytes · sha256 ${content.sha256.slice(0, 12)}`, "Issue plan");

  if (dryRun(action === "no_op" ? `leave plan "${name}" on issue #${issue} unchanged` : `${verb.toLowerCase()} plan "${name}" on issue #${issue}`)) {
    jsonOut({ status: "planned", ...summary });
    return;
  }
  if (action === "no_op") {
    if (jsonOut({ status: "no_op", ...summary, url: existing?.url })) return;
    p.outro(`Plan "${name}" already matches. Nothing saved.`);
    return;
  }
  if (getFlags().agent && !options.approvePlan) {
    const message = "Saving a plan in agent mode needs an approved snapshot. Run the same command with --dry-run --agent, review it, then pass --approve-plan <snapshotId>.";
    recordCommandIssue({ status: "needs_input", code: "confirmation_required", message, requiredInputs: [{ name: "--approve-plan", description: "Review a fresh dry-run and supply its snapshotId." }] });
    fail(message);
    return;
  }
  if (!(await confirmOrAbort(`${verb} plan "${name}" on issue #${issue}?`, { assumeYes: options.yes || Boolean(options.approvePlan) }))) {
    if (isNonInteractive()) jsonOut({ status: "needs_input", ...summary });
    return;
  }
  const url = await saveIssuePlan(issue, { name, body, artifactNumber: existing?.number }) ?? existing?.url;
  recordCompletedEffect(action === "create" ? "issue_plan_created" : "issue_plan_version_created");
  if (jsonOut({ status: "succeeded", ...summary, url })) return;
  p.log.success(pc.green(action === "create" ? `Plan "${name}" saved on issue #${issue}.` : `Saved a new version of plan "${name}".`));
  if (url) p.log.message(pc.dim(url));
  p.outro("Done.");
}

export async function issuePlan(issueNumber: string, file: string | undefined, options: IssuePlanOptions): Promise<void> {
  const issue = parsePositiveSafeInteger(issueNumber);
  if (issue === null) { fail(`Invalid issue number: ${issueNumber}`, { code: "invalid_arguments" }); return; }
  const name = planName(options.name);
  if (name === undefined) { fail(`Plan names need 1-${MAX_PLAN_NAME_LENGTH} characters without control characters or parentheses.`, { code: "invalid_arguments" }); return; }
  if (options.show && file !== undefined) { fail("Pass a file to save a plan, or --show to read one, not both.", { code: "invalid_arguments" }); return; }

  header(options.show ? "Issue Plan" : "Save Issue Plan");
  if (!(await requireAuth())) return;
  try {
    if (options.show) await showIssuePlan(issue, name);
    else await saveIssuePlanCommand(issue, file, name, options);
  } catch (err) {
    if (err instanceof PublicationApprovalError) recordCommandIssue(err.issue);
    if (err instanceof IssuePlanTargetError) { fail(err.message, { code: "invalid_arguments" }); return; }
    failFromGitHub(err);
  }
}

export function registerIssuePlanCommand(issue: Command): void {
  issue.command("plan <issueNumber> [file]")
    .description("Save a plan on an issue as a versioned artifact, or print it with --show")
    .option("--name <name>", `Plan name; an existing plan with this name gets a new version (default: "${DEFAULT_PLAN_NAME}")`)
    .option("--show", "Print the current plan body to stdout")
    .option("--approve-plan <sha256>", "Approve the exact dry-run snapshot")
    .option("-y, --yes", "Skip the confirmation prompt (not accepted in agent mode)")
    .addHelpText("after", "\nRead the plan from standard input with -. Saving the same content again changes nothing.")
    .action(async (issueNumber: string, file: string | undefined, options: IssuePlanOptions) => issuePlan(issueNumber, file, options));
}
