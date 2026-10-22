import { registerProjectsCommand } from "./commands/projects.ts";
import { registerGoCommand } from "./commands/go.ts";
import { registerInitCommand } from "./commands/init.ts";
import { CapabilityError } from "./services/dependency-compatibility.ts";
import { registerAgentCommand } from "./commands/agent.ts";
import { finalizeJsonOutput } from "./utils/output.ts";
import { beginCommandOutput, setCommandPath, recordCommandIssue, rememberCommandResult } from "./services/runtime.ts";
import { Command, CommanderError } from "commander";
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
import { AGENT_CAPABLE, applyGlobalFlags } from "./utils/flags.ts";
import { GIT_COMMANDS, resolvePassthrough } from "./utils/passthrough.ts";
import { closestMatch } from "./utils/suggest.ts";
import { fail } from "./utils/ui.ts";
import { resetFlags, setFlags } from "./services/runtime.ts";
import { registerOperationCommand } from "./commands/operation.ts";
import { registerCommandOperations } from "./services/command-operations.ts";

/**
 * Top-level command groups for `ggh --help` and the generated man page.
 * A wall of 40 commands says "accumulated"; groups say "designed".
 * Commands without an entry (including community plugins) keep the default group.
 */
export const HELP_GROUPS: Record<string, string> = {
  projects: "Projects",
  go: "Projects",
  init: "Setup",
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
  git: "Native tools",
  gh: "Native tools",
  operation: "Local workflow",
  };

export async function createProgram(): Promise<Command> {
  const program = new Command();

  program
    .name("ggh")
    .description("Git and GitHub in one CLI: pull requests, issues, CI, stacked branches, and AI")
    .version(packageJson.version);

  for (const command of ["git", "gh"] as const) {
    program.command(`${command} [args...]`)
      .description(`Run ${command} with its native arguments, output, and exit status`)
      .allowUnknownOption()
      .action(async (args: string[]) => {
        process.exitCode = command === "git" ? await gitPassthrough(args)
          : (await run("gh", args, { stdio: "inherit", reject: false })).exitCode;
      });
  }

  // Registration order is the order `ggh --help` prints them, so it runs from
  // "where am I" through the daily loop, then GitHub, then configuration.
  registerProjectsCommand(program);
  registerGoCommand(program);
  registerInitCommand(program);
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
  registerOperationCommand(program);
  registerCompletionCommand(program);

  for (const command of program.commands) {
    const group = HELP_GROUPS[command.name()];
    if (group) command.helpGroup(group);
  }

  registerAgentCommand(program);
  program.option("--agent", "Emit the versioned agent envelope");
  applyGlobalFlags(program);
  registerCommandOperations(program);

  // Load community plugins (best-effort, never crashes ggh)
  try {
    await loadPlugins(program);
  } catch {
    // plugins are optional
  }

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  resetFlags();
  const { clearAIUsageReports } = await import("./services/ai/index.ts");
  clearAIUsageReports();
  const rawArgs = argv.slice(2);

  const rawEscape = resolvePassthrough(rawArgs);
  if (rawEscape) {
    process.exitCode = rawEscape.command === "git"
      ? await gitPassthrough(rawEscape.args)
      : (await run("gh", rawEscape.args, { stdio: "inherit", reject: false })).exitCode;
    return;
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

  const aliasEscape = resolvePassthrough(args);
  if (aliasEscape) {
    process.exitCode = aliasEscape.command === "git"
      ? await gitPassthrough(aliasEscape.args)
      : (await run("gh", aliasEscape.args, { stdio: "inherit", reject: false })).exitCode;
    return;
  }

  if (args.length === 0 || args.every(arg => ["--agent", "--json", "-q", "--quiet", "--no-input"].includes(arg))) args = ["projects", ...args];

  const agentRequested = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).includes("--agent");
  if (agentRequested) {
    beginCommandOutput();
    setFlags({ agent: true, json: true, noInput: true });
  }
  let program: Command;
  try { program = await createProgram(); }
  catch (error) {
    if (!agentRequested) throw error;
    fail(error instanceof Error ? error.message : String(error), { code: "operation_failed" });
    finalizeJsonOutput();
    return;
  }
  const parsingCommands = [program];
  for (const command of parsingCommands) {
    command.exitOverride();
    parsingCommands.push(...command.commands);
  }

  const agentInformation: string[] = [];
  if (agentRequested) {
    for (const command of parsingCommands) command.configureOutput({ writeOut: value => { agentInformation.push(value); } });
    beginCommandOutput();
    setFlags({ agent: true, json: true, noInput: true });
    const path: string[] = [];
    let current = program;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const next = current.commands.find(command => command.name() === arg || command.aliases().includes(arg));
      if (!next) break;
      path.push(next.name());
      current = next;
    }
    setCommandPath(path);
  }
  const head = args.find(arg => !arg.startsWith("-"));
  const domain = program.commands.find(command => command.name() === head || command.aliases().includes(head ?? ""));
  if (agentRequested && domain && !AGENT_CAPABLE.has(domain.name())) {
    fail(`The ${domain.name()} command does not support --agent.`, { code: "invalid_arguments" });
    finalizeJsonOutput();
    return;
  }
  if (head && !head.startsWith("-") && head !== "help" &&
      !program.commands.some(command => command.name() === head || command.aliases().includes(head))) {
    const names = program.commands.flatMap(command => [command.name(), ...command.aliases()]);
    const suggestion = closestMatch(head, names);
    fail(GIT_COMMANDS.has(head)
      ? `Use the explicit Git command: ggh git ${args.join(" ")}`
      : `Unknown command "${head}".${suggestion ? ` Did you mean "ggh ${suggestion}"?` : ""} Use ggh git or ggh gh for native commands.`);
    if (agentRequested) { recordCommandIssue({ status: "failed", code: "invalid_arguments", message: "Unknown command." }); finalizeJsonOutput(); }
    return;
  }

  // argv entries always exist in practice; fallbacks keep the type honest.
  try {
    await program.parseAsync([argv[0] ?? "ggh", argv[1] ?? "", ...args]);
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) {
      if (agentRequested) {
        rememberCommandResult({ output: agentInformation.join("") });
        finalizeJsonOutput();
      }
      return;
    }
    const jsonRequested = parsingCommands.some(command => command.opts().json === true);
    if (jsonRequested) setFlags({ json: true });
    if (err instanceof CommanderError && head && GIT_COMMANDS.has(head)) {
      err.message += ` Use ggh git ${args.join(" ")} for Git's native syntax.`;
    }
    if (agentRequested) {
      recordCommandIssue({ status: "failed", code: err instanceof CapabilityError ? "provider_unavailable" : err instanceof CommanderError ? "invalid_arguments" : "operation_failed", message: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
      const { finishCommandOperation } = await import("./services/command-operations.ts");
      await finishCommandOperation();
      finalizeJsonOutput();
      return;
    }
    if (err instanceof CapabilityError) { fail(err.message, { code: "provider_unavailable" }); finalizeJsonOutput(); return; }
    throw err;
  }
}
