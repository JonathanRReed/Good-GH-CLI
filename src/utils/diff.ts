export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";
  staged: boolean;
}

const IGNORED_FILE_PATTERNS = [
  // Lockfiles
  /bun\.lockb?$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  // Environment & Sensitive files
  /\.env(\.[a-zA-Z0-9_-]+)?$/i,
  /id_rsa/i,
  /\.(pem|key)$/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml)$/i,
  // Source maps & minified bundles
  /\.map$/,
  /\.(min|bundle)\.(js|css)$/,
  // Binary files & media
  /\.(png|jpe?g|gif|webp|ico|pdf|wasm|exe|dll|dylib|so|zip|tar|gz|7z)$/i,
];

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI / Anthropic style API keys
  /gh[pousr]_[a-zA-Z0-9]{36,}/g, // GitHub tokens
  /github_pat_[a-zA-Z0-9_]{20,}/g, // GitHub fine-grained PATs
  /xai-[a-zA-Z0-9_-]{20,}/g, // xAI tokens
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bglpat-[a-zA-Z0-9_-]{20,}/g, // GitLab PATs
  /\bnpm_[a-zA-Z0-9]{36}/g, // npm automation tokens
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s]+/gi, // DB URLs with credentials
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  // Quoted assignments: API_KEY: "value"
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  // Bare assignments, which quoted-only matching missed: API_KEY=value, export TOKEN=value
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s"'`,;)}\]]{8,}/gi,
];

export function isIgnoredDiffFile(filePath: string): boolean {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Scans text and redacts sensitive tokens and private keys with [REDACTED_SECRET].
 */
export function redactSecrets(text: string): { text: string; redactedCount: number } {
  let redacted = text;
  let count = 0;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      count++;
      if (match.includes(":") || match.includes("=")) {
        const prefix = match.split(/[:=]/)[0];
        return `${prefix}="[REDACTED_SECRET]"`;
      }
      return "[REDACTED_SECRET]";
    });
  }

  return { text: redacted, redactedCount: count };
}

export interface SanitizedDiff {
  /** Diff text safe to send to an AI provider. */
  diff: string;
  /** Number of secret-looking tokens replaced with [REDACTED_SECRET]. */
  redactedCount: number;
  /** Number of diff blocks dropped as lockfiles, binaries, or sensitive files. */
  strippedBlocks: number;
}

/**
 * Single sanitisation pass over a raw diff: drops lockfile, binary, bundle, and
 * sensitive-file blocks, then redacts any secrets left in the remaining hunks.
 */
export function sanitizeDiffForAI(rawDiff: string): SanitizedDiff {
  if (!rawDiff) return { diff: "", redactedCount: 0, strippedBlocks: 0 };

  const diffBlocks = rawDiff.split(/(?=^diff --git )/m);
  const filteredBlocks = diffBlocks.filter((block) => {
    // Check if binary file marker is present
    if (block.includes("Binary files ") || block.includes("GIT binary patch")) {
      return false;
    }

    const match = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!match) return true;
    const pathA = match[1];
    const pathB = match[2];
    return !isIgnoredDiffFile(pathA) && !isIgnoredDiffFile(pathB);
  });

  const joined = filteredBlocks.join("").trim();
  const { text, redactedCount } = redactSecrets(joined);
  return {
    diff: text,
    redactedCount,
    strippedBlocks: diffBlocks.length - filteredBlocks.length,
  };
}

/**
 * Strips diff sections that belong to lockfiles, binary files, minified bundles, or sensitive files,
 * and redacts any detected secrets.
 */
export function stripLockfilesFromDiff(rawDiff: string): string {
  return sanitizeDiffForAI(rawDiff).diff;
}

/**
 * Caps the patch so a large change still fits in a model's context window.
 */
export function truncateDiff(diffText: string, maxChars = 40_000): string {
  if (!diffText) return "";
  if (diffText.length <= maxChars) {
    return diffText;
  }

  const truncated = diffText.slice(0, maxChars);
  return `${truncated}\n\n[Diff truncated: exceeded ${maxChars} characters]`;
}

/**
 * Summarises changed files as a compact list, capped so it cannot crowd out the diff.
 */
export function formatStagedSummary(files: ChangedFile[], maxChars = 6_000): string {
  if (files.length === 0) return "No files staged.";

  const lines = files.map((f) => `- ${f.path} (${f.status})`);
  const joined = lines.join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }

  return `${joined.slice(0, maxChars)}\n...[File list truncated]`;
}

export interface HygieneIssue {
  type: "console" | "debugger" | "localhost";
  file: string;
  line: string;
  message: string;
}

/**
 * Scans unified diff for common development artifacts (console.log, debugger, localhost URLs).
 */
export function scanCodeHygiene(rawDiff: string): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const lines = rawDiff.split("\n");
  let currentFile = "";

  for (const line of lines) {
    if (line.startsWith("diff --git a/") && line.includes(" b/")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
      }
      continue;
    }

    // Only inspect added lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedText = line.slice(1);

      // Check console.log or debugger in JS/TS files
      if (/\.(jsx?|tsx?|mjs|cjs)$/.test(currentFile)) {
        if (/console\.(log|debug|info|warn|error)\s*\(/.test(addedText)) {
          issues.push({
            type: "console",
            file: currentFile,
            line: addedText.trim(),
            message: `console call in ${currentFile}`,
          });
        }
        if (/\bdebugger\s*;?/.test(addedText)) {
          issues.push({
            type: "debugger",
            file: currentFile,
            line: addedText.trim(),
            message: `debugger statement in ${currentFile}`,
          });
        }
      }

      // Check localhost or 127.0.0.1
      if (/(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/i.test(addedText)) {
        issues.push({
          type: "localhost",
          file: currentFile,
          line: addedText.trim(),
          message: `hardcoded local URL in ${currentFile}`,
        });
      }
    }
  }

  return issues;
}
