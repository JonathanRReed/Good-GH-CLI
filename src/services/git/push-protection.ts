/**
 * GitHub secret-scanning push protection: recognises the remote's rejection
 * and extracts what it reports.
 *
 * GitHub's wording and layout change over time (GH009, GH013 rule
 * violations, AI-detected generic secrets), so parsing is best effort. A
 * rejection that is recognised but not parsed still classifies, and the raw
 * remote lines are always kept.
 */

import { safeHumanText } from "../../utils/output.ts";

export interface PushProtectionFinding {
  secretType?: string;
  commit?: string;
  path?: string;
  line?: number;
}

export interface PushProtectionDetails {
  findings: PushProtectionFinding[];
  /** GitHub bypass/unblock pages. A person's decision, never a default next step. */
  bypassUrls: string[];
  /** Remote lines as GitHub sent them, without the `remote:` prefix. */
  remoteLines: string[];
}

const SIGNALS = [/push cannot contain secrets/i, /GH009\b.*secret/i, /secret[- ]scanning/i, /push[- ]protection/i];
const MAX_REMOTE_LINES = 200;

function remoteLines(stderr: string): string[] {
  const lines: string[] = [];
  for (const line of stderr.split(/\r\n|\n|\r/)) {
    // Remote text has no authority over the terminal or the JSON consumer.
    const match = /^remote:\s?(.*)$/.exec(safeHumanText(line));
    if (match) lines.push((match[1] ?? "").trimEnd());
  }
  return lines;
}

const signalled = (lines: string[]): boolean => lines.some((line) => SIGNALS.some((signal) => signal.test(line)));

/** Only `remote:` lines count: a local hook cannot impersonate GitHub's verdict. */
export function isPushProtectionRejection(stderr: string): boolean {
  return signalled(remoteLines(stderr));
}

export function parsePushProtection(stderr: string): PushProtectionDetails | undefined {
  const lines = remoteLines(stderr);
  if (!signalled(lines)) return undefined;
  const findings: PushProtectionFinding[] = [];
  const bypassUrls: string[] = [];
  let secretType: string | undefined;
  let current: PushProtectionFinding | undefined;
  let bypassNext = false;
  const start = (seed: PushProtectionFinding = {}): PushProtectionFinding => {
    const finding: PushProtectionFinding = { ...(secretType ? { secretType } : {}), ...seed };
    findings.push(finding);
    return finding;
  };

  for (const raw of lines) {
    const text = raw.trim();
    // "—— GitHub Personal Access Token ——————" opens a block for one secret type.
    const header = /^[—–-]{2,}\s*([^—–\s](?:.*[^—–\s])?)\s*[—–-]{2,}$/.exec(text);
    if (header?.[1]) {
      secretType = header[1];
      current = undefined;
      bypassNext = false;
      continue;
    }
    const field = /^(?:-\s*)?(commit|path|line|secret type)\s*:\s*(\S.*)$/i.exec(text);
    if (field?.[1] && field[2]) {
      const key = field[1].toLowerCase();
      const value = field[2].trim();
      if (key === "commit") {
        current = /^[0-9a-f]{7,64}$/i.test(value) ? start({ commit: value }) : undefined;
      } else if (key === "path") {
        if (!current || current.path !== undefined) current = start(current?.commit ? { commit: current.commit } : {});
        const located = /^(.*\S):(\d+)$/.exec(value);
        const line = located?.[2] ? Number(located[2]) : undefined;
        current.path = located?.[1] ?? value;
        if (line !== undefined && Number.isSafeInteger(line) && line > 0) current.line = line;
      } else if (key === "line") {
        current ??= start();
        const line = Number.parseInt(value, 10);
        if (Number.isSafeInteger(line) && line > 0) current.line = line;
      } else {
        current ??= start();
        current.secretType = value;
      }
      continue;
    }
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    for (const url of urls) {
      if ((bypassNext || /unblock-secret|\/bypass/i.test(url)) && !bypassUrls.includes(url)) bypassUrls.push(url);
    }
    // "follow this URL to allow the secret." precedes the URL on its own line.
    if (urls.length) bypassNext = false;
    else if (/allow the secret|bypass/i.test(text)) bypassNext = true;
    else if (text) bypassNext = false;
  }

  return { findings: findings.filter((finding) => Object.keys(finding).length > 0), bypassUrls, remoteLines: lines.slice(0, MAX_REMOTE_LINES) };
}

function describeFinding(finding: PushProtectionFinding): string {
  const where = finding.path ? `${finding.path}${finding.line !== undefined ? `:${finding.line}` : ""}` : undefined;
  return [finding.secretType ?? "Secret", where ? `at ${where}` : undefined, finding.commit ? `in commit ${finding.commit.slice(0, 12)}` : undefined]
    .filter(Boolean)
    .join(" ");
}

export function pushProtectionMessage(details: PushProtectionDetails): string {
  const found = details.findings.length
    ? details.findings.map((finding) => `  - ${describeFinding(finding)}`).join("\n")
    : "  GitHub did not report the locations in a recognised format; read its remote output.";
  return [
    "Push blocked by GitHub push protection: a secret was detected in the commits being pushed. The remote branch was not updated.",
    found,
    "Next steps:",
    "  1. Remove the secret from every listed commit. Those commits are unpublished, so rewrite them: edit the file and run `git commit --amend` when it is in the latest commit, or `git rebase -i <commit>~1` and mark each listed commit `edit`.",
    "  2. Rotate the secret if it is real. It is in local history and may have been copied elsewhere.",
    "  3. Push again once no commit in the push contains it. Retrying the same commits will be blocked again.",
  ].join("\n");
}

/** Human-only note. Bypassing is a person's judgement call, not a fix. */
export function pushProtectionBypassNote(details: PushProtectionDetails): string | undefined {
  if (!details.bypassUrls.length) return undefined;
  return `If a person decides this is a false positive or an accepted risk, GitHub offers a bypass page. That is their decision, not a next step:\n${details.bypassUrls.map((url) => `  ${url}`).join("\n")}`;
}

export class PushProtectionError extends Error {
  readonly details: PushProtectionDetails;

  constructor(details: PushProtectionDetails, options?: { cause?: unknown }) {
    super(pushProtectionMessage(details), options);
    this.name = "PushProtectionError";
    this.details = details;
  }
}
