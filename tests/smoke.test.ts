import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", join(repoRoot, "bin", "ggh.ts"), ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

describe("CLI smoke tests", () => {
  it("starts, prints help, and exits cleanly", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("ggh");
  });

  it("reports the package version (single source of truth: package.json)", async () => {
    const pkg = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text());
    const { exitCode, stdout } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("lists all documented commands in help output", async () => {
    const { stdout } = await runCli(["--help"]);
    for (const command of [
      "clone",
      "commit",
      "worktree",
      "config",
      "status",
      "undo",
      "switch",
      "resolve",
      "stash",
      "completion",
      "pr",
      "sync",
      "squash",
      "release",
      "checks",
      "discard",
      "rename",
      "log",
    ]) {
      expect(stdout).toContain(command);
    }
  });

  it("rejects an invalid log count with a non-zero exit code", async () => {
    const { exitCode, stdout } = await runCli(["log", "-n", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Invalid commit count");
  });
});
