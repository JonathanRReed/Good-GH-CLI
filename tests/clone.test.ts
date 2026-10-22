import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { clone, CloneProgress, cloneDestination, cloneTransport, httpsFallback, redactCloneCredentials } from "../src/services/git/clone.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { validateConfigValue } from "../src/services/config.ts";

const root = fixtureRoot("ggh-clone-");
const source = join(root, "source.git");
const url = pathToFileURL(source).href;
const seed = join(root, "seed");
function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}
git(["init", "-b", "main", seed]);
writeFileSync(join(seed, "README.md"), "local clone fixture\n");
git(["-C", seed, "add", "README.md"]);
git(["-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
writeFileSync(join(seed, "README.md"), "second commit\n");
git(["-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "second"]);
git(["clone", "--bare", seed, source]);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("clone destinations", () => {
  test("uses cwd, then configured root, then an explicit destination", () => {
    expect(cloneDestination("owner/repo", { cwd: root })).toBe(join(root, "repo"));
    expect(cloneDestination("owner/repo.git", { cwd: root, cloneRoot: join(root, "repos") })).toBe(join(root, "repos", "repo"));
    expect(cloneDestination("owner/repo", { cwd: root, cloneRoot: join(root, "repos"), to: "custom" })).toBe(join(root, "custom"));
    expect(cloneDestination("owner/repo", { cwd: root, cloneRoot: "~/repos" })).toBe(join(homedir(), "repos", "repo"));
  });

  test("validates clone_root as absolute or home-relative", () => {
    for (const value of [root, "~", "~/repos"]) expect(validateConfigValue("clone_root", value)).toEqual({ value });
    for (const value of ["", ".", "relative", "~someone/repos", "/bad\npath", "/bad\0path"]) expect(validateConfigValue("clone_root", value).problem).toBeDefined();
  });

  test("clones file URLs and writes local provenance", async () => {
    const destination = join(root, "marked");
    expect(await clone(url, destination)).toEqual({ alreadyCloned: false, fallbackUsed: false, protocol: "file" });
    expect(Bun.spawnSync(["git", "-C", destination, "config", "--local", "ggh.created"]).stdout.toString().trim()).toBe("true");
    const date = Bun.spawnSync(["git", "-C", destination, "config", "--local", "ggh.createdAt"]).stdout.toString().trim();
    expect(new Date(date).toISOString()).toBe(date);
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("second commit\n");
    expect(await clone(url, destination)).toMatchObject({ alreadyCloned: true });
    expect(git(["-C", destination, "config", "--local", "ggh.createdAt"])).toBe(date);
  });

  test("shallow and blobless flags still clone a local repository", async () => {
    for (const mode of ["shallow", "blobless"] as const) {
      const destination = join(root, mode);
      await clone(url, destination, mode);
      expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("second commit\n");
      if (mode === "shallow") expect(git(["-C", destination, "rev-list", "--count", "HEAD"])).toBe("1");
      else expect(git(["-C", destination, "config", "remote.origin.partialclonefilter"])).toBe("blob:none");
    }
  });

  test("requires the same remote identity, across SSH and HTTPS but including host and port", async () => {
    const destination = join(root, "identity");
    await clone(url, destination);
    await expect(clone(pathToFileURL(seed).href, destination)).rejects.toThrow("non-empty");
    git(["-C", destination, "remote", "set-url", "origin", "ssh://git@enterprise.test:2222/Owner/Repo.git"]);
    expect(await clone("https://enterprise.test:2222/owner/repo.git", destination)).toMatchObject({ alreadyCloned: true });
    await expect(clone("https://enterprise.test:3333/owner/repo.git", destination)).rejects.toThrow("non-empty");
    await expect(clone("https://different.test:2222/owner/repo.git", destination)).rejects.toThrow("non-empty");
  });

  test("refuses nonempty destinations and preserves pre-existing directories on failure", async () => {
    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep"), "mine");
    await expect(clone(url, occupied)).rejects.toThrow("non-empty");
    expect(readFileSync(join(occupied, "keep"), "utf8")).toBe("mine");
    const empty = join(root, "empty");
    mkdirSync(empty);
    await expect(clone(pathToFileURL(join(root, "missing.git")).href, empty)).rejects.toThrow();
    expect(existsSync(empty)).toBe(true);
    const created = join(root, "failed");
    await expect(clone(pathToFileURL(join(root, "missing.git")).href, created)).rejects.toThrow();
    expect(existsSync(created)).toBe(false);
  });

  test("agent clone and get expose destination, mode and already-cloned results", async () => {
    const destination = join(root, "agent");
    const result = await runFixture(["get", url, "--to", destination, "--agent"], { root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { version: 1, destination, repo: url, mode: "standard", protocol: "file", fallbackUsed: false, alreadyCloned: false } });
    const again = await runFixture(["clone", url, "--to", destination, "--agent"], { root });
    expect(JSON.parse(again.stdout)).toMatchObject({ status: "no_op", result: { alreadyCloned: true, destination } });
  });

  test("dry run resolves clone_root and --to without creating directories", async () => {
    for (const [extra, destination] of [[[], join(root, "configured", "source")], [["--to", "override"], join(root, "override")]] as const) {
      const result = await runFixture(["clone", url, "--dry-run", "--agent", ...extra], { root, config: { clone_root: join(root, "configured") } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", result: { destination } });
      expect(existsSync(destination)).toBe(false);
    }
  });

  test("--ask fails without prompting in agent mode", async () => {
    const result = await runFixture(["clone", url, "--ask", "--agent"], { root });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { message: expect.stringContaining("--to") } });
  });

  test("shows exact destination in human mode and defaults to cwd without prompting", async () => {
    const cwd = join(root, "human");
    mkdirSync(cwd);
    const result = await runFixture(["clone", url], { root, cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Destination: ${join(cwd, "source")}`);
    expect(readFileSync(join(cwd, "source", "README.md"), "utf8")).toBe("second commit\n");
  });
});

describe("clone transport", () => {
  test("redacts credentials in every diagnostic URL", () => {
    expect(redactCloneCredentials("fatal https://user:token@host/repo https://other:secret@host/x")).toBe("fatal https://***@host/repo https://***@host/x");
    const progress = new CloneProgress();
    progress.output(`fatal https://user:${"secret".repeat(1000)}`);
    progress.output("secret-tail@host/repo\nfatal: failed\n");
    progress.finish();
    expect(progress.tail.join("\n")).not.toContain("secret");
    expect(progress.tail).toContain("fatal: failed");
  });

  test("fallback requires derived SSH and an auth or host-key rejection", () => {
    const derived = cloneTransport("owner/repo", "ssh", undefined, "enterprise.test:2222");
    expect(derived.url).toBe("ssh://git@enterprise.test:2222/owner/repo.git");
    expect(httpsFallback(derived, "Permission denied (publickey).")).toBe("https://enterprise.test:2222/owner/repo.git");
    expect(httpsFallback(derived, "Host key verification failed.")).toContain("enterprise.test:2222");
    expect(httpsFallback(derived, "Connection timed out")).toBeNull();
    expect(httpsFallback(cloneTransport("git@host:owner/repo.git", "ssh"), "Permission denied (publickey)")).toBeNull();
    expect(httpsFallback(cloneTransport("owner/repo", "ssh", "ssh"), "Permission denied (publickey)")).toBeNull();
    expect(cloneTransport("ssh://git@host:2222/owner/repo.git", "ssh", "https").url).toBe("https://host:2222/owner/repo.git");
  });

  test("progress keeps four diagnostics, parses carriage returns, and resumes after stalling", () => {
    const updates: string[] = [];
    const progress = new CloneProgress(line => updates.push(line), 20_000, 0);
    progress.output("Receiving objects: 10%\rReceiving objects: 20%\r", true, 10);
    progress.tick(20_009);
    expect(updates).toHaveLength(2);
    progress.tick(20_010);
    progress.tick(21_000);
    expect(updates.filter(line => line.startsWith("stalled"))).toHaveLength(1);
    progress.output("Receiving objects: 50%\r", true, 21_001);
    progress.tick(41_001);
    expect(updates.filter(line => line.startsWith("stalled"))).toHaveLength(2);
    progress.output("first\nsecond\nthird\nfourth\nfatal https://user:secret@host/repo", true, 42_000);
    progress.finish();
    expect(progress.tail).toEqual(["second", "third", "fourth", "fatal https://***@host/repo"]);
  });
});

describe("clone discovery", () => {
  test("the interactive picker accepts fuzzy matches across source labels", async () => {
    const result = await runFixture([], { root, invoke: `
      const { searchablePicker } = await import(${JSON.stringify(join(import.meta.dir, "../src/utils/prompts.ts"))});
      const { matchCloneRepositories } = await import(${JSON.stringify(join(import.meta.dir, "../src/services/github/clone-repos.ts"))});
      Object.defineProperty(process.stdin, 'isTTY', {value:true});
      process.stdin.setRawMode = () => process.stdin;
      const pending = searchablePicker({title:'Repository',initialQuery:'pjt',items:[{value:'other/unrelated',label:'other/unrelated'},{value:'org/project',label:'org/project'}],matchesQuery:(item,query)=>matchCloneRepositories([{nameWithOwner:item.value}],query).length>0});
      process.stdin.emit('keypress','',{name:'return'});
      console.log(JSON.stringify({selected:await pending}));
    ` });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ selected: "org/project" });
  });

  test("paginates owners, organizations and stars and returns ambiguous agent candidates", async () => {
    const repos = (owner: string, count: number) => Array.from({ length: count }, (_, i) => ({ nameWithOwner: `${owner}/project${i}`, description: "sample" }));
    const result = await runFixture(["clone", "pjt", "--agent", "--refresh"], { root, responses: [
      { prefix: ["api", "user/repos?affiliation=owner&sort=updated&per_page=100&page=1"], stdout: JSON.stringify(repos("fixture", 100)) },
      { prefix: ["api", "user/repos?affiliation=owner&sort=updated&per_page=100&page=2"], stdout: JSON.stringify([{ nameWithOwner: "fixture/project-late" }]) },
      { prefix: ["api", "user/starred?per_page=100&page=1"], stdout: JSON.stringify(repos("star", 100)) },
      { prefix: ["api", "user/starred?per_page=100&page=2"], stdout: JSON.stringify([{ nameWithOwner: "star/project-late" }]) },
      { prefix: ["api", "user/orgs?per_page=100&page=1"], stdout: '["company"]' },
      { prefix: ["api", "orgs/company/repos?sort=updated&per_page=100&page=1"], stdout: JSON.stringify(repos("company", 100)) },
      { prefix: ["api", "orgs/company/repos?sort=updated&per_page=100&page=2"], stdout: JSON.stringify([{ nameWithOwner: "company/project-late" }]) },
      { prefix: ["search", "repos"], stdout: "[]" },
    ] });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("needs_input");
    expect(envelope.result.candidates).toHaveLength(303);
    for (const owner of ["fixture", "star", "company"]) expect(envelope.result.candidates).toContainEqual({ repo: `${owner}/project-late`, destination: join(root, "project-late") });
    expect(result.calls.filter(call => call[0] === "api")).toHaveLength(7);
    expect(existsSync(join(root, "project-late"))).toBe(false);
  });

  test("bounds each source at 1000 and paginates organization membership", async () => {
    const repos = Array.from({ length: 100 }, (_, i) => ({ nameWithOwner: `fixture/repo${i}` }));
    const orgs = Array.from({ length: 100 }, (_, i) => `org${i}`);
    const result = await runFixture(["clone", "--agent", "--refresh"], { root, responses: [
      { prefix: ["api", "user/orgs?per_page=100&page=1"], stdout: JSON.stringify(orgs) },
      { prefix: ["api", "user/orgs?per_page=100&page=2"], stdout: '["last"]' },
      ...["user/repos?affiliation=owner&sort=updated&", "user/starred?", "orgs/org0/repos?sort=updated&"].flatMap(endpoint => Array.from({ length: 10 }, (_, page) => ({ prefix: ["api", `${endpoint}per_page=100&page=${page + 1}`], stdout: JSON.stringify(repos) }))),
    ] });
    expect(result.exitCode).toBe(1);
    expect(result.calls.filter(call => call[0] === "api")).toHaveLength(32);
    expect(result.calls.some(call => call[1]?.includes("page=11"))).toBe(false);
  });

  test("uses an account-scoped cache, refreshes it, and separates hosts and accounts", async () => {
    const modulePath = join(import.meta.dir, "../src/services/github/clone-repos.ts");
    const result = await runFixture([], { root, responses: [
      { prefix: ["api"], stdout: "[]" },
    ], invoke: `
      const { listCloneRepositories } = await import(${JSON.stringify(modulePath)});
      const wrappedSpawn = Bun.spawn.bind(Bun);
      let login = 'first';
      Bun.spawn = (args, options) => {
        if (args[0] === 'gh' && args[1] === 'auth') {
          const host = args.at(-1);
          return { pid: 0, stdout: new Blob([JSON.stringify({hosts:{[host]:[{active:true,state:'success',login,host}]}})]).stream(), stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null };
        }
        return wrappedSpawn(args, options);
      };
      await listCloneRepositories();
      await listCloneRepositories();
      await listCloneRepositories(true);
      login = 'second';
      await listCloneRepositories();
      process.env.GH_HOST = 'enterprise.test';
      await listCloneRepositories();
    ` });
    expect(result.exitCode).toBe(0);
    expect(result.calls.filter(call => call[0] === "api")).toHaveLength(12);
  });
});

describe("clone process lifecycle", () => {
  const modulePath = join(import.meta.dir, "../src/services/git/clone.ts");

  test("a derived SSH rejection retries HTTPS once and reports the fallback", async () => {
    const destination = join(root, "fallback");
    const entry = join(import.meta.dir, "../src/index.ts");
    const result = await runFixture([], { root, responses: [
      { prefix: ["auth", "status"], stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", login: "fixture", host: "github.com", gitProtocol: "ssh" }] } }) },
    ], invoke: `
      const spawn = Bun.spawn.bind(Bun);
      const urls = [];
      Bun.spawn = (args, options) => {
        if (args[0] === 'git' && args[1] === 'clone') {
          urls.push(args.at(-2));
          if (urls.length === 1) return spawn([process.execPath, '-e', "console.error('Permission denied (publickey).'); process.exit(128);"], options);
          if (urls.length > 2) throw new Error('Unexpected extra retry');
          return spawn([...args.slice(0,-2), ${JSON.stringify(url)}, args.at(-1)], options);
        }
        return spawn(args, options);
      };
      const {runCli} = await import(${JSON.stringify(entry)});
      await runCli(['bun','ggh','clone','owner/repo','--to',${JSON.stringify(destination)},'--agent']);
      console.error(JSON.stringify(urls));
    ` });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { fallbackUsed: true, protocol: "https", destination } });
    expect(JSON.parse(result.stderr)).toEqual(["git@github.com:owner/repo.git", "https://github.com/owner/repo.git"]);
    expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("second commit\n");
  });

  test("a silent process reports stalled, resumes, and retains redacted diagnostic tail", async () => {
    const destination = join(root, "slow");
    const fake = `
      process.stderr.write('Receiving objects: 10%\\r');
      await new Promise(resolve => setTimeout(resolve, 100));
      process.stderr.write('Receiving objects: 90%\\rfirst\\nsecond\\nthird\\nfourth\\nfatal https://user:secret@host/repo\\n');
      process.exit(1);
    `;
    const result = await runFixture([], { root, invoke: `
      const { clone } = await import(${JSON.stringify(modulePath)});
      const spawn = Bun.spawn.bind(Bun);
      let command;
      let environment;
      Bun.spawn = (args, options) => {
        if (args[0] === 'git' && args[1] === 'clone') {
          command = args;
          environment = { prompt: options.env.GIT_TERMINAL_PROMPT, ssh: options.env.GIT_SSH_COMMAND, askpass: options.env.GIT_ASKPASS };
          return spawn([process.execPath, '-e', ${JSON.stringify(fake)}], options);
        }
        return spawn(args, options);
      };
      const updates = [];
      try { await clone(${JSON.stringify(url)}, ${JSON.stringify(destination)}, 'blobless', process.cwd(), {stallAfterMs:30,onProgress:line=>updates.push(line)}); }
      catch(error) { console.log(JSON.stringify({updates, message:error.message, command, environment})); }
    ` });
    const output = JSON.parse(result.stdout);
    expect(output.updates.some((line: string) => line.startsWith("stalled"))).toBe(true);
    expect(output.updates).toContain("Receiving objects: 90%");
    expect(output.message).toBe("Clone failed (exit 1).\nsecond\nthird\nfourth\nfatal https://***@host/repo");
    expect(result.stdout).not.toContain("secret");
    expect(output.command).toContain("--progress");
    expect(output.command).toContain("--filter=blob:none");
    expect(output.environment).toEqual({ prompt: "0", ssh: "ssh -o BatchMode=yes", askpass: "" });
    expect(existsSync(destination)).toBe(false);
  });

  test("cancels a process, removes only its new directory, and respects custom SSH commands", async () => {
    for (const preexisting of [false, true]) {
      const destination = join(root, preexisting ? "cancel-existing" : "cancel-new");
      if (preexisting) mkdirSync(destination);
      const result = await runFixture([], { root, invoke: `
        const { clone, cancelActiveClones } = await import(${JSON.stringify(modulePath)});
        const spawn = Bun.spawn.bind(Bun);
        process.env.GIT_SSH_COMMAND = 'ssh -F /custom/config';
        let ssh;
        Bun.spawn = (args, options) => {
          if (args[0] === 'git' && args[1] === 'clone') {
            ssh = options.env.GIT_SSH_COMMAND;
            return spawn([process.execPath, '-e', "process.stderr.write('Receiving objects: 1%\\\\r'); await new Promise(resolve => setTimeout(resolve, 60000));"], options);
          }
          return spawn(args, options);
        };
        const pending = clone(${JSON.stringify(url)}, ${JSON.stringify(destination)}, 'shallow', process.cwd(), {onProgress:()=>{void cancelActiveClones()}});
        try { await pending; } catch(error) { console.log(JSON.stringify({message:error.message,ssh})); }
      ` });
      expect(JSON.parse(result.stdout)).toEqual({ message: "Clone cancelled.", ssh: "ssh -F /custom/config" });
      expect(existsSync(destination)).toBe(preexisting);
    }
  });

  test("an aborted signal never creates a directory", async () => {
    const destination = join(root, "already-aborted");
    await expect(clone(url, destination, "standard", root, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(existsSync(destination)).toBe(false);
  });

  test("cleanup refuses a destination replaced while cloning", async () => {
    const destination = join(root, "replaced");
    const result = await runFixture([], { root, invoke: `
      const { clone } = await import(${JSON.stringify(modulePath)});
      const { renameSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const spawn = Bun.spawn.bind(Bun);
      Bun.spawn = (args, options) => {
        if (args[0] === 'git' && args[1] === 'clone') {
          return spawn([process.execPath, '-e', "process.stderr.write('Cloning fixture\\n'); setInterval(() => {}, 1000);"], options);
        }
        return spawn(args, options);
      };
      const destination = ${JSON.stringify(destination)};
      const controller = new AbortController();
      let replaced = false;
      try { await clone(${JSON.stringify(url)}, destination, 'standard', process.cwd(), {
        signal: controller.signal,
        onProgress: () => {
          if (replaced) return;
          replaced = true;
          renameSync(destination, destination + '-original');
          mkdirSync(destination);
          writeFileSync(join(destination, 'keep'), 'pre-existing replacement');
          controller.abort();
        },
      }); } catch(error) { console.log(JSON.stringify({ message: error.message, replaced })); }
    ` });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ message: "Clone cancelled.", replaced: true });
    expect(readFileSync(join(destination, "keep"), "utf8")).toBe("pre-existing replacement");
  });

  test("the executable awaits Ctrl-C cleanup and emits one cancelled agent envelope", async () => {
    const destination = join(root, "executable-cancel");
    const entry = join(import.meta.dir, "../bin/ggh.ts");
    const result = await runFixture([], { root, invoke: `
      const spawn = Bun.spawn.bind(Bun);
      Bun.spawn = (args, options) => {
        if (args[0] === 'git' && args[1] === 'clone') {
          const child = spawn([process.execPath, '-e', "await new Promise(resolve => setTimeout(resolve, 60000));"], options);
          setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
          return child;
        }
        return spawn(args, options);
      };
      process.argv = ['bun', ${JSON.stringify(entry)}, 'clone', ${JSON.stringify(url)}, '--to', ${JSON.stringify(destination)}, '--agent'];
      await import(${JSON.stringify(entry)});
    ` });
    expect(result.exitCode).toBe(130);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "cancelled", result: { destination } });
    expect(existsSync(destination)).toBe(false);
  });
});
