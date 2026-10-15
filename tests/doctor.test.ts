import { afterEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConfigCommand, type ConfigDoctorProbeDependencies } from "../src/commands/config.ts";
import { resetFlags, setFlags } from "../src/services/runtime.ts";

import { getInstallationGuidance } from "../src/services/install-guidance.ts";
import packageJson from "../package.json";

const roots: string[] = [];
const providerIds = ["codex", "grok", "claude", "ollama"] as const;

async function setup(options: { git?: boolean; gh?: boolean; gitVersion?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ggh-doctor-"));
  roots.push(root);
  const calls: string[] = [];
  const attachmentHelp: Record<string, string> = {
    "gh pr create --help": "Usage: gh pr create --attach <path>",
    "gh pr edit --help": "Usage: gh pr edit --attach <path>",
    "gh pr comment --help": "Usage: gh pr comment --body <text>",
    "gh issue create --help": "Usage: gh issue create --attach=<path>",
    "gh issue edit --help": "Usage: gh issue edit --attach <path>",
    "gh issue comment --help": "Usage: gh issue comment --body <text>",
  };
  const dependencies: ConfigDoctorProbeDependencies = {
    commandExists: (command) => command === "git" ? options.git !== false : command === "gh" && options.gh !== false,
    run: async (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (call === "git --version") return { stdout: `${options.gitVersion ?? "git version 2.50.0"}\n`, stderr: "", exitCode: 0 };
      if (call === "gh --version") return { stdout: "gh version 2.88.0 (fixture)\n", stderr: "", exitCode: 0 };
      if (call in attachmentHelp) return { stdout: `${attachmentHelp[call]}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 91 };
    },
    providers: providerIds.map((id) => ({
      id,
      displayName: id,
      model: `model-${id}`,
      installed: false,
      capabilities: [],
    })),
  };
  return { root, calls, dependencies };
}

async function doctor(
  fixture: Awaited<ReturnType<typeof setup>>,
  options: { aiEnabled?: boolean; fix?: boolean; dryRun?: boolean } = {},
) {
  const previousConfigDir = process.env.XDG_CONFIG_HOME;
  const previousAIEnabled = process.env.GGH_AI_ENABLED;
  const previousCwd = process.cwd();
  const priorStdout = process.stdout.write;
  const priorStderr = process.stderr.write;
  let stdout = "";
  process.env.XDG_CONFIG_HOME = fixture.root;
  delete process.env.GGH_AI_ENABLED;
  await mkdir(join(fixture.root, "good-gh"), { recursive: true });
  await writeFile(join(fixture.root, "good-gh", "config.json"), JSON.stringify({ ai_enabled: options.aiEnabled ?? false }));
  process.chdir(fixture.root);
  process.exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  resetFlags();
  setFlags({ json: true, dryRun: options.dryRun ?? false });

  try {
    const program = new Command();
    program.exitOverride();
    registerConfigCommand(program, fixture.dependencies);
    await program.parseAsync(["node", "ggh", "config", "doctor", ...(options.fix ? ["--fix"] : [])]);
    return {
      output: JSON.parse(stdout) as Record<string, unknown>,
      exitCode: process.exitCode ?? 0,
    };
  } finally {
    process.stdout.write = priorStdout;
    process.stderr.write = priorStderr;
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigDir;
    if (previousAIEnabled === undefined) delete process.env.GGH_AI_ENABLED;
    else process.env.GGH_AI_ENABLED = previousAIEnabled;
    process.exitCode = undefined;
    resetFlags();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("configuration doctor local tool checks", () => {
  it("reports unsupported and unparseable Git with upgrade guidance", async () => {
    for (const gitVersion of ["git version 2.30.9", "unrecognized"]) {
      const result = await doctor(await setup({ gitVersion }));
      expect(result.exitCode).toBe(1);
      expect(result.output.localTools).toMatchObject({ git: { installed: true, version: gitVersion, minimumVersion: "2.31.0", supported: false } });
      expect(JSON.stringify(result.output.problems)).toContain("https://git-scm.com/downloads");
    }
  });

  it("accepts the minimum Git version with vendor suffixes", async () => {
    for (const gitVersion of ["git version 2.31.0", "git version 2.31.0 (Apple Git-1)", "git version 2.31.0.windows.1"]) {
      const result = await doctor(await setup({ gitVersion }));
      expect(result.exitCode).toBe(0);
      expect(result.output.localTools).toMatchObject({ git: { minimumVersion: "2.31.0", supported: true } });
    }
  });

  it("reads Git and gh versions plus attachment flags from fake local help", async () => {
    const fixture = await setup();
    const result = await doctor(fixture);
    const tools = result.output.localTools as {
      git: { installed: boolean; version?: string; minimumVersion: string; supported: boolean };
      gh: { installed: boolean; version?: string; attachments: Record<string, boolean | null> };
    };
    expect(result.exitCode).toBe(0);
    expect(result.output.problems).toEqual([]);
    expect(result.output.installation).toMatchObject({ version: packageJson.version, supported: true });
    for (const [platform, arch, asset] of [
      ["linux", "x64", "ggh-linux-x64"], ["linux", "arm64", "ggh-linux-arm64"],
      ["darwin", "x64", "ggh-darwin-x64"], ["darwin", "arm64", "ggh-darwin-arm64"],
      ["win32", "x64", "ggh-windows-x64.exe"],
    ] as const) {
      const guidance = getInstallationGuidance(platform, arch, packageJson.version);
      expect(guidance.nativeAsset).toBe(asset);
      expect(guidance.downloadUrl).toContain(`/download/v${packageJson.version}/`);
      expect(guidance.downloadCommands.join("\n")).toMatch(/sha256|SHA256/);
      expect(guidance.installCommands.join("\n")).toContain(".local");
    }
    expect(getInstallationGuidance("win32", "arm64", packageJson.version)).toMatchObject({ supported: false, asset: null, downloadCommands: [], installCommands: [] });
    expect(tools.git).toEqual({ installed: true, version: "git version 2.50.0", minimumVersion: "2.31.0", supported: true });
    expect(tools.gh).toMatchObject({ installed: true, version: "gh version 2.88.0 (fixture)" });
    expect(fixture.calls).toHaveLength(8);
    expect(tools.gh.attachments).toEqual({
      "pr.create": true,
      "pr.edit": true,
      "pr.comment": false,
      "issue.create": true,
      "issue.edit": true,
      "issue.comment": false,
    });
    expect(fixture.calls).toContain("gh pr create --help");
    expect(fixture.calls).toContain("gh issue comment --help");
    expect(fixture.calls.some((call) => /auth|api|repo view/.test(call))).toBe(false);
  });

  it("requires Git and gh but ignores absent optional AI tools while AI is disabled", async () => {
    const fixture = await setup({ gh: false });
    const result = await doctor(fixture);
    expect(result.exitCode).toBe(1);
    const installation = result.output.installation as ReturnType<typeof getInstallationGuidance>;
    expect(installation.dependencies.gh.url).toContain("github.com/cli/cli");
    expect(installation.dependencies.git.url).toContain("git-scm.com");
    expect(installation.nextChecks).toContain("ggh config doctor");
    expect(result.output.problems).toEqual([
      "GitHub CLI (gh) was not found on PATH. Install it to use GitHub features such as pull requests and issues.",
    ]);
  });

  it("reports missing Git, gh, and the selected AI provider when AI is enabled", async () => {
    const fixture = await setup({ git: false, gh: false });
    const result = await doctor(fixture, { aiEnabled: true });
    expect(result.exitCode).toBe(1);
    expect(result.output.problems).toEqual([
      "Git is required but was not found on PATH. Install Git before using Good-GH-CLI.",
      "GitHub CLI (gh) was not found on PATH. Install it to use GitHub features such as pull requests and issues.",
      "AI is enabled, but configured provider 'codex' CLI is not installed.",
    ]);
  });

  it("does not change config or project files when --fix runs under dry-run", async () => {
    const fixture = await setup({ git: false, gh: false });
    const projectPath = join(fixture.root, ".ggh.json");
    const beforeProject = JSON.stringify({ invalid_key: true });
    await writeFile(projectPath, beforeProject);
    const result = await doctor(fixture, { fix: true, dryRun: true });
    expect(result.output).toEqual({ action: "doctor", dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(await readFile(projectPath, "utf8")).toBe(beforeProject);
    expect(await readFile(join(fixture.root, "good-gh", "config.json"), "utf8")).toContain('"ai_enabled":false');
  });
});
