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

export interface ReviewPromptInput {
  title: string;
  diff: string;
  /** Extra direction, e.g. "focus on error handling". */
  guidance?: string;
}

export interface ReviewFinding {
  /** Repository-relative path exactly as it appears in the diff. */
  path: string;
  /** Line number in the NEW file, as shown in the diff hunk header. */
  line: number;
  severity: "blocker" | "concern" | "nit";
  body: string;
  /** Optional unified diff hunk that fixes the finding, for `ggh pr review --fix`. */
  suggestedFix?: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const parts = [
    "You are a careful senior engineer reviewing a pull request.",
    "Return a JSON object strictly in this format, with no markdown fences and no other text:",
    JSON.stringify({
      summary: "two or three sentences on what this change does and its overall risk",
      findings: [
        { path: "src/example.ts", line: 42, severity: "blocker", body: "what is wrong and how to fix it", suggestedFix: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -40,7 +40,7 @@\n context line\n-old line\n+new line\n context line" },
      ],
    }),
    "",
    "Rules:",
    "- only report real defects: correctness bugs, security issues, resource leaks, missing error handling, broken edge cases",
    "- severity is 'blocker' (must fix before merge), 'concern' (should fix), or 'nit' (optional polish)",
    "- 'path' must exactly match a file path in the diff, and 'line' must be a line the diff ADDS (a '+' line)",
    "- never invent a path or a line number; if you are unsure of the line, leave the finding out",
    "- do not comment on formatting, or restate what the code obviously does",
    "- an empty findings array is the correct answer for a clean change",
    "- 'suggestedFix' is an optional unified diff hunk (with ---/+++ headers and @@ hunk headers) that fixes the finding; omit it when you cannot produce a correct patch",
  ];

  if (input.guidance) {
    parts.push(`- reviewer direction: ${input.guidance}`);
  }

  parts.push("", `Pull Request: ${input.title}`, "", "Diff:", truncateDiff(input.diff, 60_000));
  return parts.join("\n");
}

export interface ReleaseNotesPromptInput {
  tag: string;
  previousTag?: string;
  commits: string[];
}

export function buildReleaseNotesPrompt(input: ReleaseNotesPromptInput): string {
  return [
    `You write clean, professional GitHub Release Notes for version ${input.tag}.`,
    "Return Markdown only, with no code fences and no preamble.",
    "",
    "Rules:",
    "- group the changes under '### Features', '### Fixes', and '### Maintenance' headings",
    "- omit any heading that has no entries",
    "- one concise bullet per user-visible change; merge duplicates",
    "- do not invent changes that are not in the commit list",
    "",
    input.previousTag ? `Changes since ${input.previousTag}:` : "Changes in this release:",
    ...input.commits.map((c) => `- ${c}`),
  ].join("\n");
}

export interface IssueBodyPromptInput {
  title: string;
  /** Optional free-form notes the user supplied to steer the body. */
  notes?: string;
  /** Optional repo context (e.g. "owner/repo") to ground the body. */
  repo?: string;
}

export function buildIssueBodyPrompt(input: IssueBodyPromptInput): string {
  const parts = [
    "You write a clear, professional GitHub issue body from a title and optional notes.",
    "Return Markdown only, with no code fences around the whole response and no preamble.",
    "",
    "Rules:",
    "- Start with a one-paragraph '## Description' that explains the problem or request in plain language.",
    "- Include a '## Steps to reproduce' section with numbered steps when the issue describes a bug.",
    "- Include '## Expected' and '## Actual' sections when relevant.",
    "- Omit any section that does not apply (e.g. feature requests do not need reproduction steps).",
    "- Do not invent specifics, logs, or stack traces that are not in the title or notes.",
    "- Keep it concise and skimmable; prefer bullets over long paragraphs.",
  ];
  if (input.repo) parts.push("", `Repository: ${input.repo}`);
  parts.push("", `Issue title: ${input.title}`);
  if (input.notes && input.notes.trim()) {
    parts.push("", "Notes from the reporter:", input.notes.trim());
  }
  return parts.join("\n");
}

export interface TriageItem {
  id: string;
  title: string;
  type: string;
  reason?: string;
  body?: string;
}

export interface TriageResult {
  groups: Array<{
    label: string;
    itemIds: string[];
    summary: string;
  }>;
  suggestions: Array<{
    itemId: string;
    suggestedLabel?: string;
    priority: "high" | "medium" | "low";
    draftResponse?: string;
  }>;
}

export function buildTriagePrompt(items: TriageItem[]): string {
  return [
    "You are a senior engineer triaging a GitHub notification/issue inbox.",
    "Return a JSON object strictly in this format, with no markdown fences and no other text:",
    JSON.stringify({
      groups: [{ label: "bugs", itemIds: ["1", "2"], summary: "two crash reports related to auth" }],
      suggestions: [{ itemId: "1", suggestedLabel: "bug", priority: "high", draftResponse: "Thanks for reporting — I can reproduce this. Working on a fix." }],
    }),
    "",
    "Rules:",
    "- group items by theme: bugs, features, questions, duplicates, maintenance, etc.",
    "- omit any group that has no items",
    "- for each item, suggest a label, a priority (high/medium/low), and a short draft response when one is obvious",
    "- draftResponse should be 1-2 sentences, professional, and never commit to a timeline",
    "- an empty groups array is correct when there is nothing to triage",
    "",
    "Items to triage:",
    ...items.map((i) => `- [${i.id}] (${i.type}) ${i.title}${i.reason ? ` — ${i.reason}` : ""}${i.body ? `\n  ${i.body.slice(0, 200)}` : ""}`),
  ].join("\n");
}

export interface SplitPromptInput {
  branch?: string;
  stagedFiles: ChangedFile[];
  stagedDiff: string;
  diffStat?: string;
  style?: CommitStyle;
}

export interface SplitCommit {
  subject: string;
  body: string;
  files: string[];
}

export interface SplitResult {
  commits: SplitCommit[];
}

export function buildSplitPrompt(input: SplitPromptInput): string {
  const style = input.style || "conventional";
  let styleInstruction = "- format: Conventional Commits with a type (and optional scope): e.g. feat: ..., fix: ..., refactor: ..., docs: ...";
  if (style === "gitmoji") {
    styleInstruction = "- format: Use an appropriate gitmoji at the beginning of the subject (e.g. :sparkles: feat: ..., :bug: fix: ...)";
  } else if (style === "concise") {
    styleInstruction = "- format: Short, clean imperative sentence without prefix (e.g. Add user authentication)";
  }

  const fileNames = input.stagedFiles.map((f) => f.path);

  return [
    "You are a senior engineer splitting a large staged changeset into focused, logical commits.",
    "Return a JSON object strictly in this format, with no markdown fences and no other text:",
    JSON.stringify({
      commits: [
        { subject: "feat: add login form", body: "- add LoginForm component\n- wire up auth context", files: ["src/Login.tsx", "src/auth.ts"] },
      ],
    }),
    "",
    "Rules:",
    "- every staged file must appear in exactly one commit's `files` array",
    "- group files that serve the same purpose together; separate unrelated concerns into different commits",
    "- if all files belong to one concern, return a single commit with all files",
    "- subject must be imperative, <= 72 chars, no trailing period",
    styleInstruction,
    "- body is optional bullet points or empty string",
    "- do not invent files that are not in the staged file list",
    "",
    `Staged files (${fileNames.length}):`,
    ...fileNames.map((f) => `- ${f}`),
    "",
    input.diffStat ? `Diff stat:\n${input.diffStat}` : "",
    "Diff:",
    truncateDiff(input.stagedDiff, 60_000),
  ].filter(Boolean).join("\n");
}

export interface IssueFromDiffPromptInput {
  diff: string;
  diffStat?: string;
  branch?: string;
  notes?: string;
}

export interface IssueFromDiffResult {
  title: string;
  body: string;
}

export function buildIssueFromDiffPrompt(input: IssueFromDiffPromptInput): string {
  const parts = [
    "You are a senior engineer writing a GitHub issue from an uncommitted diff.",
    "Return a JSON object strictly in this format, with no markdown fences and no other text:",
    JSON.stringify({
      title: "Short imperative title describing the change or problem",
      body: "## Description\n\nOne paragraph explaining what and why.\n\n## Changes\n\n- bullet list of key changes",
    }),
    "",
    "Rules:",
    "- title must be <= 72 chars, imperative, no trailing period",
    "- body should use Markdown with a '## Description' section and a '## Changes' section with bullets",
    "- describe what the diff does and why it is needed, not line-by-line",
    "- do not invent specifics that are not in the diff",
    "- keep the body concise and skimmable",
  ];
  if (input.branch) parts.push("", `Branch: ${input.branch}`);
  if (input.notes && input.notes.trim()) {
    parts.push("", "Notes from the developer:", input.notes.trim());
  }
  parts.push("", input.diffStat ? `Diff stat:\n${input.diffStat}` : "", "Diff:", truncateDiff(input.diff, 60_000));
  return parts.filter(Boolean).join("\n");
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

function stripTrailingCommasInJson(text: string): string {
  const parts: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    // Loop bounds guarantee a character; charAt keeps the type honest
    // where indexing would widen to string|undefined.
    const char = text.charAt(i);
    if (escape) {
      escape = false;
      parts.push(char);
      continue;
    }
    if (char === "\\") {
      escape = true;
      parts.push(char);
      continue;
    }
    if (char === '"') {
      inString = !inString;
      parts.push(char);
      continue;
    }
    if (!inString && char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      if (text.charAt(j) === "}" || text.charAt(j) === "]") {
        continue;
      }
    }
    parts.push(char);
  }

  return parts.join("");
}

/**
 * Resiliently parses raw JSON output from an LLM, handling markdown code fences,
 * conversational preambles/postambles, trailing commas, and nested brackets.
 */
export function parseJsonResponse<T>(raw: string, fallback: T): T {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  // 1. Isolate markdown code fence if present
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fenced = fenceMatch?.[1];
  const candidate = fenced !== undefined ? fenced.trim() : trimmed;

  // 2. Try direct parse first
  try {
    const cleaned = stripTrailingCommasInJson(candidate);
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
              const cleaned = stripTrailingCommasInJson(jsonSubstring);
              return JSON.parse(cleaned) as T;
            } catch {
              // Continue to regex fallback below
            }
          }
        }
      }
    }
  }

  return fallback;
}
