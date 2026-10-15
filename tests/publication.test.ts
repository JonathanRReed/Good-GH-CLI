import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const roots: string[] = [];
const servicePath = join(
  import.meta.dir,
  "..",
  "src",
  "services",
  "publication.ts",
);
const execPath = join(import.meta.dir, "..", "src", "utils", "exec.ts");

function tempRoot(): string {
  const root = fixtureRoot("ggh-publication-");
  roots.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function gitOptional(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

function makeRepository(
  root: string,
  remote = "https://github.com/fixture/project.git",
): { repo: string; bare: string } {
  const repo = join(root, "nested", "checkout");
  const bare = join(root, "remote.git");
  mkdirSync(repo, { recursive: true });
  git(["init", "--initial-branch=main"], repo);
  git(["config", "user.name", "Fixture"], repo);
  git(["config", "user.email", "fixture@example.test"], repo);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "base"], repo);
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(["add", "feature.txt"], repo);
  git(["commit", "-m", "feature"], repo);
  git(["init", "--bare", bare], root);
  git(["remote", "add", "origin", remote], repo);
  return { repo, bare };
}

function serviceInvoke(body: string): string {
  return `const { preparePublication, executePublication } = await import(${JSON.stringify(servicePath)}); ${body}`;
}

function setupRewrite(bare: string): string {
  const prefix = `url.${pathToFileURL(bare).href}.insteadOf`;
  return `const { run } = await import(${JSON.stringify(execPath)}); await run('git', ['config', '--global', ${JSON.stringify(prefix)}, 'https://github.com/fixture/project.git']);`;
}

const privateRepositoryView = {
  prefix: ["repo", "view", "fixture/project", "--json", "url,isPrivate,visibility"],
  stdout: '{"url":"https://github.com/fixture/project","isPrivate":true,"visibility":"PRIVATE"}',
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("publication service", () => {
  test("infers the repository root and requires an explicit base when it is invalid", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const headBefore = git(["rev-parse", "HEAD"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      responses: [privateRepositoryView],
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr'}); const invalid = await preparePublication({kind:'pr', base:'missing'}); process.stdout.write(JSON.stringify({prepared, invalid}));`)}`,
    });
    const value = JSON.parse(result.stdout);
    expect(value.prepared.plan.kind).toBe("pr");
    expect(realpathSync(value.prepared.plan.root)).toBe(realpathSync(repo));
    expect(value.prepared.plan.head).toBe("feature");
    expect(value.prepared.plan.base).toBe("main");
    expect(value.invalid).toMatchObject({
      status: "needs_input",
      required: "base",
    });
    expect(result.calls).toHaveLength(2);
    expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
    expect(gitOptional(["--git-dir", bare, "show-ref"], rootOf(bare))).toBe("");

    const sourceCwd = rootOf(rootOf(repo));
    const relativeSource = await runFixture([], {
      root: sourceCwd,
      cwd: sourceCwd,
      responses: [privateRepositoryView],
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr',cwd:${JSON.stringify(sourceCwd)},source:'nested/checkout'}); process.stdout.write(JSON.stringify(prepared));`)}`,
    });
    const relativePrepared = JSON.parse(relativeSource.stdout);
    expect(relativePrepared.status).toBe("ready");
    expect(realpathSync(relativePrepared.plan.root)).toBe(realpathSync(repo));
  });

  test("creates an explicit Enterprise repository on its planned host", async () => {
    const root = tempRoot();
    const account = { hosts: { "github.enterprise.test": [{ active: true, state: "success", login: "fixture", host: "github.enterprise.test" }] } };
    const result = await runFixture([], {
      root,
      invoke: `const creationHosts=[]; const originalSpawn=Bun.spawn.bind(Bun); Bun.spawn=(args,options)=>{if(args[0]==='gh'&&args[1]==='repo'&&args[2]==='create')creationHosts.push(options?.env?.GH_HOST);return originalSpawn(args,options);}; ${serviceInvoke("const prepared=await preparePublication({kind:'repo',name:'github.enterprise.test/fixture/project'});const result=prepared.status==='ready'?await executePublication(prepared.plan):prepared;process.stdout.write(JSON.stringify({result,creationHosts}));")}`,
      responses: [
        { prefix: ["auth", "status"], stdout: JSON.stringify(account) },
        { prefix: ["repo", "view"], stderr: "HTTP 404: Not Found", exitCode: 1 },
        { prefix: ["repo", "create"], stdout: "https://github.enterprise.test/fixture/project\n" },
      ],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { status: "succeeded" }, creationHosts: ["github.enterprise.test"] });
  });

  test("preserves a completed push when local upstream setup fails and repairs it on retry", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const responses = [{ prefix: ["repo", "view"], stdout: JSON.stringify({ url: "https://github.com/fixture/project", isPrivate: true, visibility: "PRIVATE" }) }];
    const failUpstream = "const originalSpawn=Bun.spawn.bind(Bun);Bun.spawn=(args,options)=>args[0]==='git'&&args[1]==='branch'&&args.includes('--set-upstream-to')?{pid:2147483647,stdout:new Blob([]).stream(),stderr:new Blob(['fixture upstream failure']).stream(),exited:Promise.resolve(1),kill(){},stdin:null}:originalSpawn(args,options);";
    const first = await runFixture([], { root: repo, cwd: repo, responses,
      invoke: `${setupRewrite(bare)} ${failUpstream} ${serviceInvoke("const prepared=await preparePublication({kind:'repo'}); const result=prepared.status==='ready'?await executePublication(prepared.plan):prepared;process.stdout.write(JSON.stringify(result));")}`,
    });
    expect(JSON.parse(first.stdout)).toMatchObject({ status: "partially_completed", completed: ["push_head"], remaining: ["set_head_upstream"] });
    const published = git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], rootOf(bare));
    expect(published).toBe(git(["rev-parse", "HEAD"], repo));
    const retry = await runFixture([], { root: repo, cwd: repo, responses,
      invoke: `${setupRewrite(bare)} ${serviceInvoke("const prepared=await preparePublication({kind:'repo'}); const result=prepared.status==='ready'?await executePublication(prepared.plan):prepared;process.stdout.write(JSON.stringify(result));")}`,
    });
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "succeeded", completed: ["set_head_upstream"], remaining: [] });
    expect(git(["rev-parse", "--abbrev-ref", "@{u}"], repo)).toBe("origin/feature");
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], rootOf(bare))).toBe(published);
  });

  test("refuses credentialed remote URLs without copying secrets into output", async () => {
    for (const remote of ["https://sensitive-token@github.com/fixture/project.git", "https://github.com/fixture/project.git?token=sensitive-token"]) {
      const { repo } = makeRepository(tempRoot(), remote);
      const result = await runFixture([], { root: repo, cwd: repo, invoke: serviceInvoke("const result=await preparePublication({kind:'repo'});process.stdout.write(JSON.stringify(result));") });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", required: "repository" });
      expect(result.stdout + result.stderr).not.toContain("sensitive-token");
      expect(result.calls).toHaveLength(0);
      expect(git(["remote", "get-url", "origin"], repo)).toBe(remote);
    }
  });

  test("refuses a non-GitHub remote without changing it", async () => {
    const { repo } = makeRepository(tempRoot(), "file:///tmp/untouched.git");
    const before = git(["remote", "get-url", "origin"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const result = await preparePublication({kind:'repo',name:'project'}); process.stdout.write(JSON.stringify(result));`,
      ),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "needs_input",
      required: "repository",
    });
    expect(git(["remote", "get-url", "origin"], repo)).toBe(before);
    expect(result.calls).toHaveLength(0);
  });

  test("infers a private PR target without a remote and rejects a source path that is not a repository", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const inferred = await preparePublication({kind:'pr'}); const invalid = await preparePublication({kind:'pr',source:${JSON.stringify(join(repo, "missing"))},name:'fixture/project'}); process.stdout.write(JSON.stringify({inferred,invalid}));`)}`,
    });
    const value = JSON.parse(result.stdout);
    expect(value.inferred).toMatchObject({
      status: "ready",
      plan: {
        kind: "pr",
        host: "github.com",
        target: "fixture/checkout",
        visibility: "private",
        createRepository: true,
      },
    });
    expect(value.inferred.plan.steps.slice(0, 2)).toEqual([
      "create_repository",
      "add_remote",
    ]);
    expect(value.invalid).toMatchObject({
      status: "needs_input",
      required: "repository",
    });
  });

  test("requires a base with unique commits before preparing any push", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    git(["switch", "main"], repo);
    git(["switch", "-c", "empty"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr',base:'main'}); process.stdout.write(JSON.stringify(prepared));`)}`,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "needs_input",
      required: "branch",
    });
    expect(result.calls).toHaveLength(1);
    expect(gitOptional(["--git-dir", bare, "show-ref"], rootOf(bare))).toBe("");
  });

  test("allows an explicit new remote, but asks when several non-origin remotes are ambiguous", async () => {
    const { repo } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    git(
      ["remote", "add", "first", "https://github.com/fixture/project.git"],
      repo,
    );
    git(
      ["remote", "add", "second", "https://github.com/fixture/project.git"],
      repo,
    );
    const ambiguous = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const prepared = await preparePublication({kind:'repo',push:false}); process.stdout.write(JSON.stringify(prepared));`,
      ),
    });
    expect(JSON.parse(ambiguous.stdout)).toMatchObject({
      status: "needs_input",
      required: "repository",
    });

    const explicit = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const prepared = await preparePublication({kind:'repo',name:'fixture/project',remote:'upstream',push:false}); process.stdout.write(JSON.stringify(prepared));`,
      ),
    });
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      status: "ready",
      plan: { remote: "upstream", steps: ["create_repository", "add_remote"] },
    });
  });

  test("refuses an explicit repository name that conflicts with the selected remote", async () => {
    const { repo } = makeRepository(tempRoot());
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const prepared = await preparePublication({kind:'repo',name:'other'}); process.stdout.write(JSON.stringify(prepared));`,
      ),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "needs_input",
      required: "repository",
    });
    expect(result.calls).toHaveLength(1);
  });

  test("rejects invalid remote names before creating or attaching a repository", async () => {
    const { repo } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const optionLike = await preparePublication({kind:'repo',name:'fixture/new-repo',remote:'--mirror',push:false}); const invalidRef = await preparePublication({kind:'repo',name:'fixture/new-repo',remote:'bad name',push:false}); process.stdout.write(JSON.stringify({optionLike,invalidRef}));`,
      ),
    });
    const value = JSON.parse(result.stdout);
    expect(value.optionLike).toMatchObject({ status: "needs_input", required: "repository" });
    expect(value.invalidRef).toMatchObject({ status: "needs_input", required: "repository" });
    expect(result.calls).toHaveLength(1);
    expect(git(["remote"], repo)).toBe("");
  });

  test("uses the authenticated SSH protocol and establishes upstream after a pinned push", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    const rewrite = `url.${pathToFileURL(bare).href}.insteadOf`;
    const invoke = `const { run } = await import(${JSON.stringify(execPath)}); await run('git', ['config', '--global', ${JSON.stringify(rewrite)}, 'git@github.com:fixture/checkout.git']); ${serviceInvoke(`const prepared = await preparePublication({kind:'repo',name:'fixture/checkout'}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan) : prepared; process.stdout.write(JSON.stringify({prepared,result}));`)}`;
    const account = {
      hosts: {
        "github.com": [
          { active: true, state: "success", login: "fixture", host: "github.com", gitProtocol: "ssh" },
        ],
      },
    };
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke,
      responses: [
        { prefix: ["auth", "status"], stdout: JSON.stringify(account) },
        { prefix: ["repo", "view"], stderr: "HTTP 404: Not Found", exitCode: 1 },
        { prefix: ["repo", "create"], stdout: "https://github.com/fixture/checkout\n" },
      ],
    });
    const value = JSON.parse(result.stdout);
    expect(value.prepared.plan.remoteUrl).toBe("git@github.com:fixture/checkout.git");
    expect(value.result).toMatchObject({ status: "succeeded", completed: ["create_repository", "add_remote", "push_head"] });
    expect(git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "feature@{upstream}"], repo)).toBe("origin/feature");
    expect(git(["config", "branch.feature.remote"], repo)).toBe("origin");
    expect(git(["config", "branch.feature.merge"], repo)).toBe("refs/heads/feature");
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], rootOf(bare))).toBe(git(["rev-parse", "HEAD"], repo));
    writeFileSync(join(repo, "follow-up.txt"), "native push\n");
    git(["add", "follow-up.txt"], repo);
    git(["commit", "-m", "follow-up"], repo);
    git(["-c", `${rewrite}=git@github.com:fixture/checkout.git`, "push"], repo);
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], rootOf(bare))).toBe(git(["rev-parse", "HEAD"], repo));
  });

  test("uses the enterprise host and rejects GH_HOST or GH_REPO conflicts", async () => {
    const { repo } = makeRepository(
      tempRoot(),
      "https://github.enterprise.test/fixture/project.git",
    );
    const account = {
      hosts: {
        "github.enterprise.test": [
          {
            active: true,
            state: "success",
            login: "fixture",
            host: "github.enterprise.test",
          },
        ],
      },
    };
    const enterpriseAuth = {
      prefix: ["auth", "status"],
      stdout: JSON.stringify(account),
    };
    const enterprise = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const prepared = await preparePublication({kind:'repo',push:false}); process.stdout.write(JSON.stringify(prepared));`,
      ),
      responses: [
        enterpriseAuth,
        { prefix: ["repo", "view", "fixture/project", "--json", "url,isPrivate,visibility"], stdout: '{"url":"https://github.enterprise.test/fixture/project","isPrivate":true,"visibility":"PRIVATE"}' },
      ],
    });
    expect(JSON.parse(enterprise.stdout)).toMatchObject({
      status: "ready",
      plan: {
        host: "github.enterprise.test",
        target: "fixture/project",
        remoteUrl: "https://github.enterprise.test/fixture/project.git",
      },
    });
    expect(enterprise.calls[0]).toContain("github.enterprise.test");

    const hostMismatch = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `process.env.GH_HOST='github.com'; ${serviceInvoke(`const prepared = await preparePublication({kind:'repo',push:false}); process.stdout.write(JSON.stringify(prepared));`)}`,
      responses: [enterpriseAuth],
    });
    expect(JSON.parse(hostMismatch.stdout)).toMatchObject({
      status: "needs_input",
      required: "repository",
    });

    const repoMismatch = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `process.env.GH_REPO='other/project'; ${serviceInvoke(`const prepared = await preparePublication({kind:'repo',push:false}); process.stdout.write(JSON.stringify(prepared));`)}`,
      responses: [enterpriseAuth],
    });
    expect(JSON.parse(repoMismatch.stdout)).toMatchObject({
      status: "needs_input",
      required: "repository",
    });
  });

  test("pushes a verified fast-forward remote head", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const rewrite = `url.${pathToFileURL(bare).href}.insteadOf=https://github.com/fixture/project.git`;
    git(["-c", rewrite, "push", "origin", "main:refs/heads/main"], repo);
    git(["-c", rewrite, "push", "origin", "main:refs/heads/feature"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr'}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan,{title:'Feature',body:'Adds a feature.'}) : prepared; process.stdout.write(JSON.stringify({prepared,result}));`)}`,
      responses: [
        privateRepositoryView,
        { prefix: ["pr", "list"], stdout: "[]" },
        {
          prefix: ["pr", "create"],
          stdout: "https://github.com/fixture/project/pull/2\n",
        },
      ],
    });
    const value = JSON.parse(result.stdout);
    expect(value.prepared.plan.steps).toEqual([
      "set_base_upstream",
      "push_head",
      "create_pull_request",
    ]);
    expect(value.result).toMatchObject({
      status: "succeeded",
      url: "https://github.com/fixture/project/pull/2",
    });
    expect(
      git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], rootOf(bare)),
    ).toBe(git(["rev-parse", "HEAD"], repo));
  });

  test("reuses an existing matching pull request without trying to create another", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const rewrite = `url.${pathToFileURL(bare).href}.insteadOf=https://github.com/fixture/project.git`;
    git(["-c", rewrite, "push", "origin", "main:refs/heads/main"], repo);
    git(["-c", rewrite, "push", "origin", "feature:refs/heads/feature"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr'}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan,{title:'Feature',body:'Adds a feature.'}) : prepared; process.stdout.write(JSON.stringify(result));`)}`,
      responses: [
        privateRepositoryView,
        {
          prefix: ["pr", "list"],
          stdout: '[{"url":"https://github.com/fixture/project/pull/9"}]',
        },
      ],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      url: "https://github.com/fixture/project/pull/9",
      completed: ["set_base_upstream", "set_head_upstream", "create_pull_request"],
    });
    expect(
      result.calls.some((call) => call[0] === "pr" && call[1] === "create"),
    ).toBe(false);
    expect(
      result.calls.some((call) => call[0] === "pr" && call[1] === "list"),
    ).toBe(true);
  });

  test("returns recheck failures as structured publication results", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      responses: [privateRepositoryView],
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const { rmSync } = await import('node:fs'); const prepared = await preparePublication({kind:'pr'}); process.chdir(${JSON.stringify(rootOf(repo))}); rmSync(${JSON.stringify(repo)},{recursive:true,force:true}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan,{title:'Feature',body:'Adds a feature.'}) : prepared; process.stdout.write(JSON.stringify(result));`)}`,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      remaining: ["push_base", "push_head", "create_pull_request"],
    });
  });

  test("supports a named remote-only repository and does not treat lookup failures as missing", async () => {
    const root = tempRoot();
    const invoke = serviceInvoke(
      `const prepared = await preparePublication({kind:'repo',name:'fixture/project',description:'A fixture project',push:false}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan) : prepared; process.stdout.write(JSON.stringify(result));`,
    );
    const created = await runFixture([], {
      root,
      invoke,
      responses: [
        {
          prefix: ["repo", "view"],
          stderr: "HTTP 404: Not Found",
          exitCode: 1,
        },
        {
          prefix: ["repo", "create"],
          stdout: "https://github.com/fixture/project\n",
        },
      ],
    });
    expect(JSON.parse(created.stdout)).toMatchObject({
      status: "succeeded",
      target: "fixture/project",
      url: "https://github.com/fixture/project",
      completed: ["create_repository"],
    });
    expect(created.calls.map((call) => call.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["repo", "view"],
      ["repo", "create"],
    ]);
    expect(created.calls[2]).toContain("--description");
    expect(created.calls[2]).toContain("A fixture project");

    const failedLookup = await runFixture([], {
      root,
      invoke,
      responses: [
        { prefix: ["repo", "view"], stderr: "connection refused", exitCode: 1 },
      ],
    });
    expect(JSON.parse(failedLookup.stdout)).toMatchObject({
      status: "failed",
      completed: [],
      remaining: ["create_repository"],
    });
    expect(failedLookup.calls.map((call) => call.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["repo", "view"],
    ]);
  });

  test("requires exact visibility evidence before attaching a private or internal target", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    const invoke = serviceInvoke(
      `const prepared = await preparePublication({kind:'repo',name:'fixture/collision',visibility:'private',push:true}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan) : prepared; process.stdout.write(JSON.stringify(result));`,
    );
    const publicCollision = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke,
      responses: [
        {
          prefix: ["repo", "view"],
          stdout:
            '{"url":"https://github.com/fixture/collision","isPrivate":false,"visibility":"PUBLIC"}',
        },
      ],
    });
    expect(JSON.parse(publicCollision.stdout)).toMatchObject({
      status: "failed",
      completed: [],
      remaining: ["create_repository", "add_remote", "push_head"],
    });
    expect(git(["remote"], repo)).toBe("");
    expect(gitOptional(["--git-dir", bare, "show-ref"], rootOf(bare))).toBe("");
    expect(publicCollision.calls.map((call) => call.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["repo", "view"],
    ]);

    const unknownVisibility = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke,
      responses: [
        {
          prefix: ["repo", "view"],
          stdout: '{"url":"https://github.com/fixture/collision","isPrivate":true}',
        },
      ],
    });
    expect(JSON.parse(unknownVisibility.stdout)).toMatchObject({
      status: "failed",
      completed: [],
      remaining: ["create_repository", "add_remote", "push_head"],
    });
    expect(unknownVisibility.calls.map((call) => call.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["repo", "view"],
    ]);

    const internalCollision = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke,
      responses: [
        {
          prefix: ["repo", "view"],
          stdout:
            '{"url":"https://github.com/fixture/collision","isPrivate":true,"visibility":"INTERNAL"}',
        },
      ],
    });
    expect(JSON.parse(internalCollision.stdout)).toMatchObject({
      status: "failed",
      completed: [],
      remaining: ["create_repository", "add_remote", "push_head"],
    });
    expect(git(["remote"], repo)).toBe("");
    expect(gitOptional(["--git-dir", bare, "show-ref"], rootOf(bare))).toBe("");
  });

  test("reuses an existing private repository and accepts a .github repository name", async () => {
    const { repo } = makeRepository(tempRoot());
    git(["remote", "remove", "origin"], repo);
    const result = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: serviceInvoke(
        `const prepared = await preparePublication({kind:'repo',name:'fixture/.github',visibility:'private',push:false}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan) : prepared; process.stdout.write(JSON.stringify(result));`,
      ),
      responses: [
        {
          prefix: ["repo", "view"],
          stdout:
            '{"url":"https://github.com/fixture/.github","isPrivate":true,"visibility":"PRIVATE"}',
        },
      ],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      target: "fixture/.github",
      url: "https://github.com/fixture/.github",
      completed: ["create_repository", "add_remote"],
    });
    expect(git(["remote"], repo)).toBe("origin");
    expect(result.calls.map((call) => call.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["repo", "view"],
    ]);
  });

  test("pushes a missing base before head, then resumes safely after a partial push", async () => {
    const { repo, bare } = makeRepository(tempRoot());
    const hook = join(bare, "hooks", "pre-receive");
    const trace = join(bare, "push-order.log");
    writeFileSync(
      hook,
      `#!/bin/sh\nwhile read old new ref; do echo "$ref" >> '${trace.replace(/\\/g, "/").replace(/'/g, "'\\''")}'; case "$ref" in refs/heads/feature) exit 1;; esac; done\n`,
    );
    chmodSync(hook, 0o755);
    const invoke = `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr'}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan,{title:'Feature',body:'Adds a feature.'}) : prepared; process.stdout.write(JSON.stringify({prepared,result}));`)}`;
    const first = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke,
      responses: [privateRepositoryView],
    });
    const firstValue = JSON.parse(first.stdout);
    expect(firstValue.result).toMatchObject({ status: "partially_completed" });
    expect(firstValue.result.completed).toEqual(["push_base"]);
    rmSync(hook);
    const retry = await runFixture([], {
      root: repo,
      cwd: repo,
      invoke: `${setupRewrite(bare)} ${serviceInvoke(`const prepared = await preparePublication({kind:'pr'}); const result = prepared.status === 'ready' ? await executePublication(prepared.plan,{title:'Feature',body:'Adds a feature.'}) : prepared; process.stdout.write(JSON.stringify(result));`)}`,
      responses: [
        privateRepositoryView,
        { prefix: ["pr", "list"], stdout: "[]" },
        {
          prefix: ["pr", "create"],
          stdout: "https://github.com/fixture/project/pull/1\n",
        },
      ],
    });
    expect(JSON.parse(retry.stdout)).toMatchObject({
      status: "succeeded",
      url: "https://github.com/fixture/project/pull/1",
      completed: ["push_head", "create_pull_request"],
    });
    expect(
      git(
        ["--git-dir", bare, "show-ref", "--verify", "refs/heads/main"],
        rootOf(bare),
      ),
    ).toContain("refs/heads/main");
    expect(
      git(
        ["--git-dir", bare, "show-ref", "--verify", "refs/heads/feature"],
        rootOf(bare),
      ),
    ).toContain("refs/heads/feature");
    expect((await Bun.file(trace).text()).trim().split("\n")).toEqual([
      "refs/heads/main",
      "refs/heads/feature",
    ]);
    expect(
      git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "main@{upstream}"],
        repo,
      ),
    ).toBe("origin/main");
    expect(
      git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "feature@{upstream}"],
        repo,
      ),
    ).toBe("origin/feature");
  });
});

function rootOf(path: string): string {
  return dirname(path);
}
