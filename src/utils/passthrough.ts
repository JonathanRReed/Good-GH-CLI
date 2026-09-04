import type { Command } from "commander";

/**
 * git commands whose names `ggh` also uses. `ggh log` is ggh's graph view, but
 * `ggh log --oneline -5` is muscle memory for git, and refusing it would make
 * `alias git=ggh` unusable. When such a command is given flags or positionals
 * ggh does not define, the whole invocation is git's.
 */
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

/**
 * Subcommand words git gives these commands. `ggh stash <message>` is legal, so
 * `ggh stash push` would otherwise stash with the message "push".
 */
const GIT_SUBCOMMANDS: Record<string, Set<string>> = {
  stash: new Set(["show", "apply", "branch", "clear", "create", "store"]),
  worktree: new Set(["prune", "move", "lock", "unlock", "repair"]),
  remote: new Set(["add", "rename", "remove", "rm", "set-url", "get-url", "show", "prune", "update"]),
};

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

function optionNames(command: Command): Set<string> {
  const names = new Set<string>();
  for (const option of command.options) {
    if (option.short) names.add(option.short);
    if (option.long) names.add(option.long);
    // commander accepts `--no-x` for a boolean `--x`, and `--flag=value`.
    if (option.long && option.negate === false) names.add(option.long.replace(/^--/, "--no-"));
  }
  names.add("-h");
  names.add("--help");
  return names;
}

/** Positional arguments the command (or the matched subcommand) declares. */
function positionalArity(command: Command): number {
  return command.registeredArguments.length;
}

export interface ForwardDecision {
  forward: boolean;
  reason?: string;
}

/**
 * Decides whether `ggh <args>` should be handed to git verbatim. Cases:
 *   - `ggh git ...` or `ggh -- ...`: always, explicitly.
 *   - first word is not a ggh command: yes (existing behaviour).
 *   - first word is both a ggh command and a git command, and any flag or
 *     positional is one ggh does not define: yes.
 *   - otherwise: ggh handles it.
 */
export function decideGitForward(program: Command, args: string[]): ForwardDecision {
  const [first, ...rest] = args;
  if (!first) return { forward: false };
  if (first === "git" || first === "--") return { forward: true, reason: "explicit" };
  if (first.startsWith("-") || first === "help") return { forward: false };

  const command = findCommand(program, first);
  if (!command) return { forward: true, reason: "unknown command" };
  // Only the word actually typed matters: `ggh prune` is git's, `ggh sync` is ours.
  if (!GIT_COMMANDS.has(first)) return { forward: false };

  // `ggh checkout -- path` or `ggh log -- path`: git's own separator.
  if (rest.includes("--")) return { forward: true, reason: "'--' is git's path separator" };

  const subcommands = command.commands;
  let target = command;
  let positionals = 0;
  const knownOptions = optionNames(command);

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    // Unreachable: the loop condition bounds i. Break (not continue) so a
    // hypothetical hole ends parsing instead of skipping silently.
    if (arg === undefined) break;
    if (arg.startsWith("-")) {
      const bare = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      // Clustered short flags (`-am`) and attached values (`-n5`) are legal for
      // both tools; treat them as known when the first letter is ours.
      const probe = /^-[^-]/.test(bare) && bare.length > 2 ? bare.slice(0, 2) : bare;
      if (!knownOptions.has(probe)) return { forward: true, reason: `${bare} is not a ggh flag` };
      const option = target.options.find((o) => o.short === probe || o.long === probe);
      // A ggh option that takes a value consumes the next word.
      if (option && (option.required || option.optional) && !arg.includes("=") && probe === bare) i++;
      continue;
    }

    if (target === command && subcommands.length > 0 && positionals === 0) {
      const sub = subcommands.find((c) => c.name() === arg || c.aliases().includes(arg));
      if (sub) {
        target = sub;
        for (const name of optionNames(sub)) knownOptions.add(name);
        continue;
      }
      if (GIT_SUBCOMMANDS[first]?.has(arg)) {
        return { forward: true, reason: `'${arg}' is a git ${first} subcommand ggh does not define` };
      }
      if (positionalArity(command) === 0) {
        return { forward: true, reason: `'${arg}' is not a ggh ${first} subcommand` };
      }
    }

    positionals++;
    if (positionals > positionalArity(target) && !target.registeredArguments.some((a) => a.variadic)) {
      return { forward: true, reason: `ggh ${first} does not take '${arg}'` };
    }
  }

  return { forward: false };
}
