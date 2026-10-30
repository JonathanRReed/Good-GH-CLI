import type { OperationRecord } from "./operations.ts";
import { preparePublication, type PublicationPlan, type PreparePublicationResult } from "./publication.ts";

export function operationRecoveryGuide(record: OperationRecord) {
  const complete = record.status.state === "succeeded" || record.status.state === "no_op";
  return {
    operationId: record.id,
    state: record.status.state,
    resumable: Boolean(record.resume) && !complete,
    completed: record.steps.filter(step => step.state === "completed").map(step => step.name),
    remaining: record.steps.filter(step => step.state === "pending").map(step => step.name),
    uncertain: record.steps.filter(step => step.state === "unknown" || step.state === "failed").map(step => step.name),
    resources: record.resources,
    requiredContent: record.resume ? {
      pullRequest: record.resume.requiresPrContent,
      attachments: record.resume.requiresAttachments && !record.steps.some(step => step.name === "upload_attachments" && step.state === "completed"),
      description: record.resume.requiresDescription && !record.steps.some(step => step.name === "create_repository" && step.state === "completed"),
    } : null,
    inspection: [`ggh operation view ${record.id}`, "ggh git status --short", "ggh git log --oneline -5", ...(record.command.startsWith("stack") ? ["ggh stack list --json", "ggh stack submit --dry-run"] : [])],
    ...(record.resume ? {} : { guidance: "Automatic replay is unavailable. Inspect current work and use the command's existing recovery path; commits, comments and uploads are never recreated from missing content." }),
  };
}

export async function preparePublicationResume(record: OperationRecord): Promise<PreparePublicationResult> {
  const intent = record.resume;
  if (!intent) return { status: "needs_input", required: "repository", message: "This record has no publication intent. Inspect the operation before choosing a recovery command." };
  const saved = intent.plan;
  const request = saved.kind === "pr"
    ? { kind: "pr" as const, cwd: saved.cwd, source: saved.source, name: `${saved.host}/${saved.target}`, visibility: saved.visibility, base: saved.base, remote: saved.remote }
    : { kind: "repo" as const, cwd: saved.cwd, source: saved.source, name: `${saved.host}/${saved.target}`, visibility: saved.visibility, push: saved.push, remote: saved.remote };
  const prepared = await preparePublication(request);
  if (prepared.status !== "ready") return prepared;
  const changed = publicationResumeChange(saved, prepared.plan);
  return changed ? { status: "needs_input", required: "repository", message: changed } : prepared;
}

export function publicationResumeChange(saved: PublicationPlan, current: PublicationPlan): string | undefined {
  if (saved.kind !== current.kind || saved.cwd !== current.cwd || saved.root !== current.root || saved.source !== current.source ||
      saved.host !== current.host || saved.target !== current.target || saved.remote !== current.remote || saved.remoteUrl !== current.remoteUrl || saved.pushUrl !== current.pushUrl ||
      saved.head !== current.head || saved.headTip !== current.headTip || saved.visibility !== current.visibility) {
    return "The publication target, worktree, remote, push URL or head changed. Prepare and approve a new publication instead of replaying this record.";
  }
  if (saved.kind === "pr" && current.kind === "pr" && (saved.base !== current.base || saved.baseTip !== current.baseTip || saved.mergeBaseTip !== current.mergeBaseTip || (saved.localBaseTip ?? saved.baseTip) !== (current.localBaseTip ?? current.baseTip) || (saved.remoteBaseTip !== current.remoteBaseTip && !(saved.remoteBaseTip === undefined && saved.steps.includes("push_base") && current.remoteBaseTip === saved.baseTip)))) {
    return "The publication base changed. Prepare and approve a new publication instead of replaying this record.";
  }
  return undefined;
}
