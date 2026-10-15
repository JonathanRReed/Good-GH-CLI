/**
 * GitHub CLI attachment validation and transport.
 *
 * The configured executable protocol is argv-safe: it receives the local file
 * path and recipient as two arguments and must print JSON shaped as
 * {"url":"https://..."}. It is considered only for verified public targets.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getConfig } from "../config.ts";
import { getActiveHost, ghGlobal, parseRepoFlag } from "./client.ts";
import { run } from "../../utils/exec.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 50;
const IMAGE_EXTENSIONS = new Set([".png", ".gif", ".jpg", ".jpeg", ".svg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const BODY_FILE_MAX_BYTES = 1024 * 1024;

export type AttachmentOperation =
  | "pr-create" | "pr-edit" | "pr-comment"
  | "issue-create" | "issue-edit" | "issue-comment";

export type AttachmentVisibility = "private" | "public" | "unknown";

export interface AttachmentFile {
  path: string;
  cliValue: string;
  altText?: string;
  mediaKind: "image" | "video";
  size: number;
}

export interface UploadedAttachment {
  file: AttachmentFile;
  url: string;
}

export type AttachmentPlan =
  | { kind: "none"; files: [] }
  | { kind: "native"; files: AttachmentFile[]; operation: AttachmentOperation; recipient: string }
  | { kind: "fallback"; files: AttachmentFile[]; operation: AttachmentOperation; recipient: string; executable: string };

export interface AttachmentPlanInput {
  attachments?: string[];
  operation: AttachmentOperation;
  recipient: string;
  visibility: AttachmentVisibility;
  repo?: string;
  host?: string;
  cwd?: string;
}

export class PartialGitHubMutationError extends Error {
  readonly resourceUrl: string;
  readonly operation: string;
  readonly attachments: { requestedCount: number; failedFiles?: string[] };

  constructor(input: {
    resourceUrl: string;
    operation: string;
    requestedCount: number;
    failedFiles?: string[];
  }) {
    super(`${input.operation} created ${input.resourceUrl}, but attachment upload did not finish.`);
    this.name = "PartialGitHubMutationError";
    this.resourceUrl = input.resourceUrl;
    this.operation = input.operation;
    this.attachments = {
      requestedCount: input.requestedCount,
      ...(input.failedFiles === undefined ? {} : { failedFiles: input.failedFiles }),
    };
  }
}

export class PartialAttachmentOperationError extends Error {
  readonly kind = "partial_attachment_operation";
  readonly operation: AttachmentOperation;
  readonly phase: "storage_upload" | "github_mutation";
  readonly uploadedAttachments: UploadedAttachment[];
  readonly remainingFiles: AttachmentFile[];
  readonly cause: unknown;

  constructor(input: {
    operation: AttachmentOperation;
    phase: "storage_upload" | "github_mutation";
    uploadedAttachments: UploadedAttachment[];
    remainingFiles: AttachmentFile[];
    cause: unknown;
  }) {
    const count = input.uploadedAttachments.length;
    const detail = input.phase === "storage_upload"
      ? `Fallback storage stopped during ${input.operation} after ${count} confirmed upload(s); ${input.remainingFiles.length} file(s) remain unconfirmed. Inspect uploaded URLs and retry only the remaining files.`
      : `GitHub ${input.operation} failed after fallback storage uploaded ${count} file(s). No GitHub resource URL is confirmed. Inspect uploaded URLs and retry the GitHub operation without uploading those files again.`;
    const causeMessage = input.cause instanceof Error ? ` ${input.cause.message}` : "";
    super(`${detail}${causeMessage}`, { cause: input.cause });
    this.name = "PartialAttachmentOperationError";
    this.operation = input.operation;
    this.phase = input.phase;
    this.uploadedAttachments = input.uploadedAttachments;
    this.remainingFiles = input.remainingFiles;
    this.cause = input.cause;
  }
}

const helpCache = new Map<string, boolean>();

export function parseAttachmentPath(value: string, cwd: string): AttachmentFile {
  const separator = value.indexOf("#");
  const rawPath = separator === -1 ? value : value.slice(0, separator);
  const altText = separator === -1 ? undefined : value.slice(separator + 1);
  if (!rawPath || rawPath.includes("\0")) throw new Error(`Invalid attachment path: ${value}`);
  if (separator !== -1 && (!altText?.trim() || /[#\0\r\n]/.test(altText))) {
    throw new Error(`Invalid attachment alt text for ${rawPath}.`);
  }

  const path = resolve(cwd, rawPath);
  let file;
  try {
    file = statSync(path);
  } catch {
    throw new Error(`Attachment file does not exist: ${rawPath}`);
  }
  if (!file.isFile()) throw new Error(`Attachment must be a regular file: ${rawPath}`);

  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const mediaKind = IMAGE_EXTENSIONS.has(extension) ? "image" : VIDEO_EXTENSIONS.has(extension) ? "video" : undefined;
  if (!mediaKind) throw new Error(`Unsupported attachment type: ${rawPath}. Use PNG, GIF, JPG, JPEG, SVG, WEBP, MP4, MOV, or WEBM.`);
  const maxBytes = mediaKind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size <= 0 || file.size > maxBytes) {
    const limit = mediaKind === "image" ? "10 MiB" : "100 MiB";
    throw new Error(`Attachment must be between 1 byte and ${limit}: ${rawPath}`);
  }
  if (mediaKind === "video" && altText !== undefined) {
    throw new Error(`GitHub CLI does not support alt text on video attachments: ${rawPath}`);
  }
  if (!hasMatchingMediaHeader(path, mediaKind, extension)) {
    throw new Error(`Attachment content does not match its ${extension} file extension: ${rawPath}`);
  }
  return {
    path,
    cliValue: altText === undefined ? path : `${path}#${altText}`,
    ...(altText === undefined ? {} : { altText }),
    mediaKind,
    size: file.size,
  };
}

function hasMatchingMediaHeader(path: string, kind: "image" | "video", extension: string): boolean {
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(512);
  let bytesRead: number;
  try {
    bytesRead = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const bytes = header.subarray(0, bytesRead);
  if (kind === "image") {
    if (extension === ".png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (extension === ".gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
    if (extension === ".jpg" || extension === ".jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (extension === ".webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    return /^\s*(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  }
  if (extension === ".webm") return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return bytes.length >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

async function supportsNativeAttachment(operation: AttachmentOperation, cwd: string): Promise<boolean> {
  const command = operation.startsWith("pr-") ? "pr" : "issue";
  const action = operation.endsWith("create") ? "create" : operation.endsWith("edit") ? "edit" : "comment";
  const key = `${command} ${action}`;
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const { stdout, stderr } = await ghGlobal([command, action, "--help"], { cwd });
    const supported = /(?:^|\s)--attach(?:\s|[,=]|$)/m.test(`${stdout}\n${stderr}`);
    helpCache.set(key, supported);
    return supported;
  } catch {
    helpCache.set(key, false);
    return false;
  }
}

/** Validate files and choose the available transport before any remote write. */
export async function prepareAttachmentPlan(input: AttachmentPlanInput): Promise<AttachmentPlan> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return { kind: "none", files: [] };
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`GitHub supports at most ${MAX_ATTACHMENTS} attachments per operation.`);
  const cwd = input.cwd ?? process.cwd();
  const files = attachments.map((item) => parseAttachmentPath(item, cwd));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("The same file cannot be attached more than once.");
  }

  const host = (input.host ?? parseRepoFlag(input.repo)?.host ?? getActiveHost()).toLowerCase().replace(/:\d+$/, "");
  const nativeHost = host === "github.com" || host.endsWith(".ghe.com");
  if (nativeHost && await supportsNativeAttachment(input.operation, cwd)) {
    return { kind: "native", files, operation: input.operation, recipient: input.recipient };
  }

  const executable = getConfig(cwd).attachment_upload_command?.trim() ?? "";
  if (!executable) {
    if (!nativeHost) throw new Error(`Native attachments require GitHub.com or a GHE.com tenant. Host ${host} needs configured storage for a verified public target.`);
    throw new Error(`This gh ${input.operation.startsWith("pr-") ? "pr" : "issue"} command does not support --attach. Upgrade GitHub CLI or configure attachment_upload_command for a verified public target.`);
  }
  if (!isAbsolute(executable)) throw new Error("attachment_upload_command must be an absolute executable path.");
  if (input.visibility === "private") {
    throw new Error("Configured attachment storage is refused for private repository visibility. Use native GitHub attachments or verify access another way.");
  }
  let observedVisibility: "private" | "public" | "unknown" = "unknown";
  try {
    const repo = parseRepoFlag(input.repo);
    const result = repo
      ? await ghGlobal(["repo", "view", repo.repoArg, "--json", "isPrivate"], {
        cwd,
        env: { GH_REPO: repo.nameWithOwner, GH_HOST: input.host ?? repo.host },
      })
      : await ghGlobal(["repo", "view", "--json", "isPrivate"], { cwd });
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && "isPrivate" in parsed) {
      if (parsed.isPrivate === true) observedVisibility = "private";
      if (parsed.isPrivate === false) observedVisibility = "public";
    }
  } catch {
    observedVisibility = "unknown";
  }
  if (observedVisibility === "private") {
    throw new Error("Configured attachment storage is refused because repository visibility is private. Use native GitHub attachments or verify access another way.");
  }
  if (observedVisibility !== "public") {
    throw new Error("Configured attachment storage is refused because repository visibility could not be verified as public. Use native GitHub attachments or verify access another way.");
  }
  try {
    const executableInfo = statSync(executable);
    const executableOnPlatform = process.platform === "win32"
      ? /\.exe$/i.test(executable)
      : (executableInfo.mode & 0o111) !== 0;
    if (!executableInfo.isFile() || !executableOnPlatform) {
      throw new Error("not executable");
    }
  } catch {
    throw new Error("attachment_upload_command must point to an existing executable file.");
  }
  return { kind: "fallback", files, operation: input.operation, recipient: input.recipient, executable };
}

/** Run trusted fallback storage without a shell and validate its result. */
export async function uploadFallbackAttachment(
  plan: Extract<AttachmentPlan, { kind: "fallback" }>,
  file: AttachmentFile,
): Promise<string> {
  const { stdout } = await run(plan.executable, [file.path, plan.recipient]);
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Configured attachment storage must return JSON containing an HTTPS url.");
  }
  if (!result || typeof result !== "object" || !("url" in result) || typeof result.url !== "string") {
    throw new Error("Configured attachment storage must return JSON containing an HTTPS url.");
  }
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    throw new Error("Configured attachment storage returned an invalid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Configured attachment storage must return a credential-free HTTPS URL.");
  }
  return url.toString();
}

export async function uploadFallbackAttachments(plan: AttachmentPlan): Promise<UploadedAttachment[]> {
  if (plan.kind !== "fallback") return [];
  const uploaded: UploadedAttachment[] = [];
  for (const [index, file] of plan.files.entries()) {
    try {
      uploaded.push({ file, url: await uploadFallbackAttachment(plan, file) });
    } catch (cause) {
      throw new PartialAttachmentOperationError({
        operation: plan.operation,
        phase: "storage_upload",
        uploadedAttachments: uploaded,
        remainingFiles: plan.files.slice(index),
        cause,
      });
    }
  }
  return uploaded;
}

export function fallbackMutationFailure(
  plan: AttachmentPlan,
  uploadedAttachments: UploadedAttachment[],
  cause: unknown,
): PartialAttachmentOperationError | undefined {
  if (plan.kind !== "fallback" || uploadedAttachments.length === 0) return undefined;
  return new PartialAttachmentOperationError({
    operation: plan.operation,
    phase: "github_mutation",
    uploadedAttachments,
    remainingFiles: [],
    cause,
  });
}

export function addAttachmentArgs(args: string[], plan: AttachmentPlan): string[] {
  if (plan.kind !== "native") return args;
  for (const file of plan.files) args.push("--attach", file.cliValue);
  return args;
}

export function describeAttachmentPlan(plan: AttachmentPlan): string {
  return plan.files.length === 0 ? "" : `; attach ${plan.files.map((file) => file.cliValue).join(", ")}`;
}

export function appendFallbackMarkdown(body: string, uploads: Array<{ file: AttachmentFile; url: string }>): string {
  if (uploads.length === 0) return body;
  const markdown = uploads.map(({ file, url }) => file.mediaKind === "image"
    ? `![${file.altText ?? file.path.split(/[\\/]/).pop() ?? "image"}](${url})`
    : `[${file.path.split(/[\\/]/).pop() ?? "video"}](${url})`);
  return [body.trimEnd(), ...markdown].filter(Boolean).join("\n\n");
}

export function readAttachmentBodyFile(path: string, cwd = process.cwd()): string {
  if (path === "-") return readBoundedUtf8(0, BODY_FILE_MAX_BYTES, "standard input");
  const resolvedPath = resolve(cwd, path);
  let info;
  try {
    info = statSync(resolvedPath);
  } catch {
    throw new Error(`Body file does not exist: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Body file must be a regular file: ${path}`);
  if (info.size > BODY_FILE_MAX_BYTES) throw new Error(`Body file must be no larger than 1 MiB: ${path}`);
  const descriptor = openSync(resolvedPath, "r");
  try {
    return readBoundedUtf8(descriptor, BODY_FILE_MAX_BYTES, path);
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedUtf8(descriptor: number, maxBytes: number, source: string): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new Error(`Body from ${source} must be no larger than 1 MiB.`);
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error(`Body from ${source} must contain valid UTF-8 text.`);
  }
}
