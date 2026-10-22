import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSkillReference, unpackSkillReference } from "../scripts/gen-skill-reference.ts";

const repo = join(import.meta.dir, "..");
const bundled = join(repo, "skills", "ggh");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ggh-skill-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

async function cli(args: string[], entry = join(repo, "bin", "ggh.ts")) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GGH_|GH_|GITHUB_|GIT_|CODEX_HOME)/.test(key)));
  const child = Bun.spawn([process.execPath, entry, "agent", "skill", ...args], {
    cwd: home, env: { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GGH_NO_PLUGINS: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
function expectFiles(target: string) {
  for (const name of ["SKILL.md", "reference.md"]) expect(readFileSync(join(target, name), "utf8")).toBe(readFileSync(join(bundled, name), "utf8"));
}

test("skill has valid Agent Skills frontmatter, bounded length, and a local reference", () => {
  const text = readFileSync(join(bundled, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  expect(frontmatter).toBeDefined();
  expect(Bun.YAML.parse(frontmatter!)).toEqual({ name: "ggh", description: expect.any(String) });
  expect(text.split("\n").length).toBeLessThanOrEqual(150);
  expect(text).toContain("[reference.md](reference.md)");
  expect(existsSync(join(bundled, "reference.md"))).toBe(true);
});

test("generated reference matches the current CLI contract", async () => {
  const generated = await generateSkillReference();
  expect(readFileSync(join(bundled, "reference.md"), "utf8").replace(/\r\n/g, "\n")).toBe(generated);
  expect(unpackSkillReference(readFileSync(join(repo, "src", "generated", "skill-reference.ts"), "utf8"))).toBe(generated);
});

test("reference generation ignores user aliases that shadow agent", async () => {
  mkdirSync(join(home, "good-gh"));
  writeFileSync(join(home, "good-gh", "aliases.json"), JSON.stringify({ agent: "not-a-real-command" }));
  const child = Bun.spawn([process.execPath, join(repo, "scripts", "gen-skill-reference.ts"), "--check"], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "skills/ggh/reference.md is fresh.\n" });
});

test("prints exact skill Markdown or an agent envelope without writes", async () => {
  const plain = await cli([]);
  expect(plain.code).toBe(0);
  expect(plain.stderr).toBe("");
  expect(plain.stdout.trimEnd()).toBe(readFileSync(join(bundled, "SKILL.md"), "utf8").trimEnd());
  const agent = await cli(["--agent"]);
  expect(agent.code).toBe(0);
  expect(JSON.parse(agent.stdout)).toMatchObject({ contract: "ggh.agent", version: 1, command: ["agent", "skill"], status: "succeeded", result: { schemaVersion: 1, skill: readFileSync(join(bundled, "SKILL.md"), "utf8") }, effects: { completed: [], pending: [], uncertain: [] } });
  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(existsSync(join(home, ".agents"))).toBe(false);
});

for (const [host, directory] of [["claude", ".claude"], ["codex", ".agents"]]) {
  test(`installs both files for ${host} under temporary HOME and reports effects`, async () => {
    const target = join(home, directory!, "skills", "ggh");
    const result = await cli(["--install", host!, "--yes", "--agent"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectFiles(target);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { target, files: [join(target, "SKILL.md"), join(target, "reference.md")] }, effects: { completed: [`skill_directory_created:${target}`, `skill_file_written:${join(target, "SKILL.md")}`, `skill_file_written:${join(target, "reference.md")}`], pending: [], uncertain: [] } });
    const repeat = await cli(["--install", host!, "--yes", "--agent"]);
    expect(repeat.code).toBe(0);
    expect(JSON.parse(repeat.stdout)).toMatchObject({ result: { unchanged: true }, effects: { completed: [], pending: [], uncertain: [] } });
  });
}

test("explicit paths are skill directories and tilde expands within temporary HOME", async () => {
  for (const path of [join(home, "custom skills", "ggh"), "~/.codex/skills/ggh"]) {
    const result = await cli(["--install", path, "--yes", "--agent"]);
    expect(result.code).toBe(0);
    expectFiles(JSON.parse(result.stdout).result.target);
  }
});

test("T3 explains provider directories without creating a separate T3 skill store", async () => {
  const result = await cli(["--install", "t3", "--agent"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { guidance: expect.stringContaining("provider's skills directory") }, effects: { completed: [], pending: [], uncertain: [] } });
  for (const path of [".t3", ".claude", ".agents"]) expect(existsSync(join(home, path))).toBe(false);
});

test("noninteractive installation requires approval and never writes before it", async () => {
  const result = await cli(["--install", "claude", "--agent"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--yes" }], effects: { completed: [], uncertain: [] } });
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

test("dry-run with yes creates no directories or files and reports pending effects", async () => {
  const result = await cli(["--install", "claude", "--yes", "--dry-run", "--agent"]);
  expect(result.code).toBe(0);
  const target = join(home, ".claude", "skills", "ggh");
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", result: { target, writes: [join(target, "SKILL.md"), join(target, "reference.md")] }, effects: { completed: [], pending: ["command_effects"], uncertain: [] } });
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

test("differing files survive yes and a forced install still needs approval", async () => {
  const target = join(home, ".agents", "skills", "ggh");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "user skill\n");
  writeFileSync(join(target, "reference.md"), "user reference\n");
  for (const name of ["SKILL.md", "reference.md"]) {
    // Preflight checks the whole pack before writing even an earlier missing file.
    const other = name === "SKILL.md" ? "reference.md" : "SKILL.md";
    const saved = readFileSync(join(target, other));
    rmSync(join(target, other));
    const blocked = await cli(["--install", "codex", "--yes", "--agent"]);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ error: { code: "confirmation_required" }, requiredInputs: [{ name: "--force" }], effects: { completed: [] } });
    expect(existsSync(join(target, other))).toBe(false);
    writeFileSync(join(target, other), saved);
  }
  const unapproved = await cli(["--install", "codex", "--force", "--agent"]);
  expect(unapproved.code).toBe(1);
  expect(JSON.parse(unapproved.stdout)).toMatchObject({ status: "needs_input", requiredInputs: [{ name: "--yes" }], effects: { completed: [] } });
  const dry = await cli(["--install", "codex", "--force", "--yes", "--dry-run", "--agent"]);
  expect(dry.code).toBe(0);
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user skill\n");
  expect(readFileSync(join(target, "reference.md"), "utf8")).toBe("user reference\n");
  const approved = await cli(["--install", "codex", "--force", "--yes", "--agent"]);
  expect(approved.code).toBe(0);
  expectFiles(target);
});

test.skipIf(process.platform === "win32")("refuses symlinked skill files even with force", async () => {
  const target = join(home, "skills", "ggh");
  mkdirSync(target, { recursive: true });
  const outside = join(home, "keep.md");
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, join(target, "SKILL.md"));
  const result = await cli(["--install", target, "--force", "--yes", "--agent"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ effects: { completed: [] } });
  expect(readFileSync(outside, "utf8")).toBe("keep\n");
  expect(existsSync(join(target, "reference.md"))).toBe(false);
});

test("built bundle installs embedded assets without a source checkout", async () => {
  const entry = join(home, "ggh.js");
  const build = Bun.spawnSync([process.execPath, "build", join(repo, "bin", "ggh.ts"), "--target=bun", `--outfile=${entry}`], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  expect({ code: build.exitCode, error: build.stderr.toString() }).toEqual({ code: 0, error: "" });
  const result = await cli(["--install", "codex", "--yes", "--agent"], entry);
  expect(result.code).toBe(0);
  expectFiles(join(home, ".agents", "skills", "ggh"));
});
