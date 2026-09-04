#!/usr/bin/env bun
import { runCli } from "../src/index.ts";
import { killAllChildren } from "../src/utils/exec.ts";
import { restoreTerminal } from "../src/utils/output.ts";

let interrupted = false;

/**
 * Ctrl-C must take effect immediately: say something, restore the terminal
 * (raw mode and the cursor are toggled by the pickers and the spinner), take
 * any subprocess down with us, then exit 130 as the shell expects. A second
 * interrupt skips cleanup entirely.
 */
function onInterrupt(signal: NodeJS.Signals): void {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write("\n\x1b[31m✖\x1b[0m  Cancelled.\n");
  restoreTerminal();
  killAllChildren();
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

process.on("SIGINT", () => onInterrupt("SIGINT"));
process.on("SIGTERM", () => onInterrupt("SIGTERM"));
process.on("exit", restoreTerminal);

/**
 * A closed pipe (`ggh log --oneline | head -2`) is not a failure: the consumer
 * got what it wanted. ripgrep and fzf exit 0 here; dying of SIGPIPE would
 * punish `set -o pipefail` scripts for succeeding.
 */
process.on("SIGPIPE", () => process.exit(0));

runCli(process.argv).catch((err) => {
  restoreTerminal();
  killAllChildren();
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
