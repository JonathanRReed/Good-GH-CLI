import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellInit } from "../src/commands/init.ts";
import { createProjectsFixture, measureProjects } from "../scripts/bench-projects.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { commandExists, run } from "../src/utils/exec.ts";
import { quoteShellArgument } from "../src/utils/command-args.ts";

let root: string;
let repos: string;
beforeEach(() => { root = fixtureRoot("ggh-project-cli-"); repos = join(root, "repos"); mkdirSync(repos); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function repo(name: string) {
  const path = join(repos, name); mkdirSync(path, { recursive: true });
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "initial"]]) await run("git", args, { cwd: path });
  return path;
}
function cli(args: string[]) { return runFixture(args, { root, config: { project_roots: [repos], host_worktree_dirs: {} } }); }

describe("projects entry point", () => {
  it("bare ggh lists projects with diagnostics only on stderr", async () => {
    await repo("example"); const result = await cli([]);
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("example"); expect(result.stderr).toContain("main"); expect(result.stderr).not.toContain("Usage:"); expect(result.calls).toEqual([]); expect(result.providerCalls).toEqual([]);
  });
  it("keeps explicit help and exposes versioned compact JSON/agent projects", async () => {
    await repo("example");
    for (const args of [["--json"], ["projects", "--json"], ["--agent"], ["projects", "--agent"], ["--wide", "--json"]]) {
      const result = await cli(args); expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(1); expect(result.stdout).not.toContain("\n  ");
      const value = JSON.parse(result.stdout); const payload = args.includes("--agent") ? value.result : value;
      expect(payload).toMatchObject({ schemaVersion: 1, projects: [{ name: "example", checkouts: [{ branch: "main" }], stashes: { state: "ok", value: 0 } }] });
      expect(result.calls).toEqual([]); expect(result.providerCalls).toEqual([]);
      if (args.includes("--agent")) expect(value).toMatchObject({ contract: "ggh.agent", command: ["projects"], status: "succeeded" });
    }
    for (const args of [["--help"], ["-h"], ["help"]]) { const result = await cli(args); expect(result.exitCode).toBe(0); expect(result.stdout).toContain("Usage:"); }
  });
  it("prints a context card with history and independently typed fields", async () => {
    await repo("context");
    const result = await cli(["projects", "context", "--agent"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { schemaVersion: 1, project: { name: "context", unpublished: { state: "ok", value: [{ ref: "refs/heads/main", commits: 1 }] } }, history: { recent: { state: "ok", value: [{ subject: "initial" }] } } } });
    const human = await cli(["projects", "context"]); expect(human.stdout).toBe(""); expect(human.stderr).toContain("Recent commits"); expect(human.stderr).toContain("initial");
  });
  it("registers the projects result schema and all roots command paths", async () => {
    const result = await cli(["agent", "schema"]); const schema = JSON.parse(result.stdout);
    expect(schema.supportedCommandPaths).toContainEqual(["projects", "roots", "add"]);
    expect(schema.coreResultSchemas.projects.schema.properties.schemaVersion).toEqual({ const: 1 });
    expect(schema.coreResultSchemas.projects.schema.properties.projects.items.properties.checkouts.items.properties.dirty.oneOf[0].required).toContain("observedAt");
  });
  it("edits roots, excludes and registrations through actual subcommands", async () => {
    const path = await repo("outer"); const nested = await repo("outer/nested");
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const result = await runFixture([], { root, invoke: `
      const { runCli } = await import(${JSON.stringify(entry)});
      await runCli(['bun','ggh','projects','roots','add',${JSON.stringify(repos)},'--json']);
      await runCli(['bun','ggh','projects','roots','list','--json']);
      await runCli(['bun','ggh','projects','register',${JSON.stringify(nested)},'--json']);
      await runCli(['bun','ggh','projects','exclude',${JSON.stringify(path)},'--json']);
      await runCli(['bun','ggh','projects','roots','remove',${JSON.stringify(repos)},'--json']);
    ` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([{ schemaVersion: 1, roots: [repos] }, { schemaVersion: 1, roots: [repos] }, { schemaVersion: 1, registered: nested }, { schemaVersion: 1, excluded: path }, { schemaVersion: 1, roots: [] }]);
  });
});

describe("go resolution and output", () => {
  it("resolves exact names, owner/path and fuzzy queries; stdout carries only a path", async () => {
    const path = await repo("Good-GH");
    for (const query of ["Good-GH", "gdgh", path]) {
      const result = await cli(["go", query]); expect(result.exitCode).toBe(0); expect(result.stdout).toBe(`${path}\n`); expect(result.stderr).toContain("Good-GH");
    }
    const printed = await cli(["go", "Good-GH", "--print"]); expect(printed.stdout).toBe(`${path}\n`); expect(printed.stderr).toBe("");
    const agent = await cli(["go", "Good-GH", "--agent"]); expect(JSON.parse(agent.stdout)).toMatchObject({ result: { schemaVersion: 1, path, target: "cd" } });
  });
  it("returns candidates and exits nonzero for identical basenames", async () => {
    const a = await repo("a/same"); const b = await repo("b/same");
    for (const flags of [[], ["--json"], ["--agent"]]) {
      const result = await cli(["go", "same", ...flags]); expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout); const payload = flags.includes("--agent") ? data.result : data;
      expect(payload.candidates).toHaveLength(2); expect(payload.candidates.flatMap((candidate: { paths: string[] }) => candidate.paths).sort()).toEqual([a, b]);
    }
    const exact = await cli(["go", b, "--print"]); expect(exact.exitCode).toBe(0); expect(exact.stdout).toBe(`${b}\n`);
  });
  it("never clones on a miss and returns an explicit clone suggestion", async () => {
    const result = await cli(["go", "owner/missing", "--json"]); expect(result.exitCode).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ candidates: [], suggestion: ["ggh", "clone", "owner/missing"] }); expect(result.calls).toEqual([]); expect(existsSync(join(repos, "missing"))).toBe(false);
  });
  it("preserves spaces, shell syntax and trailing newlines in its shell path protocol", async () => {
    if (process.platform === "win32") return;
    const path = await repo("-space ' $(touch PWN)\n\n");
    const result = await cli(["go", "--print", "--shell", "--", path]);
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(`${path}/.\n`); expect(result.stderr).toBe(""); expect(existsSync(join(root, "PWN"))).toBe(false);
  });
  it("uses an installed t3 CLI with a literal checkout path", async () => {
    if (process.platform === "win32") return;
    const path = await repo("t3-project"); const bin = join(root, "bin"); mkdirSync(bin); const trace = join(root, "t3.json"); const executable = join(bin, "t3");
    writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2)));\n`); chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      const result = await cli(["go", "t3-project", "--t3"]);
      expect(result.exitCode, result.stderr).toBe(0); expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual([path]); expect(result.stdout).toBe(`${path}\n`);
    } finally { process.env.PATH = previousPath; }
  });
  it("opens the configured editor with literal argv and no shell expansion", async () => {
    if (process.platform === "win32") return;
    const path = await repo("editor"); const editor = join(root, "editor tool"); const trace = join(root, "editor.json");
    writeFileSync(editor, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)));\n`); chmodSync(editor, 0o700);
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const result = await runFixture([], { root, config: { project_roots: [repos], host_worktree_dirs: {} }, invoke: `process.env.VISUAL=${JSON.stringify(`${quoteShellArgument(editor)} --wait`)}; const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh','go','editor','--editor']);` });
    expect(result.exitCode).toBe(0); expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual(["--wait", path]);
  });
});

describe("agent mutation effects", () => {
  it("reports roots and index writes, resets between invocations, and leaves dry runs untouched", async () => {
    const path = await repo("effects");
    const commands = [
      ["projects", "roots", "add", repos], ["projects", "roots", "list"],
      ["projects", "register", path], ["projects", "forget", path],
      ["projects", "exclude", path], ["projects", "roots", "remove", repos],
    ];
    const result = await runFixture([], { root, invoke: `
      const {runCli} = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
      for (const args of ${JSON.stringify(commands)}) await runCli(['bun','ggh',...args,'--agent']);
    ` });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line).effects.completed)).toEqual([
      ["projects_roots_updated"], [], ["projects_index_updated"], ["projects_index_updated"],
      // forget already removed the path, so exclude changes only the exclusion list.
      ["projects_exclusions_updated"], ["projects_roots_updated"],
    ]);
    for (const args of commands.filter(args => args.at(-1) !== "list")) {
      const dry = await cli([...args, "--agent", "--dry-run"]);
      expect(dry.exitCode).toBe(1);
      expect(JSON.parse(dry.stdout)).toMatchObject({ error: { code: "invalid_arguments" }, effects: { completed: [] } });
    }
  });

  for (const target of ["editor", "t3"]) it(`reports ${target} launches`, async () => {
    const path = await repo(target);
    const result = await runFixture([], { root, config: { project_roots: [repos], host_worktree_dirs: {} }, invoke: `
      process.env.VISUAL = 'ggh-fixture-editor';
      const spawn = Bun.spawn;
      const launches = [];
      Bun.spawn = (argv, options) => {
        if (['ggh-fixture-editor','t3'].includes(argv[0])) {
          launches.push(argv);
          return {pid:0,stdout:new Blob([]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null};
        }
        return spawn(argv,options);
      };
      // Discover a t3 CLI without relying on the machine's installed tools.
      const {mock} = await import('bun:test');
      const exec = await import(${JSON.stringify(new URL("../src/utils/exec.ts", import.meta.url).href)});
      mock.module(${JSON.stringify(fileURLToPath(new URL("../src/utils/exec.ts", import.meta.url)))}, () => ({...exec, commandExists: command => command === 't3'}));
      const {runCli} = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
      await runCli(['bun','ggh','go',${JSON.stringify(path)},'--${target}','--agent']);
      console.log(JSON.stringify(launches));
    ` });
    expect(result.exitCode, result.stderr).toBe(0);
    const [opened, launches] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(opened.effects.completed).toEqual(["projects_index_updated", `${target}_opened`]);
    expect(launches).toEqual([[target === "editor" ? "ggh-fixture-editor" : "t3", path]]);
  });
});

describe("shell init", () => {
  it("generates four shells without evaluating repository strings", () => {
    for (const shell of ["bash", "zsh", "fish", "pwsh"]) {
      const text = shellInit(shell, "jump"); expect(text).toContain("jump"); expect(text).toContain("go --print --shell --"); expect(text).not.toContain("eval"); expect(text).not.toContain("Invoke-Expression");
    }
    expect(shellInit("pwsh")).toContain("Set-Location -LiteralPath $path"); expect(shellInit("fish")).toContain("string collect");
    for (const name of ["a;touch pwn", "bad-name", "ggh", "", "$(x)"]) expect(() => shellInit("bash", name)).toThrow();
    expect(() => shellInit("unsupported")).toThrow();
  });
  it("round trips hostile paths through bash and zsh and preserves command failure", async () => {
    if (process.platform === "win32") return;
    const path = join(root, "-leading ' $(touch PWN)\n\n"); mkdirSync(path);
    const mockBin = join(root, "bin"); mkdirSync(mockBin); const mock = join(mockBin, "ggh"); const trace = join(root, "argv.json");
    writeFileSync(mock, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2))); if(process.env.FAIL==='1') process.exit(7); process.stdout.write(process.env.DEST+'/.\\n');\n`); chmodSync(mock, 0o700);
    for (const shell of ["bash", "zsh"].filter(commandExists)) {
      const text = `${shellInit(shell)}\ng "$QUERY" || exit $?\nprintf '%s' "$PWD"\n`;
      const result = await run(shell, ["-c", text], { cwd: root, env: { PATH: `${mockBin}:${process.env.PATH}`, DEST: path, QUERY: "-query\nword", TRACE: trace } });
      expect(result.stdout).toBe(path); expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual(["go", "--print", "--shell", "--", "-query\nword"]);
      const failed = await run(shell, ["-c", text], { cwd: root, env: { PATH: `${mockBin}:${process.env.PATH}`, FAIL: "1", TRACE: trace }, reject: false });
      expect(failed.exitCode).toBe(7); expect(failed.stdout).toBe("");
    }
    expect(existsSync(join(root, "PWN"))).toBe(false);
  });
});

it("discovers and refreshes 70 real repositories without writing repository files", async () => {
  const fixture = await createProjectsFixture(root);
  const before = readFileSync(join(fixture, "project-000", ".git", "index"), "utf8");
  const cold = await measureProjects([fixture], join(root, "index-config"));
  const warm = await measureProjects([fixture], join(root, "index-config"));
  expect(cold.clones).toBe(70); expect(warm.checkouts).toBe(70); expect(warm.unavailableDirty).toBe(0);
  expect(readFileSync(join(fixture, "project-000", ".git", "index"), "utf8")).toBe(before);
  expect(warm.totalMs).toBeLessThan(10_000);
});
