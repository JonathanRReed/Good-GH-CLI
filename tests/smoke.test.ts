import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

async function runCli(
  args: string[],
  cwd: string = repoRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", join(repoRoot, "bin", "ggh.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
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
    const { exitCode, stderr } = await runCli(["log", "-n", "abc"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid commit count");
  });
});

/**
 * stdout is the data channel and stderr is the chrome channel. Without this
 * split `ggh log | grep` matches its own banner and `ggh x > /dev/null` throws
 * away the error that explains the failure.
 */
describe("stream separation", () => {
  it("keeps banners and step messages off stdout", async () => {
    const { stdout, stderr } = await runCli(["worktree", "list"]);
    expect(stderr).toContain("good-gh");
    expect(stdout).not.toContain("good-gh");
  });

  it("writes errors to stderr, so redirecting stdout never hides them", async () => {
    const { stdout, stderr } = await runCli(["log", "-n", "abc"]);
    expect(stderr).toContain("Invalid commit count");
    expect(stdout).not.toContain("Invalid commit count");
  });

  it("puts git passthrough data on stdout", async () => {
    const { stdout } = await runCli(["rev-parse", "--is-inside-work-tree"]);
    expect(stdout.trim()).toBe("true");
  });
});

describe("CLI exit codes", () => {
  let outsideRepo: string;

  beforeAll(() => {
    outsideRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-notarepo-")));
  });

  afterAll(() => {
    rmSync(outsideRepo, { recursive: true, force: true });
  });

  // Every command that reports a failure must be usable as a gate in a script.
  const repoRequiringCommands = [
    ["undo"],
    ["sync"],
    ["switch"],
    ["resolve"],
    ["discard"],
    ["stash"],
    ["rename"],
    ["log"],
    ["squash"],
    ["worktree", "list"],
  ];

  for (const args of repoRequiringCommands) {
    it(`\`ggh ${args.join(" ")}\` exits non-zero outside a git repository`, async () => {
      const { exitCode } = await runCli(args, outsideRepo);
      expect(exitCode).not.toBe(0);
    });
  }

  it("rejects an unknown config key with a non-zero exit code", async () => {
    const { exitCode } = await runCli(["config", "set", "not_a_key", "x"]);
    expect(exitCode).not.toBe(0);
  });

  it("rejects an out-of-range ai_timeout_ms", async () => {
    const { exitCode } = await runCli(["config", "set", "ai_timeout_ms", "10"]);
    expect(exitCode).not.toBe(0);
  });
});

describe("shell completion is generated from the real command tree", () => {
  it("includes every registered command and alias in each shell", async () => {
    const { createProgram } = await import("../src/index.ts");
    const program = createProgram();

    const surface = new Set<string>();
    for (const command of program.commands) {
      if (command.name() === "help") continue;
      surface.add(command.name());
      for (const alias of command.aliases()) surface.add(alias);
    }

    for (const shell of ["zsh", "bash", "fish"]) {
      const { stdout, exitCode } = await runCli(["completion", shell]);
      expect(exitCode).toBe(0);
      for (const name of surface) {
        expect(stdout, `${shell} completion is missing "${name}"`).toContain(name);
      }
    }
  });

  it("writes the script to stdout so `eval $(ggh completion zsh)` works", async () => {
    const { stdout, stderr } = await runCli(["completion", "zsh"]);
    expect(stdout).toContain("#compdef ggh");
    expect(stderr.trim()).toBe("");
  });

  it("rejects an unsupported shell with a non-zero exit code", async () => {
    const { exitCode, stderr } = await runCli(["completion", "powershell"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unsupported shell");
  });
});

/**
 * A dry run must report and exit before any confirmation prompt. Checking the
 * flag after the prompt means `--dry-run` in a script cancels and prints nothing.
 */
describe("--dry-run", () => {
  let repo: string;

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ggh-dryrun-")));
    const git = (args: string[]) => Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    await Bun.write(join(repo, "a.txt"), "one\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "chore: base"]);
    await Bun.write(join(repo, "a.txt"), "modified\n");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reports what discard would remove without prompting or removing it", async () => {
    const { stderr } = await runCli(["discard", "--all", "--dry-run"], repo);
    expect(stderr).toContain("dry run");
    expect(stderr).toContain("a.txt");
    expect(stderr).not.toContain("Cannot prompt");
    expect(await Bun.file(join(repo, "a.txt")).text()).toBe("modified\n");
  });

  it("reports what undo would reset without resetting it", async () => {
    const before = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: repo });
    const { stderr } = await runCli(["undo", "--dry-run"], repo);
    expect(stderr).toContain("dry run");
    const after = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: repo });
    expect(after.stdout.toString()).toBe(before.stdout.toString());
  });
});
