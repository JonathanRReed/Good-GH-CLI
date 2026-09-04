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
  /go\.sum$/,
  /uv\.lock$/,
  /Pipfile\.lock$/,
  /flake\.lock$/,
  /deno\.lock$/,
  /mix\.lock$/,
  /packages\.lock\.json$/,
  // Environment & Sensitive files
  /\.env(\.[a-zA-Z0-9_-]+)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|mobileprovision|asc|gpg|kdbx|ppk|crt|cer|der)$/i,
  /credentials(\.json)?$/i,
  /secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /\.(npmrc|pypirc|netrc|htpasswd|git-credentials)$/i,
  /(^|\/)kubeconfig(\.ya?ml)?$/i,
  /\.aws\/credentials$/i,
  /terraform\.tfvars$/i,
  /\.tfstate(\.backup)?$/i,
  // Source maps & minified bundles
  /\.map$/,
  /\.(min|bundle)\.(js|css)$/,
  // Binary files & media
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svgz|pdf|wasm|exe|dll|dylib|so|a|o|class|jar|zip|tar|gz|tgz|bz2|xz|zst|7z|rar|mp[34]|mov|webm|woff2?|ttf|otf|eot|sqlite|db|bin|dat)$/i,
];

const SECRET_PATTERNS = [
  /sk-(?:ant-|proj-|live-|test-)?[a-zA-Z0-9_-]{20,}/g, // OpenAI / Anthropic style API keys
  /\b[sr]k_(?:live|test)_[a-zA-Z0-9]{16,}/g, // Stripe secret / restricted keys
  /\bwhsec_[a-zA-Z0-9]{20,}/g, // Stripe webhook secrets
  /gh[pousr]_[a-zA-Z0-9]{36,}/g, // GitHub tokens
  /github_pat_[a-zA-Z0-9_]{20,}/g, // GitHub fine-grained PATs
  /xai-[a-zA-Z0-9_-]{20,}/g, // xAI tokens
  /xox[baprse]-[a-zA-Z0-9-]{10,}/g, // Slack tokens
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, // Slack webhooks
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{20,}/g, // Discord webhooks
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
  /\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi, // AWS secret keys
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{30,}/g, // Google OAuth access tokens
  /\bglpat-[a-zA-Z0-9_-]{20,}/g, // GitLab PATs
  /\bnpm_[a-zA-Z0-9]{36}/g, // npm automation tokens
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g, // PyPI tokens
  /\bdapi[a-f0-9]{32}\b/g, // Databricks
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g, // Shopify
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, // SendGrid
  /\bkey-[a-f0-9]{32}\b/g, // Mailgun
  /\bSK[a-f0-9]{32}\b/g, // Twilio
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bdop_v1_[a-f0-9]{64}/g, // DigitalOcean
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, // Authorization headers
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|ftp|sftp|smtps?):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, // URLs with credentials
  /https?:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, // credentialed HTTP URLs
  // Quoted assignments: API_KEY: "value"
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  // Bare assignments, which quoted-only matching missed: API_KEY=value, export TOKEN=value
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s"'`,;)}\]]{8,}/gi,
];

const PRIVATE_KEY_BEGIN = "-----BEGIN ";

function privateKeyEndMarkerAt(text: string, begin: number): string | null {
  const labelStart = begin + PRIVATE_KEY_BEGIN.length;
  const limit = Math.min(text.length, labelStart + 80);
  let labelEnd = -1;

  for (let i = labelStart; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) break;
    if (text.startsWith("-----", i)) {
      labelEnd = i;
      break;
    }
  }
  if (labelEnd < 0) return null;

  const label = text.slice(labelStart, labelEnd);
  const namesPrivateKey =
    label === "PRIVATE KEY" || label.endsWith(" PRIVATE KEY") || label.endsWith(" PRIVATE KEY BLOCK");
  if (!namesPrivateKey) return null;

  for (const char of label) {
    const code = char.charCodeAt(0);
    const allowed = code === 32 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
    if (!allowed) return null;
  }
  return `-----END ${label}-----`;
}

function redactPrivateKeyBlocks(text: string): { text: string; redactedCount: number } {
  let output = "";
  let emitFrom = 0;
  let searchFrom = 0;
  let redactedCount = 0;

  while (searchFrom < text.length) {
    const begin = text.indexOf(PRIVATE_KEY_BEGIN, searchFrom);
    if (begin < 0) break;

    const endMarker = privateKeyEndMarkerAt(text, begin);
    if (!endMarker) {
      searchFrom = begin + PRIVATE_KEY_BEGIN.length;
      continue;
    }

    const end = text.indexOf(endMarker, begin + PRIVATE_KEY_BEGIN.length);
    output += text.slice(emitFrom, begin) + "[REDACTED_SECRET]";
    redactedCount++;

    if (end < 0) {
      emitFrom = text.length;
      break;
    }
    emitFrom = end + endMarker.length;
    searchFrom = emitFrom;
  }

  return {
    text: output + text.slice(emitFrom),
    redactedCount,
  };
}

export function isIgnoredDiffFile(filePath: string): boolean {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Scans text and redacts sensitive tokens and private keys with [REDACTED_SECRET].
 */
export function redactSecrets(text: string): { text: string; redactedCount: number } {
  const privateKeys = redactPrivateKeyBlocks(text);
  let redacted = privateKeys.text;
  let count = privateKeys.redactedCount;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      count++;
      // Keep the key of a `KEY=value` / `key: value` assignment so the model
      // still knows what was configured, just not the value.
      const assignment = match.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*/);
      if (assignment && !/^[a-z+]+:\/\//i.test(match)) {
        return `${assignment[1]}="[REDACTED_SECRET]"`;
      }
      return "[REDACTED_SECRET]";
    });
  }

  return { text: redacted, redactedCount: count };
}

export interface SanitizedText {
  text: string;
  redactedCount: number;
}

/**
 * The single gate for free text that is about to leave the machine: CI logs,
 * issue bodies, task descriptions, commit history. Redacts secrets and caps the
 * size so one noisy log cannot blow a context window.
 */
export function sanitizeForAI(raw: string, maxChars = 40_000): SanitizedText {
  if (!raw) return { text: "", redactedCount: 0 };
  const { text, redactedCount } = redactSecrets(raw);
  return { text: truncateDiff(text, maxChars), redactedCount };
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
    // Groups always participate when the overall match succeeds.
    const pathA = match[1] ?? "";
    const pathB = match[2] ?? "";
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
        currentFile = match[2] ?? "";
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
