/**
 * Actions run operations. Depends on client only.
 */

import { clampLimit, classifyGitHubError, gh } from "./client.ts";
import { cached, invalidateCache } from "../cache.ts";

export interface WorkflowRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string;
  headBranch: string;
  event: string;
  createdAt: string;
  url: string;
}


export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string;
  steps?: Array<{ name: string; status: string; conclusion: string; number: number }>;
}


export async function listWorkflowRuns(
  options: { limit?: number; branch?: string; status?: string; workflow?: string } = {},
  cwd = process.cwd(),
): Promise<WorkflowRun[]> {
  const limit = clampLimit(options.limit ?? 30);
  const key = `run-list:${limit}:${options.branch ?? ""}:${options.status ?? ""}:${options.workflow ?? ""}`;
  return cached(key, () => fetchWorkflowRuns({ ...options, limit }, cwd), { ttlMs: 60_000 });
}

async function fetchWorkflowRuns(
  options: { limit: number; branch?: string; status?: string; workflow?: string },
  cwd = process.cwd(),
): Promise<WorkflowRun[]> {
  const args = [
    "run",
    "list",
    "--limit",
    String(options.limit),
    "--json",
    "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url",
  ];
  if (options.branch) args.push("--branch", options.branch);
  if (options.status) args.push("--status", options.status);
  if (options.workflow) args.push("--workflow", options.workflow);
  try {
    const { stdout } = await gh(args, { cwd });
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "workflow run list");
  }
}


export async function viewWorkflowRun(
  runId: number,
  cwd = process.cwd(),
): Promise<{ run: WorkflowRun; jobs: WorkflowJob[] } | null> {
  try {
    const args = [
      "run",
      "view",
      String(runId),
      "--json",
      "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url,jobs",
    ];
    const { stdout } = await gh(args, { cwd, reject: false });
    if (!stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return null;
    return { run: parsed, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch (err) {
    throw classifyGitHubError(err, "workflow run view");
  }
}


export async function getFailedRunLog(runId: number, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await gh(["run", "view", String(runId), "--log-failed"], {
      cwd,
      reject: false,
      timeoutMs: 60_000,
    });
    return stdout;
  } catch (err) {
    throw classifyGitHubError(err, "failed run log");
  }
}


export async function rerunWorkflowRun(
  runId: number,
  options: { failedOnly?: boolean } = {},
  cwd = process.cwd(),
): Promise<void> {
  const args = ["run", "rerun", String(runId)];
  if (options.failedOnly) args.push("--failed");
  try {
    await gh(args, { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "rerun workflow");
  } finally {
    invalidateCache("run-list:");
  }
}


export async function cancelWorkflowRun(runId: number, cwd = process.cwd()): Promise<void> {
  try {
    await gh(["run", "cancel", String(runId)], { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "cancel workflow");
  } finally {
    invalidateCache("run-list:");
  }
}

/* ------------------------------------------------------------------ *
 * Releases
 * ------------------------------------------------------------------ */
