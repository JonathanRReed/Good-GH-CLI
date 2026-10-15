#!/usr/bin/env bun
import { runCli } from "../src/index.ts";
import { killAllChildren } from "../src/utils/exec.ts";
import { restoreTerminal, finalizeJsonOutput } from "../src/utils/output.ts";
import { recordCommandIssue, setFlags } from "../src/services/runtime.ts";
import { finishCommandOperation } from "../src/services/command-operations.ts";

let interrupted = false;

/**
 * Ctrl-C must take effect immediately: say something, restore the terminal
 * (raw mode and the cursor are toggled by the pickers and the spinner), take
 * any subprocess down with us, then exit 130 as the shell expects. A second
 * interrupt skips cleanup entirely.
 */
async function onInterrupt(signal: NodeJS.Signals): Promise<void> {
  if (interrupted) process.exit(130);
  interrupted = true;
  process.stderr.write("\n\x1b[31m✖\x1b[0m  Cancelled.\n");
  recordCommandIssue({ status: "cancelled", message: "Cancelled." });
  restoreTerminal();
  await killAllChildren();
  process.exitCode = signal === "SIGTERM" ? 143 : 130;
  await finishCommandOperation();
  finalizeJsonOutput();
  process.exit(process.exitCode);
}

process.on("SIGINT", () => { void onInterrupt("SIGINT"); });
process.on("SIGTERM", () => { void onInterrupt("SIGTERM"); });
process.on("exit", restoreTerminal);

/**
 * A closed pipe (`ggh log --oneline | head -2`) is not a failure: the consumer
 * got what it wanted. ripgrep and fzf exit 0 here; dying of SIGPIPE would
 * punish `set -o pipefail` scripts for succeeding.
 */
let pipeClosed = false;
process.on("SIGPIPE", () => {
  if (pipeClosed) return;
  pipeClosed = true;
  void (async () => {
    restoreTerminal();
    await killAllChildren();
    process.exitCode = 0;
    setFlags({ json: false });
    await finishCommandOperation();
    process.exit(0);
  })();
});

runCli(process.argv).catch(async (err) => {
  restoreTerminal();
  await killAllChildren();
  console.error(err instanceof Error ? err.message : String(err));
  recordCommandIssue({ status: "failed", message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
  await finishCommandOperation();
  finalizeJsonOutput();
  process.exit(1);
});
