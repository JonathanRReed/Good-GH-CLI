import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "../cli-fixture.ts";

export function scopeFixture() {
  const root = fixtureRoot("ggh-exact-scope-");
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  const save = (path: string, bytes: string | Uint8Array) => writeFileSync(join(repo, path), bytes);
  git("init", "-b", "main"); git("config", "user.name", "Scope fixture"); git("config", "user.email", "scope@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
  save("one", "first\n\nlast\n"); save("two", "base two\n"); save(".gitignore", ".env\n");
  git("add", "--", "one", "two", ".gitignore"); git("commit", "-m", "base");
  const head = () => git("rev-parse", "HEAD");
  const tree = () => git("write-tree");
  const index = () => readFileSync(join(repo, ".git", "index"));
  const cli = (args: string[], setup = "") => runFixture([], { root, cwd: repo, config: { hosted_ai_consent: true }, invoke: `${setup}\nconst {runCli}=await import(${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)}); await runCli(['bun','ggh',...${JSON.stringify([...args, "--agent", "--no-input"])}]);` });
  const plannedTree = (files: string[]) => {
    const path = join(root, "planned-index"); writeFileSync(path, index());
    const env = { ...process.env, GIT_INDEX_FILE: path };
    execFileSync("git", ["--literal-pathspecs", "add", "--", ...files], { cwd: repo, env, stdio: "pipe" });
    return execFileSync("git", ["write-tree"], { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
  };
  const commit = (...extra: string[]) => cli(["commit", "-m", "scoped", "--yes", ...extra]);
  const hook = (body: string) => writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  const remote = (name: string) => {
    const path = join(root, name); mkdirSync(path);
    execFileSync("git", ["init", "--bare", "-b", "main", path], { stdio: "pipe" }); git("remote", "add", name, path);
    return (...args: string[]) => execFileSync("git", ["--git-dir", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  };
  // A deterministic provider boundary, without provider processes or network.
  const split = (groups: string[][], interrupt = false) => {
    const plan = { commits: groups.map((files, i) => ({ subject: `part ${i + 1}`, body: "", files })) };
    return cli(["commit", "--branch", "fixture-split", "--split", "--provider", "codex", "--ai", "--yes"], `
      const {writeFileSync}=await import('node:fs');
      const spawn=Bun.spawn.bind(Bun); const which=Bun.which.bind(Bun);
      Bun.which=(name,...args)=>name==='codex'?process.execPath:which(name,...args);
      Bun.spawn=(argv,options)=>{
        if(argv[0]!=='codex') return spawn(argv,options);
        if(argv[1]==='exec') writeFileSync(argv[argv.indexOf('-o')+1],${JSON.stringify(JSON.stringify(plan))});
        return {pid:0,stdout:new Blob([argv[1]==='login'?'Logged in':'']).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null};
      };
      ${interrupt ? `const activeSpawn=Bun.spawn.bind(Bun);let commits=0;Bun.spawn=(argv,options)=>{if(argv[0]==='git'&&argv[1]==='commit'&&++commits===2)process.kill(process.pid,'SIGKILL');return activeSpawn(argv,options);};` : ""}`);
  };
  const race = (mutation: string) => `
    const {execFileSync}=await import('node:child_process');
    const spawn=Bun.spawn.bind(Bun);let changed=false;
    Bun.spawn=(argv,options)=>{
      if(!changed && argv[0]==='git' && argv[1]==='log') { changed=true; ${mutation} }
      return spawn(argv,options);
    };`;
  return { root, repo, git, save, head, tree, index, cli, plannedTree, commit, hook, remote, split, race };
}
