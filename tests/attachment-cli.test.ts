import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("comment JSON and its record preserve confirmed public fallback effects", async () => {
  const root = fixtureRoot("ggh-attachment-cli-"); roots.push(root);
  const file = join(root, "proof.png");
  writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const entry = join(import.meta.dir, "../src/index.ts");
  const args = ["issue", "comment", "42", "--body", "Proof", "--attach", file, "--json", "--repo", "fixture/project"];
  const result = await runFixture([], {
    root,
    config: { attachment_upload_command: process.execPath },
    responses: [
      { prefix: ["issue", "comment", "--help"], stdout: "Usage: gh issue comment" },
      { prefix: ["repo", "view", "fixture/project", "--json", "isPrivate"], stdout: '{"isPrivate":false}' },
      { prefix: ["issue", "comment", "42"], stderr: "permission denied", exitCode: 1 },
    ],
    invoke: `const spawn=Bun.spawn.bind(Bun);Bun.spawn=(args,options)=>args[0]!==process.execPath?spawn(args,options):{pid:2147483647,stdout:new Blob([JSON.stringify({url:'https://storage.example/proof.png'})]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null};const {runCli}=await import(${JSON.stringify(entry)});await runCli(['bun','ggh',...${JSON.stringify(args)}]);`,
  });
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout);
  const operationId = report.operationId;
  expect(typeof operationId).toBe("string");
  expect(report).toMatchObject({ status: "partially_completed", phase: "github_mutation", attachments: { uploaded: [{ file, url: "https://storage.example/proof.png" }], remainingFiles: [] } });
  expect(report.url).toBeUndefined();
  expect(result.calls).toContainEqual(["repo", "view", "fixture/project", "--json", "isPrivate"]);
  const runDir = readdirSync(root).find(name => name.startsWith("run-"));
  expect(runDir).toBeDefined();
  const recordsDir = join(root, runDir!, "good-gh", "operations");
  const record = JSON.parse(readFileSync(join(recordsDir, `${operationId}.json`), "utf8"));
  expect(record.status.state).toBe("partially_completed");
  expect(record.resources).toEqual(["https://storage.example/proof.png"]);
});
