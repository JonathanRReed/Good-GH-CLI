import { Command } from "commander";
import packageJson from "../package.json";
import { registerAliasCommand } from "./commands/alias.ts";
import { registerCloneCommand } from "./commands/clone.ts";
import { registerCommitCommand } from "./commands/commit.ts";
import { registerWorktreeCommand } from "./commands/worktree.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerChecksCommand } from "./commands/checks.ts";
import { registerCompletionCommand } from "./commands/completion.ts";
import { registerDiscardCommand } from "./commands/discard.ts";
import { registerDraftCommand } from "./commands/draft.ts";
import { registerHookCommand } from "./commands/hook.ts";
import { registerIgnoreCommand } from "./commands/ignore.ts";
import { registerLogCommand } from "./commands/log.ts";
import { registerIssueCommand } from "./commands/issue.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerApiCommand } from "./commands/api.ts";
import { registerBrowseCommand } from "./commands/browse.ts";
import { registerGistCommand } from "./commands/gist.ts";
import { registerLabelCommand } from "./commands/label.ts";
import { registerNotificationsCommand } from "./commands/notifications.ts";
import { registerPluginCommand, loadPlugins } from "./commands/plugin.ts";
import { registerRepoCommand } from "./commands/repo.ts";
import { registerSearchCommand } from "./commands/search.ts";
import { registerSecretCommand } from "./commands/secret.ts";
import { registerVariableCommand } from "./commands/variable.ts";
import { registerWorkflowCommand } from "./commands/workflow.ts";
import { registerStackCommand } from "./commands/stack.ts";
import { registerChangelogCommand } from "./commands/changelog.ts";
import { registerPrCommand } from "./commands/pr.ts";
import { registerReleaseCommand } from "./commands/release.ts";
import { registerRenameCommand } from "./commands/rename.ts";
import { registerResolveCommand } from "./commands/resolve.ts";
import { registerSquashCommand } from "./commands/squash.ts";
import { registerStashCommand } from "./commands/stash.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerSwitchCommand } from "./commands/switch.ts";
import { registerSyncCommand } from "./commands/sync.ts";
import { registerTeamCommand } from "./commands/team.ts";
import { registerTriageCommand } from "./commands/triage.ts";
import { registerUndoCommand } from "./commands/undo.ts";
import { gitPassthrough } from "./services/git.ts";
import { run } from "./utils/exec.ts";
import { applyGlobalFlags } from "./utils/flags.ts";
import { GIT_COMMANDS, decideGitForward } from "./utils/passthrough.ts";
import { closestMatch, editDistance } from "./utils/suggest.ts";
import { fail } from "./utils/ui.ts";

/**
 * Top-level command groups for `ggh --help` and the generated man page.
 * A wall of 40 commands says "accumulated"; groups say "designed".
 * Commands without an entry (including community plugins) keep the default group.
 */
export const HELP_GROUPS: Record<string, string> = {
  status: "Status",
  commit: "Daily loop",
  log: "Daily loop",
  switch: "Daily loop",
  stack: "Daily loop",
  worktree: "Daily loop",
  stash: "Daily loop",
  discard: "Daily loop",
  undo: "Daily loop",
  resolve: "Daily loop",
  squash: "Daily loop",
  rename: "Daily loop",
  sync: "Daily loop",
  clone: "GitHub",
  repo: "GitHub",
  pr: "GitHub",
  issue: "GitHub",
  run: "GitHub",
  checks: "GitHub",
  release: "GitHub",
  changelog: "GitHub",
  api: "GitHub",
  workflow: "GitHub",
  label: "GitHub",
  gist: "GitHub",
  search: "GitHub",
  secret: "GitHub",
  variable: "GitHub",
  notifications: "GitHub",
  browse: "GitHub",
  triage: "GitHub",
  draft: "Local workflow",
  ignore: "Local workflow",
  alias: "Local workflow",
  hook: "Local workflow",
  mcp: "Extensions",
  plugin: "Extensions",
  team: "Extensions",
  config: "Setup",
  completion: "Setup",
  };

export async function createProgram(): Promise<Command> {
  const program = new Command();

  program
    .name("ggh")
    .description("Git and GitHub in one CLI: pull requests, issues, CI, stacked branches, and AI")
    .version(packageJson.version);

  // Registration order is the order `ggh --help` prints them, so it runs from
  // "where am I" through the daily loop, then GitHub, then configuration.
  registerStatusCommand(program);
  registerCommitCommand(program);
  registerLogCommand(program);

  registerSwitchCommand(program);
  registerStackCommand(program);
  registerWorktreeCommand(program);

  registerStashCommand(program);
  registerDiscardCommand(program);
  registerUndoCommand(program);
  registerResolveCommand(program);
  registerSquashCommand(program);
  registerRenameCommand(program);
  registerSyncCommand(program);

  registerCloneCommand(program);
  registerRepoCommand(program);
  registerPrCommand(program);
  registerIssueCommand(program);
  registerRunCommand(program);
  registerChecksCommand(program);
  registerReleaseCommand(program);
  registerChangelogCommand(program);
  registerApiCommand(program);
  registerWorkflowCommand(program);
  registerLabelCommand(program);
  registerGistCommand(program);
  registerSearchCommand(program);
  registerSecretCommand(program);
  registerVariableCommand(program);
  registerNotificationsCommand(program);
  registerBrowseCommand(program);
  registerTriageCommand(program);
  registerDraftCommand(program);
  registerIgnoreCommand(program);
  registerAliasCommand(program);
  registerHookCommand(program);
  registerMcpCommand(program);
  registerPluginCommand(program);
  registerTeamCommand(program);

  registerConfigCommand(program);
  registerCompletionCommand(program);

  for (const command of program.commands) {
    const group = HELP_GROUPS[command.name()];
    if (group) command.helpGroup(group);
  }

  applyGlobalFlags(program);

  // Load community plugins (best-effort, never crashes ggh)
  try {
    await loadPlugins(program);
  } catch {
    // plugins are optional
  }

  return program;
}

const GIT_GLOBAL_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "-p",
  "--paginate",
  "--no-pager",
]);

export async function runCli(argv: string[]): Promise<void> {
  const rawArgs = argv.slice(2);
  const firstArg = rawArgs[0];

  // If first argument is a global git flag (e.g. -C /path/to/repo log), pass through to git!
  if (firstArg && GIT_GLOBAL_FLAGS.has(firstArg)) {
    const exitCode = await gitPassthrough(rawArgs);
    process.exit(exitCode);
  }

  // Expand user aliases before anything else: `ggh alias ci "commit --pr"`
  // must make `ggh ci` behave as `ggh commit --pr`. A corrupt aliases file
  // must never break every invocation.
  let args = rawArgs;
  if (args.length > 0 && args[0] !== "alias") {
    try {
      const { expandAlias } = await import("./commands/alias.ts");
      const expanded = expandAlias(args);
      if (process.env.GGH_DEBUG && expanded !== args) {
        process.stderr.write(`ggh: alias ${args[0]} → ${expanded.join(" ")}\n`);
      }
      args = expanded;
    } catch {
      // A corrupt aliases file must never break every invocation.
    }
  }

  const program = await createProgram();

  // Anything ggh does not define — or a shadowed command (`ggh log --oneline`,
  // `ggh checkout -- file`, `ggh config user.name`) used with git's flags — is
  // git's. `ggh git ...` and `ggh -- ...` force it.
  const decision = decideGitForward(program, args);
  if (decision.forward) {
    const head = args[0];
    // A typo of a ggh command used to fall through to git, whose suggestions
    // ("prune" for `ggh prr`) are useless. Suggest ours — unless the typo is
    // git's word or one of the user's git aliases, which always win.
    if (decision.reason === "unknown command" && head && !head.startsWith("-") && !head.includes("/")) {
      const names = new Set<string>();
      for (const command of program.commands) {
        names.add(command.name());
        for (const alias of command.aliases()) names.add(alias);
      }
      const gghHit = closestMatch(head, names);
      if (gghHit) {
        const gitHit = closestMatch(head, GIT_COMMANDS);
        const looksLikeGit = gitHit !== null && editDistance(head, gitHit) <= 1;
        let userAlias = false;
        if (!looksLikeGit) {
          try {
            const probed = await run("git", ["config", "--get", `alias.${head}`], { reject: false });
            userAlias = probed.exitCode === 0 && probed.stdout.trim().length > 0;
          } catch {
            userAlias = false;
          }
        }
        if (!looksLikeGit && !userAlias) {
          fail(`Unknown command "${head}". Did you mean "ggh ${gghHit}"?`);
          return;
        }
      }
    }
    const forwarded = head === "git" || head === "--" ? args.slice(1) : args;
    if (process.env.GGH_DEBUG && decision.reason) {
      process.stderr.write(`ggh: forwarding to git (${decision.reason})\n`);
    }
    const exitCode = await gitPassthrough(forwarded);
    process.exit(exitCode);
  }

  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  // argv entries always exist in practice; fallbacks keep the type honest.
  await program.parseAsync([argv[0] ?? "ggh", argv[1] ?? "", ...args]);
}
