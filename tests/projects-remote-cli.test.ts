import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { run } from "../src/utils/exec.ts";

let root: string;
let repos: string;
beforeEach(async () => {
  root = fixtureRoot("ggh-remote-cli-"); repos = join(root, "repos"); const repo = join(repos, "example"); mkdirSync(repo, {recursive:true});
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "initial"], ["remote", "add", "origin", "https://github.com/fixture/example.git"]]) await run("git", args, {cwd:repo});
});
afterEach(() => rmSync(root, {recursive:true, force:true}));
const data = {
  r0: { defaultBranchRef:{name:"main",target:{oid:"abc1234567",statusCheckRollup:{state:"SUCCESS"}}}, isArchived:true,isFork:true,parent:{nameWithOwner:"upstream/example"},viewerPermission:"WRITE" },
  p0: {issueCount:2,nodes:[{number:7,title:"Fix CI",headRefName:"fix-ci",reviewDecision:"REVIEW_REQUIRED",commits:{nodes:[{commit:{statusCheckRollup:{state:"FAILURE"}}}]}}]},
  v0: {issueCount:1},
  viewer: {repositories:{nodes:[{nameWithOwner:"fixture/example",pushedAt:null},{nameWithOwner:"fixture/uncloned",pushedAt:null}],pageInfo:{hasNextPage:false,endCursor:null}}},
  rateLimit:{remaining:5000,resetAt:"2099-01-01T00:00:00.000Z",cost:2},
};
function cli(args: string[], invoke?: string) { return runFixture(args, {root,config:{project_roots:[repos],host_worktree_dirs:{}},responses:[{prefix:["api","graphql"],stdout:JSON.stringify({data})}],invoke}); }
it("adds remote fields to bare, projects, JSON and agent calls without writing to GitHub", async () => {
  for (const args of [["--remote","--json"],["projects","--remote","--agent"],["projects","example","--remote","--json"]]) {
    const receipt = await cli(args);
    expect(receipt.exitCode,receipt.stderr).toBe(0);
    expect(receipt.stdout.trim().split("\n")).toHaveLength(1);
    const json = JSON.parse(receipt.stdout); const result = json.result ?? json;
    const project = result.project ?? result.projects[0];
    expect(project.remote[0]).toMatchObject({repo:{host:"github.com",owner:"fixture",name:"example"},authored:{state:"ok",value:{count:2,pullRequests:[{number:7}]}},defaultCi:{state:"ok",value:"SUCCESS"}});
    expect(result.remote).toMatchObject({requests:1,cost:2,uncloned:[]});
    expect(receipt.calls.filter(call => call[0] !== "auth")).toHaveLength(1);
    expect(receipt.inputs[0]?.text).toContain("query");
    expect(receipt.inputs[0]?.text).not.toContain("mutation");
  }
});
it("renders authored PRs, default CI, archive and fork parent in context cards", async () => {
  const receipt = await cli(["projects","example","--remote","--wide"]);
  expect(receipt.exitCode,receipt.stderr).toBe(0);
  for (const text of ["#7 Fix CI", "CI: SUCCESS", "Fork: upstream/example", "Authored PRs: 2", "Review requested: 1", "Archived"]) expect(receipt.stderr).toContain(text);
});
it("makes --uncloned imply --remote and excludes the local clone", async () => {
  const receipt = await cli(["--uncloned","--agent"]);
  expect(receipt.exitCode,receipt.stderr).toBe(0);
  const result = JSON.parse(receipt.stdout).result;
  expect(result.remote).toMatchObject({requests:2,cost:4,uncloned:[{count:{state:"ok",value:1},repositories:{state:"ok",value:[{nameWithOwner:"fixture/uncloned"}]}}]});
});
it("renders local rows before starting auth or GraphQL even with no status cache", async () => {
  const entry = new URL("../src/index.ts", import.meta.url).href;
  for (const query of [[],["example"]]) {
    const receipt = await cli([], `
      Object.defineProperty(process.stdout,'isTTY',{value:true});
      Object.defineProperty(process.stderr,'isTTY',{value:true});
      Object.defineProperty(process.stderr,'rows',{value:60});
      const write = process.stderr.write.bind(process.stderr); let output='';
      process.stderr.write = (chunk,...args) => {output+=String(chunk); return write(chunk,...args)};
      const spawn = Bun.spawn.bind(Bun);
      Bun.spawn = (argv,options) => {
        if (argv[0] === 'gh' && (!output.includes('example') || !output.includes('main'))) throw new Error('remote started before local output');
        return spawn(argv,options);
      };
      const {runCli} = await import(${JSON.stringify(entry)});
      await runCli(['bun','ggh','projects',...${JSON.stringify(query)},'--remote','--wide']);
    `);
    expect(receipt.exitCode,receipt.stderr).toBe(0);
    expect(receipt.stderr).toContain("pending");
    expect(receipt.stderr).toContain(query.length ? "Authored PRs: 2" : "PR 2 ✗");
    const refreshed = receipt.stderr.slice(receipt.stderr.indexOf("\x1b["));
    expect(refreshed).not.toContain("pending");
  }
});
it("advertises remote options and FieldState results in ggh agent schema", async () => {
  const receipt = await cli(["agent","schema"]);
  expect(receipt.exitCode,receipt.stderr).toBe(0);
  const schema = JSON.parse(receipt.stdout);
  const inputs = schema.inputs.find((input: {path:string[]})=>input.path.join(" ") === "projects");
  expect(inputs.options.map((option:{long:string})=>option.long)).toEqual(expect.arrayContaining(["--remote","--refresh","--uncloned"]));
  const project = schema.coreResultSchemas.projects.schema.properties.projects.items;
  expect(project.properties.remote.items.properties.authored.oneOf[0].properties.value.properties.pullRequests.maxItems).toBe(3);
  expect(project.properties.remote.items.properties.defaultCi.oneOf.some((option:{properties:{state:{const:string}}})=>option.properties.state.const === "unavailable")).toBe(true);
});
