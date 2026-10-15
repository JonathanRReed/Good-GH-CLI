import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-auth-preflight-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const client = new URL("../src/services/github/client.ts", import.meta.url).href;

for (const exitCode of [0, 1]) {
  test(`rejects a failed active account despite a successful inactive account, exit ${exitCode}`, async () => {
    const result = await runFixture(["repo", "create", "auth-check", "--dry-run", "--agent"], {
      root,
      responses: [{ prefix: ["auth", "status"], exitCode, stdout: JSON.stringify({ hosts: { "github.com": [
        { active: true, state: "failure", login: "invalid" },
        { active: false, state: "success", login: "saved" },
      ] } }) }],
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { code: "authentication_required" }, effects: { completed: [], uncertain: [] } });
    expect(result.calls).toEqual([["auth", "status", "--json", "hosts", "--hostname", "github.com"]]);
    expect(result.providerCalls).toEqual([]);
  });
}

test("legacy auth verifies identity without retrieving a saved token", async () => {
  const result = await runFixture(["repo", "create", "auth-check", "--dry-run", "--agent"], {
    root,
    responses: [
      { prefix: ["auth", "status"], stdout: "", stderr: "unknown flag: --json", exitCode: 1 },
      { prefix: ["auth", "token"], stdout: "synthetic-invalid-token" },
      { prefix: ["api", "user"], stderr: "HTTP 401: Bad credentials", exitCode: 1 },
    ],
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { code: "authentication_required" }, effects: { completed: [], uncertain: [] } });
  expect(result.calls).toEqual([
    ["auth", "status", "--json", "hosts", "--hostname", "github.com"],
    ["api", "user", "--hostname", "github.com", "--jq", ".login"],
  ]);
  expect(result.stdout + result.stderr).not.toContain("synthetic-invalid-token");
});

test("legacy identity carries login and configured SSH protocol", async () => {
  const result = await runFixture([], {
    root,
    invoke: `const { getGitHubAuthStatus } = await import(${JSON.stringify(client)}); console.log(JSON.stringify(await getGitHubAuthStatus('github.com')));`,
    responses: [
      { prefix: ["auth", "status"], stdout: "", stderr: "unknown flag: --json", exitCode: 1 },
      { prefix: ["api", "user"], stdout: "fixture\n" },
      { prefix: ["config", "get"], stdout: "ssh\n" },
    ],
  });
  expect(JSON.parse(result.stdout)).toEqual({ authenticated: true, login: "fixture", host: "github.com", protocol: "ssh" });
});
