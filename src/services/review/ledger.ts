import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.ts";
import { assertWindowsPrivateDirectory } from "../private-storage.ts";

export interface ReviewMark {
  reviewedHead: string;
  reviewedBase: string;
  mergeBase: string;
  at: string;
  scope: "inspected" | "decided";
  note?: string;
}

export const isReviewSha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

function parseMark(value: unknown): ReviewMark {
  if (typeof value !== "object" || value === null ||
      !("reviewedHead" in value) || !isReviewSha(value.reviewedHead) ||
      !("reviewedBase" in value) || !isReviewSha(value.reviewedBase) ||
      !("mergeBase" in value) || !isReviewSha(value.mergeBase) ||
      !("at" in value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !("scope" in value) || (value.scope !== "inspected" && value.scope !== "decided") ||
      ("note" in value && typeof value.note !== "string")) throw new Error("Invalid local review ledger entry.");
  return { reviewedHead: value.reviewedHead, reviewedBase: value.reviewedBase, mergeBase: value.mergeBase,
    at: value.at, scope: value.scope, ...("note" in value && typeof value.note === "string" ? { note: value.note } : {}) };
}

function privatePath(path: string, directory: boolean): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`Unsafe local review ledger permissions: ${path}`);
  if (!directory && info.size > 16 * 1024 * 1024) throw new Error("Local review ledger is too large.");
}

function ledgerPath(key: string, configDir: string, create: boolean): string {
  const directory = join(configDir, "reviews");
  assertWindowsPrivateDirectory(directory, create);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const path = join(directory, `${createHash("sha256").update(key.toLowerCase()).digest("hex")}.jsonl`);
  privatePath(path, false);
  return path;
}

export function readReviewMark(key: string, configDir = getConfigDir()): ReviewMark | undefined {
  const path = ledgerPath(key, configDir, false);
  if (!existsSync(path)) return undefined;
  const entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const last = entries.at(-1);
  return last === undefined ? undefined : parseMark(JSON.parse(last));
}

export function markReview(key: string, mark: ReviewMark, configDir = getConfigDir()): void {
  const entry = `${JSON.stringify(parseMark(mark))}\n`;
  if (Buffer.byteLength(entry) > 64 * 1024) throw new Error("Local review mark is too large.");
  appendFileSync(ledgerPath(key, configDir, true), entry, { mode: 0o600 });
}
