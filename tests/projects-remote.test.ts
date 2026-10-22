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
    let fault = () => null; let searchMode = 'normal', authoredCount = 2, badCheck = null;
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
        for (let i=0; i<100; i++) {
          data['r'+i] = {defaultBranchRef:{name:'main',target:{oid:'abc1234567',statusCheckRollup:{state:'SUCCESS'}}}, isArchived:false,isFork:false,parent:null,viewerPermission:'WRITE'};
          data['p'+i] = {issueCount:2,nodes:[{number:7,title:'Fix CI',headRefName:'fix-ci',reviewDecision:'REVIEW_REQUIRED',commits:{nodes:[{commit:{statusCheckRollup:{state:'FAILURE'}}}]}}]};
          data['v'+i] = {issueCount:1};
        }
        data.viewer = {repositories:{nodes:unclonedNodes,pageInfo:{hasNextPage:nextPage,endCursor:nextPage?'cursor':null}}};
        if (!malformedRate) data.rateLimit = {remaining,resetAt:new Date(Date.now()+3600000).toISOString(),cost};
        Object.assign(data, overrides);
        stdout = header + JSON.stringify({data,errors:responseErrors});
      }
      let text=''; let send;
      const stdoutStream = argv[1] === 'api' ? new ReadableStream({start(controller){send=controller}}) : new Blob([stdout]).stream();
      let failure = null;
      const isApi = argv[1] === 'api';
      return {pid:0,stdout:stdoutStream,stderr:new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(failure ?? ''));controller.close()},1)}}),exited:new Promise(resolve=>setTimeout(()=>{if(isApi)active--;resolve(isApi && failure ? 1 : isApi?exitCode:0)},1)),kill(){},stdin:options?.stdin === 'pipe' ? {write(chunk){text+=String(chunk)},async flush(){},async end(){const query=JSON.parse(text).query; queries.push(query); failure=fault(query);
          const identities = [...new Set([...query.matchAll(/repo:([A-Za-z0-9_.\\/-]+)/g)].map(match=>match[1]))];
          const body=JSON.parse(stdout.slice(stdout.indexOf('{')));
          const nodes=identities.flatMap(name=>Array.from({length:authoredCount},(_,i)=>7+i).map(number=>({...body.data.p0.nodes[0],id:name+'#'+number,number,repository:{nameWithOwner:name}})));
          const offset = query.includes('after:') ? Number(/after: "(\\d+)"/.exec(query)?.[1] ?? 0) : 0;
          const pageNodes = nodes.slice(offset, offset+100);
          body.data.authored = {issueCount:searchMode === 'mismatch' ? nodes.length+1 : nodes.length,nodes:pageNodes,pageInfo:{hasNextPage:searchMode === 'cap' || offset+100<nodes.length,endCursor:String(offset+100)}};
          if (searchMode === 'denied') body.errors.push({message:'PR search forbidden',path:['authored']});
          body.data.reviewRequested = {issueCount:identities.length,nodes:identities.map(name=>({repository:{nameWithOwner:name}})),pageInfo:{hasNextPage:false,endCursor:null}};
          if (query.includes('nodes(ids:')) {
            const ids = JSON.parse(/nodes\\(ids: (\\[[^\\]]*\\])/.exec(query)[1]);
            body.data.nodes = ids.map(id=>id === badCheck ? null : ({...body.data.p0.nodes[0],id}));
            if (ids.includes(badCheck)) body.errors.push({message:'PR checks forbidden',path:['nodes',ids.indexOf(badCheck),'commits']});
          }
          send.enqueue(new TextEncoder().encode(header + (failure ? JSON.stringify({message:failure}) : JSON.stringify(body)))); send.close()}}:null};
    };
    ${setup}
    ${scenario}
    console.log(JSON.stringify({result, calls, queries, maxActive, ...(typeof results !== 'undefined' ? {results}: {})}));
  ` });
  expect(run.exitCode, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

describe("projects remote batches", () => {
  const boundaries: [number, number][] = [[1, 2], [10, 2], [73, 3], [101, 5], [201, 8]];
  for (const [count, batches] of boundaries) it(`batches ${count} repositories into ${batches} serialized GraphQL requests`, async () => {
    const receipt = await service(clones(count));
    expect(receipt.result.requests).toBe(batches);
    expect(receipt.result.cost).toBe(batches * 2);
    expect(receipt.maxActive).toBe(1);
    expect(receipt.result.repositories).toHaveLength(count);
    expect(receipt.queries).toHaveLength(batches);
    for (const query of receipt.queries) expect((query.match(/r\d+: repository/g) ?? []).length).toBeLessThanOrEqual(100);
    expect(receipt.result.repositories[0]).toMatchObject({ login: "fixture", defaultBranch: { state: "ok", value: { name: "main", oid: "abc1234567" } }, authored: { state: "ok", value: { count: 2, pullRequests: [{ number: 7, statusCheckRollup: "FAILURE" }, { number: 8, statusCheckRollup: "FAILURE" }] } }, reviewRequested: { state: "ok", value: 1 }, defaultCi: { state: "ok", value: "SUCCESS" } });
    expect(receipt.calls.filter(call => call[0] === "api").every(call => call.slice(0, 5).join(" ") === "api graphql --hostname github.com --include")).toBe(true);
    expect(receipt.queries[0]).toContain("author:fixture");
    expect(receipt.queries[0]).toContain("review-requested:fixture");
    expect(receipt.queries[0]).toContain("rateLimit { remaining resetAt cost }");
  });
  it("paginates grouped PR searches and keeps exact per-repo counts with only three details", async () => {
    const receipt = await service(clones(2), undefined, 'authoredCount = 120;');
    expect(receipt.result.requests).toBe(4);
    for (const repo of receipt.result.repositories) {
      expect(repo.authored?.state).toBe('ok');
      if (repo.authored?.state === 'ok') {
        expect(repo.authored.value.count).toBe(120);
        expect(repo.authored.value.pullRequests.map(pr=>pr.number)).toEqual([7,8,9]);
      }
    }
    expect(receipt.queries[1]).toContain('after: "100"');
    expect(receipt.queries[1]).not.toContain(': repository(');
  });
  for (const mode of ['cap','mismatch','denied']) it(`keeps metadata while marking ${mode} grouped search results unavailable`, async () => {
    const receipt = await service(clones(2), undefined, `searchMode = ${JSON.stringify(mode)};`);
    for (const repo of receipt.result.repositories) {
      expect(repo.authored?.state).toBe('unavailable');
      expect(repo.defaultCi?.state).toBe('ok');
      expect(repo.reviewRequested).toMatchObject({state:'ok',value:1});
    }
    expect(receipt.result.requests).toBe(mode === 'cap' ? 10 : 1);
  });
  it("isolates a failed PR check node to its repository", async () => {
    const receipt = await service(clones(2), undefined, "badCheck = 'fixture/repo-0#7';");
    expect(receipt.result.repositories[0]?.authored).toMatchObject({state:'unavailable',reason:'PR checks forbidden'});
    expect(receipt.result.repositories[1]?.authored?.state).toBe('ok');
    expect(receipt.result.repositories.every(repo=>repo.defaultCi?.state === 'ok')).toBe(true);
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
    expect(receipt.result.requests).toBe(4);
    expect([...new Set(receipt.calls.filter(call => call[0] === "api").map(call => call[3]))].sort()).toEqual(["git.example.com", "github.com"]);
  });
  it("stops below the foreground reserve and retains successful batches", async () => {
    const receipt = await service(clones(201), undefined, "remaining = 499;");
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories.filter(repo => repo.defaultCi?.state === "ok")).toHaveLength(100);
    expect(receipt.result.repositories[100]?.defaultCi).toMatchObject({state:"unavailable",reason:"Foreground rate-limit reserve"});
    expect(receipt.result.repositories[200]?.archived?.state).toBe("unavailable");
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
    expect(receipt.results?.map(result => result.requests)).toEqual([1,0,2]);
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
      const receipt = await service(clones(101), undefined, setup);
      expect(receipt.result.requests).toBe(1);
      expect(receipt.result.repositories[100]?.defaultCi?.state).toBe("unavailable");
    }
  });
  it("limits request count even when GitHub reports ample quota", async () => {
    const receipt = await service(clones(201), 'const result = await readProjectRemotes(clones, {maxBatches:1});');
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories[200]?.defaultCi).toMatchObject({state:"unavailable",reason:"Request batch cap reached"});
  });
  it("bounds each batch with a subprocess timeout", async () => {
    const receipt = await service(clones(26), 'const result = await readProjectRemotes(clones, {timeoutMs:20});', "stall = true;");
    expect(receipt.result.requests).toBeGreaterThan(26);
    expect(receipt.result.repositories[0]?.defaultCi).toMatchObject({state:"unavailable"});
    const field = receipt.result.repositories[0]?.defaultCi;
    if (field?.state === "unavailable") expect(field.reason).toContain("timed out");
  });
  for (const failure of ["gh api graphql timed out", "HTTP 502 Bad Gateway", "Something went wrong while executing your query"]) it(`bisects ${failure} and continues after an isolated bad repo`, async () => {
    const receipt = await service(clones(121), undefined, `fault = query => query.includes('name: "repo-0"') ? ${JSON.stringify(failure)} : null;`);
    expect(receipt.result.repositories.filter(repo => repo.defaultCi?.state === "ok")).toHaveLength(120);
    expect(receipt.result.repositories.find(repo => repo.repo.name === "repo-0")?.defaultCi).toMatchObject({state:"unavailable",reason:failure});
    expect(receipt.result.requests).toBeGreaterThan(3);
  });
  it("bisects an HTTP 502 JSON body whose message omits the status code", async () => {
    const receipt = await service(clones(3), undefined, `fault = query => { header = query.includes('name: "repo-0"') ? 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n' : ''; return header ? 'Bad Gateway' : null; };`);
    expect(receipt.result.repositories.filter(repo=>repo.defaultCi?.state === 'ok')).toHaveLength(2);
    expect(receipt.result.repositories[0]?.defaultCi).toMatchObject({state:'unavailable',reason:'HTTP 502: Bad Gateway'});
  });
  it("bounds in-flight requests and remaining batches by the overall deadline", async () => {
    const started = performance.now();
    const receipt = await service(clones(21), 'const result = await readProjectRemotes(clones, {deadlineMs:80,timeoutMs:1000});', 'stall = true;');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(receipt.result.requests).toBe(1);
    expect(receipt.result.repositories).toHaveLength(21);
    for (const repo of receipt.result.repositories) expect(repo.defaultCi).toMatchObject({state:"unavailable",reason:"deadline"});
  });
  it("serializes simultaneous callers for one host and shares their snapshot", async () => {
    const receipt = await service(clones(26), 'const results = await Promise.all([readProjectRemotes(clones),readProjectRemotes(clones)]); const result = results[0];');
    expect(receipt.maxActive).toBe(1);
    expect(receipt.results?.map(result => result.requests).sort()).toEqual([0,2]);
  });
  it("respects the reserve when a transient failure triggers bisection", async () => {
    const receipt = await service(clones(2), undefined, `remaining = 499; responseErrors = [{message:'Something went wrong',path:[]}];`);
    expect(receipt.result.requests).toBe(1);
    for (const repo of receipt.result.repositories) expect(repo.defaultCi).toMatchObject({state:'unavailable',reason:'Foreground rate-limit reserve'});
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
    expect(receipt.results?.map(result => result.requests)).toEqual([2,0,2,2,2]);
    expect(receipt.results?.[1]?.repositories).toEqual(receipt.results?.[0]?.repositories);
    expect(receipt.results?.[4]?.repositories[0]?.login).toBe("other");
  });
  it("reuses successful repos across sets and field selections without caching failures", async () => {
    const receipt = await service(clones(3), `
      overrides = {r1:null}; responseErrors = [{message:'Inaccessible',path:['r1']}];
      const first = await readProjectRemotes(clones.slice(0,2));
      overrides = {}; responseErrors = [];
      const second = await readProjectRemotes(clones);
      const third = await readProjectRemotes(clones.slice(1), {fields:['archived']});
      const results = [first,second,third]; const result = second;
    `);
    expect(receipt.results?.map(result=>result.requests)).toEqual([2,2,0]);
    expect(receipt.queries[2]).not.toContain('name: "repo-0"');
    expect(receipt.queries[2]).toContain('name: "repo-1"');
    expect(receipt.result.repositories.every(repo=>repo.defaultCi?.state === "ok")).toBe(true);
    expect(receipt.results?.[1]?.repositories[0]).toEqual(receipt.results?.[0]?.repositories[0]);
  });
  it("caches independent successful fields and retries only a failed rollup", async () => {
    const receipt = await service(clones(1), `
      responseErrors = [{message:'Checks forbidden',path:['r0','defaultBranchRef','target','statusCheckRollup']}];
      const first = await readProjectRemotes(clones);
      responseErrors = [];
      const second = await readProjectRemotes(clones);
      const results = [first,second]; const result = second;
    `);
    expect(receipt.results?.map(result=>result.requests)).toEqual([2,1]);
    expect(receipt.queries[2]).toContain('statusCheckRollup { state }');
    expect(receipt.queries[2]).not.toContain('search(');
    expect(receipt.queries[2]).not.toContain('isArchived');
    expect(receipt.results?.[0]?.repositories[0]?.archived).toEqual(receipt.results?.[1]?.repositories[0]?.archived);
    expect(receipt.result.repositories[0]?.defaultCi?.state).toBe('ok');
  });
  it("retries whole-request failures on the next invocation", async () => {
    const receipt = await service(clones(1), `
      fault = () => 'HTTP 502 Bad Gateway';
      const first = await readProjectRemotes(clones);
      fault = () => null;
      const second = await readProjectRemotes(clones);
      const results = [first,second]; const result = second;
    `);
    expect(receipt.results?.map(result=>result.requests)).toEqual([1,2]);
    expect(receipt.result.repositories[0]?.defaultCi?.state).toBe('ok');
  });
  it("expires each successful field without extending it on cache hits", async () => {
    const receipt = await service(clones(1), `
      const realNow = Date.now;
      const first = await readProjectRemotes(clones);
      Date.now = () => realNow() + 4*60_000;
      const second = await readProjectRemotes(clones);
      Date.now = () => realNow() + 6*60_000;
      const third = await readProjectRemotes(clones);
      Date.now = realNow;
      const results = [first,second,third]; const result = third;
    `);
    expect(receipt.results?.map(result=>result.requests)).toEqual([2,0,2]);
  });
  it("does not reuse stored results with environment credentials", async () => {
    const receipt = await service(clones(1), `
      await readProjectRemotes(clones);
      process.env.GH_TOKEN = 'fixture-only';
      const result = await readProjectRemotes(clones);
    `);
    expect(receipt.result.requests).toBe(2);
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
    expect(receipt.queries[2]).toContain("ownerAffiliations: [OWNER]");
    expect(receipt.queries[2]).toContain("PUSHED_AT");
    expect(receipt.result.requests).toBe(3);
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
