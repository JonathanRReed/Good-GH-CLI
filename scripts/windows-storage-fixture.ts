import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertWindowsPrivateDirectory, privateTemporaryDirectory } from "../src/services/private-storage.ts";

const scenario = process.argv[2];
if (!scenario || process.platform !== "win32") throw new Error("This fixture requires Windows and a scenario directory.");
const root = resolve(scenario);
if (process.argv[3] === "reject-cli") {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../bin/ggh.ts"), "config", "list", "--agent"], { env: { ...process.env, XDG_CONFIG_HOME: dirname(root), GGH_NO_PLUGINS: "0", GGH_NO_RECORDS: "1" }, encoding: "utf8", timeout: 30_000 });
  const report: unknown = JSON.parse(result.stdout);
  const rejected = result.status === 1 && typeof report === "object" && report !== null && "contract" in report && report.contract === "ggh.agent" && "status" in report && report.status === "failed";
  process.stdout.write(JSON.stringify({ rejected }));
  process.exit(0);
}
if (process.argv[3] === "reject") {
  try { assertWindowsPrivateDirectory(root); }
  catch { process.stdout.write(JSON.stringify({ rejected: true })); process.exit(0); }
  throw new Error("Unsafe storage was accepted.");
}
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.TMP = join(root, "temp");
process.env.TEMP = process.env.TMP;
for (const dir of [process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, process.env.TMP]) mkdirSync(dir, { recursive: true });
const { saveConfig, getConfig } = await import("../src/services/config.ts");
const { cached } = await import("../src/services/cache.ts");
const { startOperation, updateOperation, readOperation } = await import("../src/services/operations.ts");
const { createStackRecovery, writeStackRecovery, readStackRecovery } = await import("../src/services/git/stack.ts");
const { captureStagedSnapshot, executeSplitCommits } = await import("../src/services/git/split.ts");
saveConfig({ first_run_completed: true, ai_enabled: false });
if (!getConfig(root).first_run_completed) throw new Error("Config did not round trip.");
await cached("windows-privacy-fixture", async () => ({ synthetic: "cached response" }));
const repo = join(root, "repo"); mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
git("init", "-b", "main"); git("config", "user.name", "Privacy fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "synthetic.txt"), "initial\n"); git("add", "."); git("commit", "-m", "initial");
const operation = await startOperation({ command: "stack submit", cwd: repo, steps: ["synthetic"] });
await updateOperation(operation.id, { status: { state: "succeeded" } }, repo);
if ((await readOperation(operation.id, repo)).status.state !== "succeeded") throw new Error("Operation did not round trip.");
const tip = git("rev-parse", "HEAD");
const checkpoint = { schemaVersion: 1, operationId: randomUUID(), mode: "restack", selected: "main", originalBranch: "main", entries: [{ branch: "main", parent: "base", originalTip: tip, expectedTip: tip, state: "pending" }], activeIndex: 0, resources: [] } satisfies Parameters<typeof createStackRecovery>[0];
await createStackRecovery(checkpoint, repo); await writeStackRecovery(checkpoint, repo);
if (!(await readStackRecovery(repo))) throw new Error("Stack checkpoint missing.");
writeFileSync(join(repo, "synthetic.txt"), "staged\n"); git("add", ".");
const snapshot = await captureStagedSnapshot(repo);
// A failing commit keeps the real split checkpoint for access probes.
git("config", "user.name", "");
let splitFailed = false;
try { await executeSplitCommits(snapshot, [{ subject: "synthetic", body: "", files: ["synthetic.txt"] }]); }
catch { splitFailed = true; }
if (!splitFailed || !existsSync(join(repo, ".git", "ggh-split"))) throw new Error("Split failure did not retain its checkpoint.");
const temporary = privateTemporaryDirectory("qualification-");
writeFileSync(join(temporary, "prompt.txt"), "Synthetic prompt\n"); writeFileSync(join(temporary, "output.txt"), "Synthetic output\n");
const roots = [join(root, "config", "good-gh"), join(root, "cache", "good-gh"), join(repo, ".git", "ggh-operations"), join(repo, ".git", "ggh-stack-recovery"), join(repo, ".git", "ggh-split"), join(root, "temp", "good-gh-private")];
const artifacts: Array<{ path: string; type: "file" | "directory" }> = [];
function walk(path: string): void { artifacts.push({ path, type: "directory" }); for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) walk(child); else if (entry.isFile()) artifacts.push({ path: child, type: "file" }); else throw new Error("Unexpected fixture artifact type."); } }
for (const path of roots) walk(path);
if (!artifacts.some(item => item.type === "file" && item.path.includes("entry-v2-"))) throw new Error("Cache entry missing.");
process.stdout.write(JSON.stringify({ roots, artifacts }));
