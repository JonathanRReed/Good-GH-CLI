import { readFileSync, writeFileSync } from "node:fs";
import { recorded, type ReplaySpec } from "./replay.ts";

const specPath = process.argv[2];
if (!specPath) throw new Error("Replay specification required.");
const spec: ReplaySpec = JSON.parse(readFileSync(specPath, "utf8"));
const calls: string[][] = [];
const unexpected: string[][] = [];
// This child never launches git, gh, providers, or another external process.
Object.defineProperty(Bun, "spawn", { value: (argv: string[]) => {
  calls.push(argv);
  const response = spec.responses.find(row => row.command === argv[0] && row.prefix.every((part, i) => argv[i + 1] === part));
  if (!response) unexpected.push(argv);
  return {
    pid: 0, stdin: null, kill() {},
    stdout: new Blob([response?.fixture ? recorded(response.fixture) : response?.stdout ?? ""]).stream(),
    stderr: new Blob([response?.stderr ?? (response ? "" : `Unexpected offline replay call: ${argv.join(" ")}`)]).stream(),
    exited: Promise.resolve(response?.exitCode ?? (response ? 0 : 99)),
  };
} });
Object.defineProperty(Bun, "spawnSync", { value: () => { throw new Error("spawnSync is forbidden in offline replay."); } });
const denyNetwork = () => { throw new Error("Network is forbidden in offline replay."); };
globalThis.fetch = Object.assign(async () => denyNetwork(), { preconnect: denyNetwork });
try {
  const { runCli } = await import("../../src/index.ts");
  await runCli(["bun", "ggh", ...spec.args]);
} catch (err) {
  const { fail } = await import("../../src/utils/ui.ts");
  const { finalizeJsonOutput } = await import("../../src/utils/output.ts");
  fail(err instanceof Error ? err.message : String(err));
  finalizeJsonOutput();
} finally {
  writeFileSync(`${specPath}.trace`, JSON.stringify({ calls, unexpected }));
}
