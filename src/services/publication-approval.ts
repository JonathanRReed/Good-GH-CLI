import type { CommandIssue } from "./runtime.ts";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { publicationIntent } from "./publication-intent.ts";
import { parseAttachmentPath } from "./github/attachments.ts";
import type { PublicationPlan } from "./publication.ts";

export interface PublicationContent {
  title: string;
  body: string;
  draft?: boolean;
  web?: boolean;
  attachments?: string[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function publicationSnapshot(plan: PublicationPlan, content?: PublicationContent): Promise<string> {
  const attachments = content?.attachments ?? [];
  if (attachments.length > 50) throw new Error("GitHub supports at most 50 attachments per operation.");
  const fingerprints = [];
  const paths = new Set<string>();
  for (const value of attachments) {
    const file = parseAttachmentPath(value, plan.cwd);
    if (paths.has(file.path)) throw new Error("Duplicate attachment path.");
    paths.add(file.path);
    const handle = await open(file.path, "r");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > file.size) throw new Error("Attachment changed while preparing approval. Prepare the plan again.");
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== file.size) throw new Error("Attachment changed while preparing approval. Prepare the plan again.");
    } finally { await handle.close(); }
    fingerprints.push({ path: file.path, altText: file.altText ?? null, mediaKind: file.mediaKind, size: bytes, sha256: hash.digest("hex") });
  }
  return digest(JSON.stringify({
    intent: publicationIntent(plan, content),
    title: digest(content?.title ?? ""), body: digest(content?.body ?? ""),
    description: digest(plan.kind === "repo" ? plan.description ?? "" : ""),
    attachments: fingerprints,
  }));
}

export class PublicationApprovalError extends Error {
  readonly issue: CommandIssue;
  constructor() {
    super("Publication snapshot does not match --approve-plan. Review a fresh --dry-run plan and approve its snapshotId.");
    this.name = "PublicationApprovalError";
    this.issue = { status: "needs_input", code: "confirmation_required", message: this.message, requiredInputs: [{ name: "--approve-plan", description: "Review a fresh dry-run and supply its snapshotId." }] };
  }
}

export function assertPublicationApproval(provided: string | undefined, snapshotId: string): void {
  if (provided !== undefined && (!/^[a-f0-9]{64}$/.test(provided) || provided !== snapshotId)) {
    throw new PublicationApprovalError();
  }
}
