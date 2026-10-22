import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { remoteBatchQuery, remoteRepoKey } from "../src/services/projects/remote.ts";
import type { IndexedClone, RemoteRepoId } from "../src/services/projects/types.ts";
import type { RemoteResult } from "../src/services/projects/remote-types.ts";

let root: string;
beforeEach(() => { root = fixtureRoot("ggh-project-remote-"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function repo(index: number, host = "github.com"): RemoteRepoId { return { host, owner: "fixture", name: `repo-${index}` }; }
function clones(count: number, host = "github.com"): IndexedClone[] {
  return Array.from({ length: count }, (_, index) => ({ commonDir: `/repo/${index}/.git`, displayName: `repo-${index}`, primary: repo(index, host), remotes: [], checkouts: [], sources: [], lastSeen: "2026-10-22T00:00:00.000Z" }));
}
interface Receipt { result: RemoteResult; calls: string[][]; queries: string[]; results?: RemoteResult[]; maxActive: number }
async function service(input: IndexedClone[], scenario = "const result = await readProjectRemotes(clones);", setup = ""): Promise<Receipt> {
  const entry = new URL("../src/services/projects/remote.ts", import.meta.url).href;
  const run = await runFixture([], { root, invoke: `
    process.env.XDG_CACHE_HOME = process.env.HOME + '/cache';
    const {readProjectRemotes} = await import(${JSON.stringify(entry)});
    const clones = ${JSON.stringify(input)};
    let login = 'fixture', remaining = 5000, cost = 2, exitCode = 0, header = '', responseErrors = [], overrides = {}, fail = false;
    let unclonedNodes = [], nextPage = false, malformedRate = false, stall = false;
    const calls = [], queries = []; let active = 0, maxActive = 0;
    const spawn = Bun.spawn.bind(Bun);
    Bun.spawn = (argv, options) => {
      if (argv[0] !== 'gh') return spawn(argv, options);
      calls.push(argv.slice(1));
      let stdout = '';
      if (argv[1] === 'auth') {
        const host = argv[argv.indexOf('--hostname') + 1];
        stdout = JSON.stringify({hosts:{[host]:[{active:true,state:fail?'error':'success',login,host}]}});
      } else {
        if (stall) return spawn([process.execPath,'-e','await Bun.sleep(10000)'],options);
        active++; maxActive = Math.max(active, maxActive);
        const data = {};
        for (let i=0; i<25; i++) {
          data['r'+i] = {defaultBranchRef:{name:'main',target:{oid:'abc1234567',statusCheckRollup:{state:'SUCCESS'}}}, isArchived:false,isFork:false,parent:null,viewerPermission:'WRITE'};
          data['p'+i] = {issueCount:2,nodes:[{number:7,title:'Fix CI',headRefName:'fix-ci',reviewDecision:'REVIEW_REQUIRED',commits:{nodes:[{commit:{statusCheckRollup:{state:'FAILURE'}}}]}}]};
          data['v'+i] = {issueCount:1};
        }
        data.viewer = {repositories:{nodes:unclonedNodes,pageInfo:{hasNextPage:nextPage,endCursor:nextPage?'cursor':null}}};
        if (!malformedRate) data.rateLimit = {remaining,resetAt:new Date(Date.now()+3600000).toISOString(),cost};
        Object.assign(data, overrides);
        stdout = header + JSON.stringify({data,errors:responseErrors});
      }
      let text='';
      const isApi = argv[1] === 'api';
      return {pid:0,stdout:new Blob([stdout]).stream(),stderr:new Blob([]).stream(),exited:new Promise(resolve=>setTimeout(()=>{if(isApi)active--;resolve(isApi?exitCode:0)},1)),kill(){},stdin:options?.stdin === 'pipe' ? {write(chunk){text+=String(chunk)},async flush(){},async end(){queries.push(JSON.parse(text).query)}}:null};
    };
    ${setup}
    ${scenario}
    console.log(JSON.stringify({result, calls, queries, maxActive, ...(typeof results !== 'undefined' ? {results}: {})}));
  ` });
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

describe("projects remote batches", () => {
  const boundaries: [number, number][] = [[1, 1], [25, 1], [51, 3]];
  for (const [count, batches] of boundaries) it(`batches ${count} repositories into ${batches} serialized GraphQL requests`, async () => {
    const receipt = await service(clones(count));
    expect(receipt.result.requests).toBe(batches);
    expect(receipt.result.cost).toBe(batches * 2);
    expect(receipt.maxActive).toBe(1);
    expect(receipt.result.repositories).toHaveLength(count);
    expect(receipt.queries).toHaveLength(batches);
    for (const query of receipt.queries) expect((query.match(/r\d+: repository/g) ?? []).length).toBeLessThanOrEqual(25);
    expect(receipt.result.repositories[0]).toMatchObject({ login: "fixture", defaultBranch: { state: "ok", value: { name: "main", oid: "abc1234567" } }, authored: { state: "ok", value: { count: 2, pullRequests: [{ number: 7, statusCheckRollup: "FAILURE" }] } }, reviewRequested: { state: "ok", value: 1 }, defaultCi: { state: "ok", value: "SUCCESS" } });
    expect(receipt.calls.filter(call => call[0] === "api").every(call => call.slice(0, 5).join(" ") === "api graphql --hostname github.com --include")).toBe(true);
    expect(receipt.queries[0]).toContain("author:fixture");
    expect(receipt.queries[0]).toContain("review-requested:fixture");
    expect(receipt.queries[0]).toContain("rateLimit { remaining resetAt cost }");
  });
  it("deduplicates clones and remote aliases while keeping forks separate", async () => {
    const input = clones(2); const first = input[0]; const second = input[1]; if (!first || !second) throw new Error("fixture");
    second.primary = { host: "GitHub.com", owner: "FIXTURE", name: "REPO-0" };
    first.remotes = [{name:"origin",url:"",repo:repo(0)}, {name:"upstream",url:"",repo:{...repo(0),owner:"upstream"}}];
    const receipt = await service(input);
    expect(receipt.result.repositories).toHaveLength(2);
    expect(receipt.queries[0]?.match(/: repository/g)).toHaveLength(2);
    expect(receipt.result.repositories.map(remote => remoteRepoKey(remote.repo))).toContain("github.com/upstream/repo-0");
  });
  it("requests only selected fields", async () => {
    const receipt = await service(clones(1), 'const result = await readProjectRemotes(clones, {fields:["archived"]});');
    expect(receipt.queries[0]).toContain("isArchived");
    for (const field of ["search(", "defaultBranchRef", "viewerPermission", "isFork"]) expect(receipt.queries[0]).not.toContain(field);
    expect(receipt.result.repositories[0]).toHaveProperty("archived");
    expect(receipt.result.repositories[0]).not.toHaveProperty("authored");
    expect(remoteBatchQuery([repo(0)], "fixture", ["defaultCi"])).not.toContain("oid");
  });
  it("isolates hosts and logins", async () => {
    const receipt = await service([...clones(1), ...clones(1, "git.example.com")]);
    expect(receipt.result.requests).toBe(2);
    expect(receipt.calls.filter(call => call[0] === "api").map(call => call[3]).sort()).toEqual(["git.example.com", "github.com"]);
  });
  it("stops below the foreground reserve and retains successful batches", async () => {
    const receipt = await service(clones(51), undefined, "remaining = 499;");
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories.filter(repo => repo.defaultCi?.state === "ok")).toHaveLength(25);
    expect(receipt.result.repositories[25]?.defaultCi).toMatchObject({state:"unavailable",reason:"Foreground rate-limit reserve"});
    expect(receipt.result.repositories[50]?.archived?.state).toBe("unavailable");
  });
  it("persists reserve across repo sets and --refresh without crossing accounts", async () => {
    const receipt = await service(clones(26), `
      remaining = 499;
      const first = await readProjectRemotes(clones.slice(0,1));
      const second = await readProjectRemotes(clones.slice(1), {refresh:true});
      login = 'other'; remaining = 4000;
      const third = await readProjectRemotes(clones.slice(1));
      const results = [first,second,third]; const result = third;
    `);
    expect(receipt.results?.map(result => result.requests)).toEqual([1,0,1]);
    expect(receipt.results?.[1]?.repositories[0]?.permission?.state).toBe("unavailable");
    expect(receipt.results?.[2]?.repositories[0]?.login).toBe("other");
  });
  it("preserves GraphQL alias errors on a nonzero gh exit", async () => {
    const receipt = await service(clones(3), undefined, `
      exitCode = 1;
      overrides = {r1:null,r2:null};
      responseErrors = [{message:'Could not resolve repository',path:['r1']},{message:'Resource not accessible',path:['r2']}];
    `);
    expect(receipt.result.repositories[0]?.permission).toMatchObject({state:"ok",value:"WRITE"});
    expect(receipt.result.repositories[1]?.defaultBranch).toMatchObject({state:"unavailable",reason:"Could not resolve repository"});
    expect(receipt.result.repositories[2]?.authored).toMatchObject({state:"unavailable",reason:"Resource not accessible"});
  });
  it("keeps independent fields when one nested rollup fails", async () => {
    const receipt = await service(clones(1), undefined, `responseErrors = [{message:'Checks forbidden',path:['r0','defaultBranchRef','target','statusCheckRollup']}];`);
    expect(receipt.result.repositories[0]?.defaultCi).toMatchObject({state:"unavailable",reason:"Checks forbidden"});
    expect(receipt.result.repositories[0]?.defaultBranch?.state).toBe("ok");
    expect(receipt.result.repositories[0]?.archived?.state).toBe("ok");
  });
  it("honors retry headers and missing budgets without issuing another batch", async () => {
    for (const setup of ['header = "HTTP/2.0 403 Forbidden\\r\\nRetry-After: 120\\r\\n\\r\\n";', 'malformedRate = true;']) {
      const receipt = await service(clones(26), undefined, setup);
      expect(receipt.result.requests).toBe(1);
      expect(receipt.result.repositories[25]?.defaultCi?.state).toBe("unavailable");
    }
  });
  it("limits request count even when GitHub reports ample quota", async () => {
    const receipt = await service(clones(51), 'const result = await readProjectRemotes(clones, {maxBatches:1});');
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories[50]?.defaultCi).toMatchObject({state:"unavailable",reason:"Request batch cap reached"});
  });
  it("bounds each batch with a subprocess timeout", async () => {
    const receipt = await service(clones(26), 'const result = await readProjectRemotes(clones, {timeoutMs:20});', "stall = true;");
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories[0]?.defaultCi).toMatchObject({state:"unavailable"});
    const field = receipt.result.repositories[0]?.defaultCi;
    if (field?.state === "unavailable") expect(field.reason).toContain("timed out");
  });
  it("serializes simultaneous callers for one host and shares their snapshot", async () => {
    const receipt = await service(clones(26), 'const results = await Promise.all([readProjectRemotes(clones),readProjectRemotes(clones)]); const result = results[0];');
    expect(receipt.maxActive).toBe(1);
    expect(receipt.results?.map(result => result.requests).sort()).toEqual([0,2]);
  });
  it("returns unavailable auth instead of failing local results", async () => {
    const receipt = await service(clones(1), undefined, "fail = true;");
    expect(receipt.result.requests).toBe(0);
    expect(receipt.result.repositories[0]?.defaultCi).toMatchObject({state:"unavailable",reason:"GitHub authentication unavailable"});
  });
});

describe("projects remote cache and uncloned repos", () => {
  it("uses five-minute private snapshots, refresh, TTL and account scoping", async () => {
    const receipt = await service(clones(1), `
      const first = await readProjectRemotes(clones);
      const second = await readProjectRemotes(clones);
      const refreshed = await readProjectRemotes(clones, {refresh:true});
      const realNow = Date.now;
      Date.now = () => realNow() + 5*60_000 + 1;
      const expired = await readProjectRemotes(clones);
      Date.now = realNow;
      login = 'other'; const other = await readProjectRemotes(clones);
      const results = [first,second,refreshed,expired,other]; const result = other;
      const fs = await import('node:fs');
      if (process.platform !== 'win32') {
        const directory = process.env.XDG_CACHE_HOME + '/good-gh';
        if ((fs.statSync(directory).mode & 0o777) !== 0o700) throw new Error('shared cache directory');
        for (const name of fs.readdirSync(directory)) if ((fs.statSync(directory+'/'+name).mode & 0o777) !== 0o600) throw new Error('shared cache file');
      }
    `);
    expect(receipt.results?.map(result => result.requests)).toEqual([1,0,1,1,1]);
    expect(receipt.results?.[1]?.repositories).toEqual(receipt.results?.[0]?.repositories);
    expect(receipt.results?.[4]?.repositories[0]?.login).toBe("other");
  });
  it("does not reuse stored results with environment credentials", async () => {
    const receipt = await service(clones(1), `
      await readProjectRemotes(clones);
      process.env.GH_TOKEN = 'fixture-only';
      const result = await readProjectRemotes(clones);
    `);
    expect(receipt.result.requests).toBe(1);
  });
  it("finds uncloned owned repos, excludes every local remote and caps top repos at ten", async () => {
    const receipt = await service(clones(1), 'const result = await readProjectRemotes(clones, {uncloned:true});', `
      unclonedNodes = Array.from({length:15},(_,i)=>({nameWithOwner:'fixture/repo-'+i,pushedAt:new Date(Date.UTC(2026,9,22,0,i)).toISOString()}));
    `);
    const uncloned = receipt.result.uncloned[0];
    expect(uncloned).toMatchObject({complete:true,scanned:15,count:{state:"ok",value:14}});
    expect(uncloned?.repositories.state).toBe("ok");
    if (uncloned?.repositories.state === "ok") {
      expect(uncloned.repositories.value).toHaveLength(10);
      expect(uncloned.repositories.value[0]?.nameWithOwner).toBe("fixture/repo-14");
      expect(uncloned.repositories.value.some(repo=>repo.nameWithOwner === "fixture/repo-0")).toBe(false);
    }
    expect(receipt.queries[1]).toContain("ownerAffiliations: [OWNER]");
    expect(receipt.queries[1]).toContain("PUSHED_AT");
    expect(receipt.result.requests).toBe(2);
  });
  it("marks counts unavailable when owned-repository pagination is capped", async () => {
    const receipt = await service([], 'const result = await readProjectRemotes(clones, {uncloned:true,maxUnclonedPages:2});', `nextPage = true; unclonedNodes = [{nameWithOwner:'fixture/new',pushedAt:null}];`);
    expect(receipt.result.uncloned[0]).toMatchObject({complete:false,scanned:2,count:{state:"unavailable",reason:"Uncloned repository page cap reached"}});
    expect(receipt.queries[1]).toContain('after: "cursor"');
    expect(receipt.result.requests).toBe(2);
  });
  it("does not enumerate remote-only repos without --uncloned", async () => {
    const receipt = await service(clones(1));
    expect(receipt.queries.some(query=>query.includes("viewer { repositories"))).toBe(false);
    expect(receipt.result.uncloned).toEqual([]);
  });
});
