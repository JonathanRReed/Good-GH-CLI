export const GIT_COMMANDS = new Set([
  "add", "am", "archive", "bisect", "blame", "branch", "bundle", "checkout", "cherry", "cherry-pick",
  "citool", "clean", "clone", "commit", "config", "describe", "diff", "difftool", "fetch", "format-patch",
  "fsck", "gc", "grep", "gui", "help", "init", "log", "maintenance", "merge", "mergetool", "mv", "notes",
  "pull", "push", "range-diff", "rebase", "reflog", "remote", "repack", "replace", "request-pull", "reset",
  "restore", "revert", "rm", "shortlog", "show", "sparse-checkout", "stash", "status", "submodule",
  "switch", "tag", "whatchanged", "worktree", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file",
  "show-ref", "update-ref", "symbolic-ref", "for-each-ref", "merge-base", "name-rev", "apply", "mailinfo",
  "prune", "count-objects", "verify-commit", "verify-tag", "instaweb", "bugreport", "version",
]);

export function resolvePassthrough(args: string[]): { command: "git" | "gh"; args: string[] } | null {
  const command = args[0] === "--" ? "git" : args[0];
  return command === "git" || command === "gh" ? { command, args: args.slice(1) } : null;
}
