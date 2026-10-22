import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

it("runs metadata audits through the existing adapters with execution tools disabled and no real providers", async () => {
  const root = fixtureRoot("ggh-audit-adapters-");
  const ai = new URL("../src/services/ai/index.ts", import.meta.url).href;
  const runtime = new URL("../src/services/runtime.ts", import.meta.url).href;
  try {
    const result = await runFixture([], { root, invoke: `
      const {writeFileSync,readFileSync}=await import('node:fs');
      const calls=[];
      Bun.spawn=(argv,options)=>{
        if(!['codex','claude','grok','ollama'].includes(argv[0])) throw new Error('Unexpected process: '+argv[0]);
        const call={argv,cwd:options.cwd,env:options.env}; calls.push(call);
        if(argv[0]==='codex') writeFileSync(argv[argv.indexOf('-o')+1],'METADATA_RESPONSE');
        if(argv[0]==='grok') call.prompt=readFileSync(argv[argv.indexOf('--prompt-file')+1],'utf8');
        const stdout=argv[0]==='claude'?JSON.stringify({type:'result',result:'METADATA_RESPONSE'}):
          argv[0]==='ollama'&&argv[1]==='show'?'FROM /local/blobs/sha256-'+ 'a'.repeat(64)+'\\n':'METADATA_RESPONSE';
        return {pid:0,stdout:new Blob([stdout]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:{write(chunk){call.prompt=(call.prompt??'')+String(chunk)},async flush(){},async end(){}}};
      };
      const {getProviderById}=await import(${JSON.stringify(ai)});
      const {setFlags}=await import(${JSON.stringify(runtime)}); setFlags({dryRun:true});
      const output=[];
      for(const id of ['codex','claude','grok','ollama']) output.push(await getProviderById(id).auditTidy('METADATA_ONLY','fixture-model'));
      console.log(JSON.stringify({calls,output}));
    ` });
    expect(result.exitCode, result.stderr).toBe(0);
    const { calls, output } = JSON.parse(result.stdout);
    expect(output).toEqual(Array(4).fill("METADATA_RESPONSE"));
    const codex = calls.find((call: { argv: string[] }) => call.argv[0] === "codex");
    expect(codex.argv).toEqual(expect.arrayContaining(["--ignore-user-config", "features.shell_tool=false", "features.view_image=false", "features.multi_agent=false", "features.multi_agent_v2=false", 'web_search="disabled"', "read-only"]));
    const claude = calls.find((call: { argv: string[] }) => call.argv[0] === "claude");
    expect(claude.argv.slice(claude.argv.indexOf("--tools"), claude.argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(claude.argv).toEqual(expect.arrayContaining(["--disallowedTools", "*", "--strict-mcp-config", '{"mcpServers":{}}']));
    const grok = calls.find((call: { argv: string[] }) => call.argv[0] === "grok");
    expect(grok.argv.slice(grok.argv.indexOf("--tools"), grok.argv.indexOf("--tools") + 6)).toEqual(["--tools", "", "--deny", "*", "--max-turns", "1"]);
    const local = calls.filter((call: { argv: string[] }) => call.argv[0] === "ollama");
    expect(local.map((call: { argv: string[] }) => call.argv[1])).toEqual(["show", "run"]);
    expect(local[1].env.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
    for (const call of [codex, claude, grok, local[1]]) {
      expect(call.prompt).toBe("METADATA_ONLY");
      expect(call.argv).not.toContain("METADATA_ONLY");
    }
    for (const call of [codex, claude, grok]) expect(call.cwd).not.toBe(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
