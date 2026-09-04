import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

async function runCli(
  args: string[],
  cwd: string = repoRoot,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", join(repoRoot, "bin", "ggh.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  await proc.exited;
}

async function initRepo(dir: string): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), dir)));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await Bun.write(join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "chore: base"]);
  return repo;
}

let configDir: string;
let draftRepo: string;
let hookDryRepo: string;
let hookEditRepo: string;
let ignoreRepo: string;
let genericRepo: string;
const tmpRoots: string[] = [];

beforeAll(async () => {
  configDir = realpathSync(mkdtempSync(join(tmpdir(), "ggh-safety-config-")));

  draftRepo = await initRepo("ggh-safety-draft-");
  tmpRoots.push(draftRepo);
  // Two stashes with the ggh-draft: prefix (dirty the file before each push).
  await Bun.write(join(draftRepo, "a.txt"), "draft one\n");
  await git(draftRepo, ["stash", "push", "-m", "ggh-draft: one"]);
  await Bun.write(join(draftRepo, "a.txt"), "draft two\n");
  await git(draftRepo, ["stash", "push", "-m", "ggh-draft: two"]);

  hookDryRepo = await initRepo("ggh-safety-hookdry-");
  tmpRoots.push(hookDryRepo);
  writeFileSync(join(hookDryRepo, ".git", "hooks", "pre-commit"), "hookcontent\n");

  hookEditRepo = await initRepo("ggh-safety-hookedit-");
  tmpRoots.push(hookEditRepo);

  ignoreRepo = await initRepo("ggh-safety-ignore-");
  tmpRoots.push(ignoreRepo);

  genericRepo = await initRepo("ggh-safety-generic-");
  tmpRoots.push(genericRepo);
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

const isolatedEnv = () => ({ XDG_CONFIG_HOME: configDir });

describe("safety net: local-only black-box paths", () => {
  it("1. alias expansion works", async () => {
    const set = await runCli(["alias", "zz9", "config get ai_provider"], repoRoot, isolatedEnv());
    expect(set.exitCode).toBe(0);

    const expected = await runCli(["config", "get", "ai_provider"], repoRoot, isolatedEnv());
    expect(expected.exitCode).toBe(0);

    const expanded = await runCli(["zz9"], repoRoot, isolatedEnv());
    expect(expanded.exitCode).toBe(0);
    expect(expanded.stdout.trim()).toBe(expected.stdout.trim());

    const rm = await runCli(["alias", "--remove", "zz9"], repoRoot, isolatedEnv());
    expect(rm.exitCode).toBe(0);
  });

  it("2. alias --json prints a valid JSON object", async () => {
    const { exitCode, stdout } = await runCli(["alias", "--json"], repoRoot, isolatedEnv());
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
  });

  it("3. draft resume --dry-run never prompts", async () => {
    const { exitCode, stderr } = await runCli(["draft", "resume", "--dry-run"], draftRepo);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("dry run");
    expect(stderr).not.toContain("Cannot prompt");
  });

  it("4. draft drop --dry-run never prompts", async () => {
    const { exitCode, stderr } = await runCli(["draft", "drop", "--dry-run"], draftRepo);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("dry run");
    expect(stderr).not.toContain("Cannot prompt");
  });

  it("5. hook install --dry-run with existing hook leaves the file unchanged", async () => {
    const hookPath = join(hookDryRepo, ".git", "hooks", "pre-commit");
    const before = readFileSync(hookPath, "utf-8");
    const { exitCode, stderr } = await runCli(["hook", "install", "pre-commit", "--dry-run"], hookDryRepo);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Cannot prompt");
    expect(readFileSync(hookPath, "utf-8")).toBe(before);
  });

  it("6. hook edit --json prints name and content as JSON", async () => {
    const installed = await runCli(["hook", "install", "pre-commit", "-y"], hookEditRepo);
    expect(installed.exitCode).toBe(0);
    const { exitCode, stdout } = await runCli(["hook", "edit", "pre-commit", "--json"], hookEditRepo);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("pre-commit");
    expect(typeof parsed.content).toBe("string");
  });

  it("7. ignore --json: empty list then noop on duplicate", async () => {
    const listed = await runCli(["ignore", "--list", "--json"], ignoreRepo);
    expect(listed.exitCode).toBe(0);
    const parsedList = JSON.parse(listed.stdout);
    expect(parsedList.patterns).toEqual([]);

    const added = await runCli(["ignore", "*.log"], ignoreRepo);
    expect(added.exitCode).toBe(0);

    const noop = await runCli(["ignore", "*.log", "--json"], ignoreRepo);
    expect(noop.exitCode).toBe(0);
    const parsedNoop = JSON.parse(noop.stdout);
    expect(parsedNoop.action).toBe("noop");
  });

  it("8. plugin list --json is reachable with isolated config", async () => {
    const { exitCode, stdout } = await runCli(["plugin", "list", "--json"], repoRoot, isolatedEnv());
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("plugin installation requires explicit trust confirmation", async () => {
    const source = join(configDir, "trusted-plugin.ts");
    writeFileSync(source, "export function register() {}\n");

    const refused = await runCli(
      ["plugin", "install", "trusted-plugin", "--from", source],
      repoRoot,
      isolatedEnv(),
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Cannot prompt");

    const accepted = await runCli(
      ["plugin", "install", "trusted-plugin", "--from", source, "--yes"],
      repoRoot,
      isolatedEnv(),
    );
    expect(accepted.exitCode).toBe(0);
  });

  it("loads a trusted plugin when the config path contains spaces", async () => {
    const spacedConfig = join(configDir, "path with spaces");
    mkdirSync(spacedConfig, { recursive: true });
    const source = join(spacedConfig, "space-plugin.ts");
    writeFileSync(
      source,
      'import type { Command } from "commander";\nexport function register(program: Command) { program.command("space-plugin").action(() => process.stdout.write("plugin ok\\n")); }\n',
    );
    const env = { XDG_CONFIG_HOME: spacedConfig };

    const installed = await runCli(["plugin", "install", "space-plugin", "--from", source, "--yes"], repoRoot, env);
    expect(installed.exitCode).toBe(0);
    const invoked = await runCli(["space-plugin"], repoRoot, env);
    expect(invoked.exitCode).toBe(0);
    expect(invoked.stdout.trim()).toBe("plugin ok");
  });

  it("9. team --help documents publish, draft --help documents resume", async () => {
    const team = await runCli(["team", "--help"]);
    expect(team.exitCode).toBe(0);
    expect(team.stdout).toContain("publish");
    const draft = await runCli(["draft", "--help"]);
    expect(draft.exitCode).toBe(0);
    expect(draft.stdout).toContain("resume");
  });

  it("10. api mutating dry-run is hermetic", async () => {
    const { exitCode, stderr } = await runCli(["api", "/repos/o/r", "-X", "POST", "--dry-run"], genericRepo);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("dry run");
    expect(stderr).not.toContain("Cannot prompt");
  });

  it("11. stack list --dry-run --json still emits valid JSON", async () => {
    const { exitCode, stdout } = await runCli(["stack", "list", "--dry-run", "--json"], genericRepo);
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("12. api --help answers instead of hitting the API", async () => {
    const { exitCode, stderr } = await runCli(["api", "--help"], genericRepo);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Usage: ggh api");
  });

  it("13. typo of a ggh command suggests it instead of git's guess", async () => {
    // Isolate git aliases so the test is deterministic on any machine:
    // a user alias must win, so none may exist here.
    const { exitCode, stderr } = await runCli(["prr"], genericRepo, {
      GIT_CONFIG_GLOBAL: join(configDir, "empty-gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Did you mean "ggh pr"');
  });
});
