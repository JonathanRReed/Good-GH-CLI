import { removedCommandMessage } from "./services/removed-commands.ts";
import { registerTidyCommand } from "./commands/tidy.ts";
import { registerLostCommand } from "./commands/lost.ts";
import { registerProjectsCommand } from "./commands/projects.ts";
import { registerGoCommand } from "./commands/go.ts";
import { registerInitCommand } from "./commands/init.ts";
import { CapabilityError } from "./services/dependency-compatibility.ts";
import { PushProtectionError } from "./services/git/push-protection.ts";
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
import { registerCiCommand } from "./commands/ci.ts";
import { registerChecksCommand } from "./commands/checks.ts";
import { registerCompletionCommand } from "./commands/completion.ts";
import { registerDiscardCommand } from "./commands/discard.ts";
import { registerHookCommand } from "./commands/hook.ts";
import { registerIgnoreCommand } from "./commands/ignore.ts";
import { registerLogCommand } from "./commands/log.ts";
import { registerIssueCommand } from "./commands/issue.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerApiCommand } from "./commands/api.ts";
import { registerNotificationsCommand } from "./commands/notifications.ts";
import { registerPluginCommand, loadPlugins } from "./commands/plugin.ts";
import { registerRepoCommand } from "./commands/repo.ts";
import { registerStackCommand } from "./commands/stack.ts";
import { registerReviewCommand } from "./commands/review.ts";
import { registerInboxCommand } from "./commands/inbox.ts";
import { registerPrCommand } from "./commands/pr.ts";
import { registerRenameCommand } from "./commands/rename.ts";
import { registerResolveCommand } from "./commands/resolve.ts";
import { registerSquashCommand } from "./commands/squash.ts";
import { registerStashCommand } from "./commands/stash.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerSwitchCommand } from "./commands/switch.ts";
import { registerSyncCommand } from "./commands/sync.ts";
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
 * The one-line pitch `ggh --help` leads with. Same promise as the README: the
 * GitHub CLI it should have been, not "Git and GitHub and AI in one CLI".
 */
const PITCH = "The GitHub CLI it should have been: find the right checkout, understand its state, act on GitHub safely, for you and your agents.";

/**
 * Top-level command groups for `ggh --help` and the generated man page.
 * A wall of 40 commands says "accumulated"; groups say "designed". Every
 * built-in command belongs to exactly one group, and the group order below is
 * the order the help prints them: the project table you start from, then the
 * publish loop, local branch work, CI, the agent/plumbing surface, and the
 * native escapes last so they never lead the list. Community plugins keep the
 * default group.
 */
export const HELP_GROUPS: Record<string, string> = {
  // Projects: one table across local clones and agent worktrees.
  projects: "Projects",
  go: "Projects",
  clone: "Projects",
  lost: "Projects",
  sync: "Projects",
  tidy: "Projects",
  inbox: "Projects",

  // Review & publish: the GitHub-facing loop.
  status: "Review & publish",
  commit: "Review & publish",
  pr: "Review & publish",
  review: "Review & publish",
  issue: "Review & publish",
  repo: "Review & publish",
  notifications: "Review & publish",

  // Branches & stacks: local branch, worktree, and history work.
  log: "Branches & stacks",
  switch: "Branches & stacks",
  stack: "Branches & stacks",
  worktree: "Branches & stacks",
  stash: "Branches & stacks",
  squash: "Branches & stacks",
  rename: "Branches & stacks",
  discard: "Branches & stacks",
  undo: "Branches & stacks",
  resolve: "Branches & stacks",

  // CI: revision-linked checks and runs.
  checks: "CI",
  ci: "CI",
  run: "CI",

  // Agents: the automation, configuration, and extension surface.
  agent: "Agents",
  mcp: "Agents",
  plugin: "Agents",
  config: "Agents",
  init: "Agents",
  completion: "Agents",
  ignore: "Agents",
  alias: "Agents",
  hook: "Agents",
  operation: "Agents",

  // Native escapes: git, gh, and the raw API own their arguments and streams.
  git: "Native escapes",
  gh: "Native escapes",
  api: "Native escapes",
};

export async function createProgram(): Promise<Command> {
  const program = new Command();

  program
    .name("ggh")
    .description(PITCH)
    .version(packageJson.version);

  // Registration order is the order `ggh --help` prints the groups in: the
  // first command registered in a group fixes where that group appears. So it
  // runs from "where am I" through the publish loop, branch work, CI, and the
  // agent surface, and ends with the native escapes.
  registerProjectsCommand(program);
  registerGoCommand(program);
  registerCloneCommand(program);
  registerLostCommand(program);
  registerSyncCommand(program);
  registerTidyCommand(program);
  registerInboxCommand(program);

  registerStatusCommand(program);
  registerCommitCommand(program);
  registerPrCommand(program);
  registerReviewCommand(program);
  registerIssueCommand(program);
  registerRepoCommand(program);
  registerNotificationsCommand(program);

  registerLogCommand(program);
  registerSwitchCommand(program);
  registerStackCommand(program);
  registerWorktreeCommand(program);
  registerStashCommand(program);
  registerSquashCommand(program);
  registerRenameCommand(program);
  registerDiscardCommand(program);
  registerUndoCommand(program);
  registerResolveCommand(program);

  registerChecksCommand(program);
  registerCiCommand(program);
  registerRunCommand(program);

  registerConfigCommand(program);
  registerInitCommand(program);
  registerCompletionCommand(program);
  registerIgnoreCommand(program);
  registerAliasCommand(program);
  registerHookCommand(program);
  registerOperationCommand(program);
  registerMcpCommand(program);
  registerPluginCommand(program);

  // Native escapes own their arguments, streams, and exit codes, so they are
  // never decorated with the managed flags and are registered last.
  for (const command of ["git", "gh"] as const) {
    program.command(`${command} [args...]`)
      .description(`Run ${command} with its native arguments, output, and exit status`)
      .allowUnknownOption()
      .action(async (args: string[]) => {
        process.exitCode = command === "git" ? await gitPassthrough(args)
          : (await run("gh", args, { stdio: "inherit", reject: false })).exitCode;
      });
  }
  registerApiCommand(program);

  program.option("--agent", "Emit the versioned agent envelope");
  applyGlobalFlags(program);
  registerCommandOperations(program);

  // `agent` registers after applyGlobalFlags so it keeps its own surface, and
  // the implicit `help` command is created lazily. Group both here so no stray
  // "Commands:" heading is left behind.
  registerAgentCommand(program);
  for (const command of program.commands) {
    const group = HELP_GROUPS[command.name()];
    if (group) command.helpGroup(group);
  }
  program.commandsGroup("Agents");
  program.helpCommand("help [command]", "display help for command");
  program.commandsGroup("");

  program.addHelpText("after", [
    "",
    "Examples:",
    "  ggh                    One table across local clones and agent worktrees",
    "  ggh lost               Find work that never left this machine",
    "  ggh pr 42 --checkout   Review a pull request from the right checkout",
  ].join("\n"));

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

  if (args.length === 0 || args.every(arg => ["--agent", "--json", "-q", "--quiet", "--no-input", "--wide", "--remote", "--uncloned", "--refresh"].includes(arg))) args = ["projects", ...args];

  const agentRequested = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).includes("--agent");
  if (agentRequested) {
    beginCommandOutput();
    setFlags({ agent: true, json: true, noInput: true });
  }
  const removedHead = args.find(arg => !arg.startsWith("-"));
  const removed = removedHead ? removedCommandMessage(removedHead) : undefined;
  if (removed) {
    if (args.includes("--json")) setFlags({ json: true });
    setCommandPath([removedHead ?? ""]);
    fail(removed, { code: "invalid_arguments" });
    finalizeJsonOutput();
    return;
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
  // Commander writes usage errors to stderr itself and then throws. Mute that
  // write so the catch below can report each failure exactly once, with the
  // git-passthrough hint included.
  if (!agentRequested) for (const command of parsingCommands) command.configureOutput({ writeErr: () => {} });

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
      recordCommandIssue({ status: "failed", code: err instanceof CapabilityError ? "provider_unavailable" : err instanceof CommanderError ? "invalid_arguments" : err instanceof PushProtectionError ? "push_protection_blocked" : "operation_failed", message: err instanceof Error ? err.message : String(err), ...(err instanceof PushProtectionError ? { pushProtection: err.details } : {}) });
      process.exitCode = 1;
      const { finishCommandOperation } = await import("./services/command-operations.ts");
      await finishCommandOperation();
      finalizeJsonOutput();
      return;
    }
    if (err instanceof CapabilityError) { fail(err.message, { code: "provider_unavailable" }); finalizeJsonOutput(); return; }
    if (err instanceof CommanderError) {
      // The usage error is reported once here, not rethrown into the launcher's
      // generic failure printer. `commander.help` already printed help for a
      // missing subcommand, and its internal "(outputHelp)" sentinel is not a
      // message for humans.
      process.exitCode = err.exitCode || 1;
      const message = err.code === "commander.help"
        ? `Unknown command "${args[1] ?? ""}". Run ggh --help to list commands.`
        : err.message;
      recordCommandIssue({ status: "failed", code: "invalid_arguments", message });
      if (!jsonRequested) process.stderr.write(`${message}\n`);
      finalizeJsonOutput();
      return;
    }
    throw err;
  }
}
