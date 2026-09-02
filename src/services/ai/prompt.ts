import type { CommitStyle } from "../../utils/conventions.ts";
import { formatStagedSummary, truncateDiff, type ChangedFile } from "../../utils/diff.ts";

export interface CommitPromptInput {
  branch?: string;
  stagedFiles: ChangedFile[];
  stagedDiff: string;
  diffStat?: string;
  issue?: string;
  style?: CommitStyle;
  customGuidance?: string;
}

export interface CommitMessageResult {
  subject: string;
  body: string;
}

export interface PrPromptInput {
  branch: string;
  baseBranch: string;
  diff: string;
  diffStat?: string;
  commitSummary?: string;
  template?: string;
  issue?: string;
}

export interface PrContentResult {
  title: string;
  body: string;
}

export function buildCommitPrompt(input: CommitPromptInput): string {
  const style = input.style || "conventional";

  let styleInstruction = "- format: Conventional Commits with a type (and optional scope): e.g. feat: ..., fix: ..., refactor: ..., docs: ...";
  if (style === "gitmoji") {
    styleInstruction = "- format: Use an appropriate gitmoji at the beginning of the subject (e.g. :sparkles: feat: ..., :bug: fix: ...)";
  } else if (style === "concise") {
    styleInstruction = "- format: Short, clean imperative sentence without prefix (e.g. Add user authentication)";
  }

  const promptParts = [
    "You write concise, high-quality git commit messages.",
    "Return a JSON object strictly in this format without markdown fences or other text:",
    JSON.stringify({ subject: "commit subject here", body: "optional short bullet points or empty string" }),
    "",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body should be short bullet points explaining why, or an empty string if simple",
    styleInstruction,
    "- capture the primary developer-visible or user-visible change accurately",
  ];

  if (input.issue) {
    promptParts.push(`- include 'Fixes #${input.issue}' in the body footer`);
  }

  if (input.customGuidance) {
    promptParts.push(`- special instruction: ${input.customGuidance}`);
  }

  promptParts.push(
    "",
    `Branch: ${input.branch || "main"}`,
    "",
    "Staged files:",
    formatStagedSummary(input.stagedFiles, 6_000),
  );

  if (input.diffStat) {
    promptParts.push("", "Diff stat:", input.diffStat);
  }

  promptParts.push(
    "",
    "Staged patch:",
    truncateDiff(input.stagedDiff, 40_000),
  );

  return promptParts.join("\n");
}

export function buildPrPrompt(input: PrPromptInput): string {
  const parts = [
    "You write concise, professional GitHub Pull Request titles and descriptions.",
    "Return a JSON object strictly in this format without markdown fences or other text:",
    JSON.stringify({ title: "PR title here", body: "Markdown formatted description here" }),
    "",
    "Rules:",
    "- title must be clear and <= 72 characters",
    "- body must summarize key changes and rationale using clean markdown bullet points",
  ];

  if (input.issue) {
    parts.push(`- Link this Pull Request to issue #${input.issue} (e.g. 'Closes #${input.issue}' or 'Fixes #${input.issue}').`);
  }

  if (input.template) {
    parts.push(
      "",
      "IMPORTANT: Structure the PR body strictly following this repository's pull request template:",
      input.template,
      "---",
    );
  }

  parts.push(
    "",
    `Base Branch: ${input.baseBranch}`,
    `Head Branch: ${input.branch}`,
    ...(input.commitSummary ? [`Commit History:\n${input.commitSummary}\n`] : []),
  );

  if (input.diffStat) {
    parts.push(`Diff Stat:\n${input.diffStat}\n`);
  }

  parts.push("Diff:", truncateDiff(input.diff, 30_000));

  return parts.join("\n");
}

export function buildBranchNamePrompt(taskDescription: string): string {
  return [
    "Generate a short, semantic git branch name from the following description.",
    "Rules:",
    "- Output ONLY the branch name, nothing else (no quotes, no markdown, no explanation).",
    "- Use kebab-case with type prefix: e.g. feat/add-login, fix/button-alignment, refactor/auth-tokens.",
    "- Keep it under 40 characters.",
    "",
    `Description: ${taskDescription}`,
  ].join("\n");
}

/**
 * Resiliently parses raw JSON output from an LLM, handling markdown code fences,
 * conversational preambles/postambles, trailing commas, and nested brackets.
 */
export function parseJsonResponse<T>(raw: string, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;

  // 1. Isolate markdown code fence if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  // 2. Try direct parse first
  try {
    const cleaned = candidate.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to balanced scan
  }

  // 3. Scan for first balanced { ... }
  const start = candidate.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < candidate.length; i++) {
      const char = candidate[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") {
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0) {
            const jsonSubstring = candidate.slice(start, i + 1);
            try {
              const cleaned = jsonSubstring.replace(/,\s*([}\]])/g, "$1");
              return JSON.parse(cleaned) as T;
            } catch {
              // Try regex fallback below
            }
          }
        }
      }
    }
  }

  return fallback;
}
