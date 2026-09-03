import type { Command } from "commander";
import { getFlags, setFlags } from "../services/runtime.ts";
import { p, pc } from "./ui.ts";

/** Commands that can emit structured data instead of a rendered view. */
export const JSON_CAPABLE = new Set([
  "status", "pr", "checks", "log", "stash", "worktree", "config",
  "release", "issue", "run", "repo", "stack", "sync",
]);

/** Commands that change the repository or the remote and deserve a preview. */
export const DRY_RUN_CAPABLE = new Set([
  "commit", "discard", "sync", "squash", "undo", "worktree", "release",
  "rename", "stash", "pr", "issue", "stack", "repo",
]);

/** Commands that act on GitHub and can therefore target another repository. */
export const REPO_SCOPED = new Set([
  "pr", "checks", "release", "issue", "run", "repo", "api", "stack",
]);

/**
 * Adds an option only when neither its long nor its short form is already taken.
 * `ggh commit` owns `-n` for --no-verify, so the shared flags must never assume
 * a short form is free.
 */
function addSafe(command: Command, flags: string, description: string): void {
  const taken = new Set<string>();
  for (const existing of command.options) {
    if (existing.short) taken.add(existing.short);
    if (existing.long) taken.add(existing.long);
  }
  const wanted = flags.split(/[ ,|]+/).filter((f) => f.startsWith("-"));
  if (wanted.some((f) => taken.has(f))) return;
  command.option(flags, description);
}

function decorate(command: Command, domain: string): void {
  addSafe(command, "-q, --quiet", "Suppress progress output; errors are still shown");
  addSafe(command, "--no-input", "Never prompt; fail with instructions instead");

  if (JSON_CAPABLE.has(domain)) {
    addSafe(command, "--json", "Output machine-readable JSON on stdout");
  }
  if (DRY_RUN_CAPABLE.has(domain)) {
    // No short form: `-n` is already --no-verify on commit.
    addSafe(command, "--dry-run", "Show what would happen without changing anything");
  }
  if (REPO_SCOPED.has(domain)) {
    addSafe(command, "-R, --repo <owner/name>", "Act on another repository instead of the current one");
  }
}

/**
 * Adds the cross-cutting flags to every command, then records the values into
 * the runtime store before the action runs. Doing it per-command (rather than
 * only on the program) means `ggh pr --json` works, which is where people
 * actually put the flag.
 */
export function applyGlobalFlags(program: Command): void {
  for (const command of program.commands) {
    const domain = command.name();
    decorate(command, domain);
    // Subcommands inherit the same surface (e.g. `ggh pr create --json`).
    for (const sub of command.commands) {
      decorate(sub, domain);
    }
  }

  program.hook("preAction", (_thisCommand, actionCommand) => {
    const opts = actionCommand.opts();
    const parentOpts = actionCommand.parent?.opts() ?? {};
    const pick = <T>(key: string): T | undefined =>
      (opts[key] !== undefined ? opts[key] : parentOpts[key]) as T | undefined;

    setFlags({
      json: pick<boolean>("json") === true,
      quiet: pick<boolean>("quiet") === true,
      // commander maps `--no-input` to `input: false`
      noInput: pick<boolean>("input") === false,
      dryRun: pick<boolean>("dryRun") === true,
      repo: pick<string>("repo"),
    });
  });
}

/**
 * Announces an action that was skipped because of --dry-run.
 * Returns true when the caller should stop before mutating anything.
 */
export function dryRun(description: string): boolean {
  if (!getFlags().dryRun) return false;
  p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would ${description}`);
  return true;
}

/** True when the run must not change anything. */
export function isDryRun(): boolean {
  return getFlags().dryRun;
}
