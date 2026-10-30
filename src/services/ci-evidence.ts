import { stripVTControlCharacters } from "node:util";

export interface EvidenceLine { line: number; text: string }
export interface Truncation { bytesTotal: number; bytesShown: number }

const errorPattern = /\b(?:error|fail(?:ed|ure)?|assert(?:ion)?|exception|fatal|panic)\b|\w*Error\b|\bTS\d{4,}\b|\bat\s+.+:\d+|\.[a-z]+:\d+(?::\d+)?/i;
const summaryPattern = /see\b.+\bstep\b|\bstep\b.+\b(?:details|logs?)\b|process completed with exit code|error command failed|ELIFECYCLE|\b(?:tests?|fixtures?|checks?) (?:have )?failed|\d+ failed|failed to render|^[\w &-]+: (?:failure|failed)\b|['"]failure['"] !=/i;

/** Keep the source line number, but remove gh's repeated job/step/timestamp prefix. */
export function logLines(log: string): EvidenceLine[] {
  return log.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text: stripVTControlCharacters(text).replace(/\^\[\[[0-9;]*m/g, "").replace(/^[^\t]*\t[^\t]*\t/, "")
      .replace(/^\uFEFF?\d{4}-\d\d-\d\dT\S+\s?/, ""),
  }));
}

export function needsFullJobLog(log: string): boolean {
  const lines = logLines(log).map(line => line.text);
  const errors = lines.filter(line => errorPattern.test(line) && !/^(?:##\[group\]Run |echo |if |['"](?:success|failure))/.test(line.trimStart()));
  return lines.join("\n").trim().length < 120 || errors.length === 0 ||
    errors.every(line => summaryPattern.test(line)) ||
    lines.some(line => /see\b.+\bstep\b|refer to\b.+\bstep\b/i.test(line));
}

/** Ignore source positions and repeated prefixes when comparing failures across jobs. */
export function evidenceSignature(log: string): string {
  const errors = [...new Set(logLines(log).filter(line => errorPattern.test(line.text)).map(line => line.text.trim()))].sort();
  return errors.length ? JSON.stringify(errors) : "";
}

/** Match first, add context second, then spend the byte budget on matches before context. */
export function extractEvidence(log: string, maxBytes: number, context: number): { evidence: EvidenceLine[]; truncated: Truncation } {
  const lines = logLines(log);
  const matches = lines.filter(line => errorPattern.test(line.text));
  const candidates = matches.length ? matches : lines.filter(line => line.text.trim());
  const selected = new Map<number, EvidenceLine>();
  const seen = new Set<string>();
  let bytesShown = 0;
  let budgetUsed = 2;
  const add = (line: EvidenceLine) => {
    if (seen.has(line.text) || !line.text.trim()) return;
    const bytes = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (budgetUsed + bytes > maxBytes) return;
    selected.set(line.line, line);
    seen.add(line.text);
    budgetUsed += bytes;
    bytesShown += Buffer.byteLength(line.text);
  };
  for (const line of candidates) add(line);
  for (const line of candidates) {
    for (let i = Math.max(0, line.line - 1 - context); i < Math.min(lines.length, line.line + context); i++) {
      const neighbor = lines[i];
      if (neighbor) add(neighbor);
    }
  }
  return {
    evidence: [...selected.values()].sort((a, b) => a.line - b.line),
    truncated: { bytesTotal: Buffer.byteLength(log), bytesShown },
  };
}
