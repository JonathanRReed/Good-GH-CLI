import type { Command } from "commander";
import { getFlags, setFlags, setAIExplicitlyDisabled, beginCommandOutput, recordPreview, setCommandPath } from "../services/runtime.ts";
import { getConfig } from "../services/config.ts";
import { p, pc } from "./ui.ts";

/** Commands that can emit structured data instead of a rendered view. */
export const JSON_CAPABLE = new Set([
  "tidy", "lost", "projects", "go", "clone", "commit", "operation", "review",
  "status", "pr", "checks", "ci", "log", "stash", "worktree", "config",
  "release", "issue", "run", "repo", "stack", "sync", "changelog", "api",
  "workflow", "label", "gist", "search", "secret", "variable", "notifications",
  "squash", "undo", "rename", "resolve", "discard", "switch", "triage",
  "draft", "ignore", "alias", "hook", "team", "plugin",
]);

export const AGENT_CAPABLE = new Set([...JSON_CAPABLE, "agent"]);

/** Commands that change the repository or the remote and deserve a preview. */
export const DRY_RUN_CAPABLE = new Set([
  "tidy", "operation", "review",
  "commit", "discard", "sync", "squash", "undo", "worktree", "release",
  "rename", "stash", "pr", "issue", "stack", "repo", "changelog", "workflow",
  "label", "gist", "secret", "variable", "notifications",
  "run", "switch", "clone", "resolve", "checks", "search", "status", "triage",
  "draft", "hook", "team", "plugin", "alias", "ignore", "api", "config",
]);

/** Commands that act on GitHub and can therefore target another repository. */
export const REPO_SCOPED = new Set([
  "pr", "checks", "ci", "release", "issue", "run", "repo", "api", "stack",
  "workflow", "label", "secret", "variable", "browse", "triage",
]);
// Note: `triage` honors -R for issues; notifications are account-global and
// ignore it. `changelog` is deliberately excluded: it writes the local
// CHANGELOG.md, so a remote -R target would be misleading.

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
  if (domain === "git" || domain === "gh") return;
  if (AGENT_CAPABLE.has(domain)) addSafe(command, "--agent", "Emit the versioned agent envelope without prompting");
  addSafe(command, "-q, --quiet", "Suppress progress output; errors are still shown");
  addSafe(command, "--no-input", "Never prompt; fail with instructions instead");
  if (["tidy", "commit", "pr", "issue", "worktree", "squash", "draft", "changelog", "release", "run", "triage"].includes(domain)) {
    addSafe(command, "--ai", "Allow AI generation for this command");
    addSafe(command, "--no-ai", "Disable AI generation for this command");
  }

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
    const commands = [command];
    for (const child of commands) { decorate(child, domain); commands.push(...child.commands); }
  }

  program.hook("preAction", (_thisCommand, actionCommand) => {
    beginCommandOutput();
    const names: string[] = [];
    for (let current: Command | null = actionCommand; current?.parent; current = current.parent) names.unshift(current.name());
    setCommandPath(names);
    const parent = actionCommand.parent;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
      for (const [key, value] of Object.entries(ancestor.opts())) {
        const parentSource = ancestor.getOptionValueSource(key);
        const childSource = actionCommand.getOptionValueSource(key);
        if (value !== undefined && parentSource && parentSource !== "default" && childSource !== "cli") {
          actionCommand.setOptionValueWithSource(key, value, parentSource);
        }
      }
    }

    const opts = actionCommand.opts();
    const parentOpts = parent?.opts() ?? {};
    const pick = <T>(key: string): T | undefined =>
      (opts[key] !== undefined ? opts[key] : parentOpts[key]) as T | undefined;

    const aiSource = actionCommand.getOptionValueSource("ai") ?? parent?.getOptionValueSource("ai");
    const aiOption = pick<boolean>("ai");
    const providerSource = actionCommand.getOptionValueSource("provider") ?? parent?.getOptionValueSource("provider");
    const explicitAIRequest = (aiSource === "cli" && aiOption === true) ||
      providerSource === "cli" ||
      (actionCommand.name() === "commit" && pick<boolean>("split") === true) ||
      (actionCommand.name() === "create" && parent?.name() === "issue" && pick<boolean>("fromDiff") === true) ||
      actionCommand.name() === "triage" || (actionCommand.name() === "review" && parent?.name() === "pr");
    const explicitNoAI = (aiSource === "cli" && aiOption === false) ||
      (actionCommand.name() === "commit" && pick<string>("message") !== undefined);
    const agent = getFlags().agent || pick<boolean>("agent") === true;
    setAIExplicitlyDisabled(explicitNoAI);
    setFlags({
      agent,
      json: agent || pick<boolean>("json") === true,
      aiDisabled: explicitNoAI || (!explicitAIRequest && aiSource !== "cli" && !getConfig().ai_enabled),
      quiet: pick<boolean>("quiet") === true,
      // commander maps `--no-input` to `input: false`
      noInput: agent || pick<boolean>("input") === false,
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
  recordPreview(description);
  p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would ${description}`);
  return true;
}

/** True when the run must not change anything. */
export function isDryRun(): boolean {
  return getFlags().dryRun;
}
