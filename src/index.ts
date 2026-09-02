import { Command } from "commander";
import { registerCloneCommand } from "./commands/clone.ts";
import { registerCommitCommand } from "./commands/commit.ts";
import { registerWorktreeCommand } from "./commands/worktree.ts";
import { registerConfigCommand } from "./commands/config.ts";
import { registerChecksCommand } from "./commands/checks.ts";
import { registerCompletionCommand } from "./commands/completion.ts";
import { registerDiscardCommand } from "./commands/discard.ts";
import { registerLogCommand } from "./commands/log.ts";
import { registerPrCommand } from "./commands/pr.ts";
import { registerReleaseCommand } from "./commands/release.ts";
import { registerRenameCommand } from "./commands/rename.ts";
import { registerResolveCommand } from "./commands/resolve.ts";
import { registerSquashCommand } from "./commands/squash.ts";
import { registerStashCommand } from "./commands/stash.ts";
import { registerStatusCommand } from "./commands/status.ts";
import { registerSwitchCommand } from "./commands/switch.ts";
import { registerSyncCommand } from "./commands/sync.ts";
import { registerUndoCommand } from "./commands/undo.ts";
import { gitPassthrough } from "./services/git.ts";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("ggh")
    .description("Good GH CLI — A modern Git and GitHub CLI inspired by T3 Code")
    .version("0.1.0");

  registerCloneCommand(program);
  registerCommitCommand(program);
  registerWorktreeCommand(program);
  registerConfigCommand(program);
  registerStatusCommand(program);
  registerUndoCommand(program);
  registerSwitchCommand(program);
  registerResolveCommand(program);
  registerStashCommand(program);
  registerCompletionCommand(program);
  registerPrCommand(program);
  registerSyncCommand(program);
  registerSquashCommand(program);
  registerReleaseCommand(program);
  registerChecksCommand(program);
  registerDiscardCommand(program);
  registerRenameCommand(program);
  registerLogCommand(program);

  return program;
}

const KNOWN_COMMANDS = new Set([
  "clone",
  "add",
  "commit",
  "c",
  "undo",
  "resolve",
  "stash",
  "st",
  "switch",
  "sw",
  "checkout",
  "completion",
  "pr",
  "prs",
  "checks",
  "sync",
  "prune",
  "squash",
  "release",
  "rel",
  "discard",
  "restore",
  "rename",
  "graph",
  "log",
  "worktree",
  "wt",
  "config",
  "status",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
]);

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
  const args = argv.slice(2);
  const firstArg = args[0];

  // If first argument is a global git flag (e.g. -C /path/to/repo log), pass through to git!
  if (firstArg && GIT_GLOBAL_FLAGS.has(firstArg)) {
    const exitCode = await gitPassthrough(args);
    process.exit(exitCode);
  }

  // If first argument is not a known good-gh command and arguments are provided,
  // pass through to native git directly!
  if (firstArg && !KNOWN_COMMANDS.has(firstArg) && !firstArg.startsWith("-")) {
    const exitCode = await gitPassthrough(args);
    process.exit(exitCode);
  }

  const program = createProgram();

  if (args.length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(argv);
}
