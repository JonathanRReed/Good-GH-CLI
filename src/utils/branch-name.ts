/**
 * Branch-name rules from git-check-ref-format(1), applied before a name reaches
 * `git checkout -b`, `git worktree add -b`, or `git branch -m`. A name with a
 * space would otherwise be split into a branch and a start-point; a leading
 * dash would be read as a flag.
 */
export function validateBranchName(name: string): string | undefined {
  if (!name || !name.trim()) return "Branch name is required.";
  if (name !== name.trim()) return "Branch name cannot start or end with whitespace.";
  if (/\s/.test(name)) return "Branch name cannot contain spaces.";
  if (name.startsWith("-")) return "Branch name cannot start with '-'.";
  if (name === "HEAD" || name === "@") return `'${name}' is reserved by git.`;
  // eslint-disable-next-line no-control-regex -- git forbids control characters in refs
  if (/[\x00-\x1f\x7f~^:?*[\\]/.test(name)) return "Branch name contains characters git rejects (~ ^ : ? * [ \\ or control characters).";
  if (name.startsWith("/") || name.endsWith("/")) return "Branch name cannot start or end with '/'.";
  if (name.endsWith(".") || name.endsWith(".lock")) return "Branch name cannot end with '.' or '.lock'.";
  if (name.includes("//") || name.includes("..") || name.includes("@{")) return "Branch name cannot contain '//', '..', or '@{'.";
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return "No path component may start with '.' or end with '.lock'.";
  }
  return undefined;
}

function isValidBranchName(name: string): boolean {
  return validateBranchName(name) === undefined;
}

/**
 * Coerces free text (a task description, an AI suggestion) into a legal branch
 * name. Returns an empty string when nothing usable is left, so callers can fail
 * loudly instead of creating `-` or `.`.
 */
export function sanitizeBranchName(raw: string, maxLength = 60): string {
  let name = raw
    .split("\n")[0]
    ?.replace(/[`'"]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9/._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/(^|\/)[-.]+/g, "$1")
    .replace(/[-./]+$/g, "")
    .replace(/\.lock$/g, "") ?? "";

  if (name.length > maxLength) {
    name = name.slice(0, maxLength).replace(/[-./]+$/g, "");
  }
  return isValidBranchName(name) ? name : "";
}

/** Turns a validated branch name into one safe, readable directory segment. */
export function branchToWorktreeDirectoryName(branch: string): string {
  let output = "";
  let pendingHyphen = false;

  for (const char of branch) {
    const code = char.charCodeAt(0);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (isLetter || isDigit || char === "_") {
      if (pendingHyphen && output) output += "-";
      output += char;
      pendingHyphen = false;
    } else {
      pendingHyphen = true;
    }
  }

  return output;
}
