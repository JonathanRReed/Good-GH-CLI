import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("src/index.ts");

describe("Git compatibility boundary", () => {
  for (const noRecords of [false, true]) {
    it(`rejects Git 2.30 before commit effects, records disabled: ${noRecords}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ggh-old-git-"));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_|GITHUB_|GGH_)/.test(key)));
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-gitconfig"), GIT_TERMINAL_PROMPT: "0", GGH_NO_PLUGINS: "1" });
      const git = async (...args: string[]) => {
        const child = Bun.spawn(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
        const [output, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, `git ${args.join(" ")} failed in ${root}: ${stderr.trim()}`).toBe(0);
        return output;
      };
      try {
        await writeFile(join(root, "empty-gitconfig"), "");
        await git("init", "-q");
        await git("config", "user.name", "Fixture");
        await git("config", "user.email", "fixture@example.com");
        await git("config", "commit.gpgsign", "false");
        await git("config", "core.autocrlf", "false");
        await writeFile(join(root, "file.txt"), "base\n");
        await git("add", ".");
        await git("commit", "-qm", "base");
        await writeFile(join(root, "file.txt"), "staged\n");
        await git("add", ".");
        await writeFile(join(root, "file.txt"), "unstaged\n");
        const before = { head: await git("rev-parse", "HEAD"), index: await readFile(join(root, ".git/index")), entries: await readdir(join(root, ".git")) };
        const script = `const spawn = Bun.spawn; Bun.spawn = ((cmd, options) => Array.isArray(cmd) && cmd[0] === 'git' && cmd[1] === '--version' ? spawn([process.execPath, '-e', 'console.log("git version 2.30.0")'], options) : spawn(cmd, options)); const {runCli} = await import(${JSON.stringify(cli)}); await runCli(['bun','ggh','commit','--all','--message','must not commit','--agent']);`;
        const child = Bun.spawn([process.execPath, "-e", script], { cwd: root, env: { ...env, GGH_AI_ENABLED: "false", GGH_NO_RECORDS: noRecords ? "1" : "0", XDG_CONFIG_HOME: join(root, "config") }, stdout: "pipe", stderr: "pipe" });
        const output = await new Response(child.stdout).text();
        await new Response(child.stderr).text();
        expect(await child.exited).toBe(1);
        expect(JSON.parse(output)).toMatchObject({ status: "failed", error: { code: "provider_unavailable" }, effects: { completed: [], pending: [], uncertain: [] } });
        expect(output).toContain("2.31.0");
        expect(await git("rev-parse", "HEAD")).toBe(before.head);
        expect(await readFile(join(root, ".git/index"))).toEqual(before.index);
        expect(await readFile(join(root, "file.txt"), "utf8")).toBe("unstaged\n");
        expect(await readdir(join(root, ".git"))).toEqual(before.entries);
        expect((await readdir(root)).sort()).toEqual([".git", "empty-gitconfig", "file.txt"]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});
