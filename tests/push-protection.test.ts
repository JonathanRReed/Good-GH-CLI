import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { agentEnvelope } from "../src/services/agent-contract.ts";
import { isPushProtectionRejection, parsePushProtection } from "../src/services/git/push-protection.ts";
import type { OperationRecord } from "../src/services/operations.ts";

const roots: string[] = [];
const UNBLOCK_URL = "https://github.com/fixture/project/security/secret-scanning/unblock-secret/2VYjFixtureOnly";

function tempRoot(): string {
  const root = fixtureRoot("ggh-push-protection-");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** GitHub's GH013 push-protection report, as git prints it on the client. */
function gh013(commit: string, ref = "refs/heads/feature"): string {
  return [
    `error: GH013: Repository rule violations found for ${ref}.`,
    "",
    "- GITHUB PUSH PROTECTION",
    "  —————————————————————————————————————————",
    "    Resolve the following violations before pushing again",
    "",
    "    - Push cannot contain secrets",
    "",
    "     (?) Learn how to resolve a blocked push",
    "     https://docs.github.com/code-security/secret-scanning/working-with-secret-scanning-and-push-protection/working-with-push-protection-from-the-command-line#resolving-a-blocked-push",
    "",
    "      —— GitHub Personal Access Token ——————————————————————",
    "       locations:",
    `         - commit: ${commit}`,
    "           path: config/settings.env:4",
    "",
    "       (?) To push, remove secret from commit(s) or follow this URL to allow the secret.",
    `       ${UNBLOCK_URL}`,
    "",
    "      —— Generic Password (AI detected) ————————————————————",
    "       locations:",
    `         - commit: ${commit}`,
    "           path: notes/setup.md:12",
    "",
  ].join("\n");
}

const asRemote = (text: string): string => text.split("\n").map((line) => `remote: ${line}`).join("\n");

describe("push protection parsing", () => {
  const sha = "8728dbe67b5d4ed2ac2d23cfbd7bbd2a4ef1e2ac";

  test("parses GH013 findings, secret types, locations and the bypass URL", () => {
    const stderr = `${asRemote(gh013(sha))}\nTo https://github.com/fixture/project\n ! [remote rejected] feature -> feature (push declined due to repository rule violations)\nerror: failed to push some refs to 'https://github.com/fixture/project'\n`;
    const details = parsePushProtection(stderr);
    expect(details).toBeDefined();
    expect(details?.findings).toEqual([
      { secretType: "GitHub Personal Access Token", commit: sha, path: "config/settings.env", line: 4 },
      { secretType: "Generic Password (AI detected)", commit: sha, path: "notes/setup.md", line: 12 },
    ]);
    expect(details?.bypassUrls).toEqual([UNBLOCK_URL]);
    expect(details?.remoteLines[0]).toBe("error: GH013: Repository rule violations found for refs/heads/feature.");
    expect(details?.remoteLines.some((line) => line.includes("[remote rejected]"))).toBe(false);
  });

  test("parses the older GH009 layout", () => {
    const stderr = asRemote([
      "error: GH009: Secrets detected! This push failed.",
      "        - Commit: abc1234",
      "          - Path: src/app.ts",
      "            Line: 7",
      "            Secret type: Slack API Token",
      "  To push, remove secret from commit(s) or follow this URL to allow the secret.",
      "  https://github.com/fixture/project/security/secret-scanning/unblock-secret/abc",
    ].join("\n"));
    expect(parsePushProtection(stderr)).toMatchObject({
      findings: [{ commit: "abc1234", path: "src/app.ts", line: 7, secretType: "Slack API Token" }],
      bypassUrls: ["https://github.com/fixture/project/security/secret-scanning/unblock-secret/abc"],
    });
  });

  test("classifies an unrecognised layout and keeps the raw remote lines", () => {
    const stderr = asRemote("Push blocked by secret scanning: see the repository settings.\nSomething new happened.");
    const details = parsePushProtection(stderr);
    expect(details).toEqual({ findings: [], bypassUrls: [], remoteLines: ["Push blocked by secret scanning: see the repository settings.", "Something new happened."] });
  });

  test("does not classify other rejections or local text", () => {
    expect(isPushProtectionRejection(asRemote("error: GH013: Repository rule violations found for refs/heads/main.\n- Changes must be made through a pull request."))).toBe(false);
    expect(isPushProtectionRejection(" ! [rejected]        feature -> feature (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind")).toBe(false);
    expect(isPushProtectionRejection("pre-push hook: push protection would block this\nPush cannot contain secrets")).toBe(false);
  });

  test("strips terminal control sequences from remote text", () => {
    const details = parsePushProtection(asRemote(`- Push cannot contain secrets\n\u001b]0;owned\u0007 —— Token \u001b[31mType\u001b[0m ——\n - commit: ${sha}`));
    expect(details?.findings).toEqual([{ secretType: "Token Type", commit: sha }]);
    expect(details?.remoteLines.join("\n")).not.toContain("\u001b");
  });
});

describe("push protection agent contract", () => {
  const pushProtection = { findings: [{ commit: "a".repeat(40), path: "x.env", line: 1 }], bypassUrls: [UNBLOCK_URL], remoteLines: ["- Push cannot contain secrets"] };
  const operation = {
    schemaVersion: 1, id: "op-1", command: "commit", status: { state: "partially_completed" }, resources: [],
    steps: [{ name: "commit", state: "completed" }, { name: "push", state: "failed" }],
  } as unknown as OperationRecord;

  test("keeps the code through partial completion, never retries, and leaves the push pending", () => {
    const envelope = agentEnvelope({ command: ["commit"], failed: true, dryRun: false, preview: [], operation, issue: { status: "failed", code: "push_protection_blocked", message: "Push blocked.", pushProtection } });
    expect(envelope).toMatchObject({
      status: "partially_completed",
      error: { code: "push_protection_blocked", retryability: "never", pushProtection },
      effects: { completed: ["commit"], pending: ["push"], uncertain: [] },
    });
  });

  test("other failed steps stay uncertain", () => {
    const envelope = agentEnvelope({ command: ["commit"], failed: true, dryRun: false, preview: [], operation, issue: { status: "failed", message: "Push failed." } });
    expect(envelope.effects?.uncertain).toEqual(["push"]);
    expect(envelope.error?.retryability).toBe("after_inspection");
  });
});

/**
 * A local bare remote whose pre-receive hook rejects one branch with a GH013
 * report and counts every invocation, so a retry would be visible.
 */
function remoteWithPushProtection(root: string, blockedRef: string): { repo: string; bare: string; attempts: () => number } {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--initial-branch=main"], repo);
  git(["config", "user.name", "Fixture"], repo);
  git(["config", "user.email", "fixture@example.test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "base"], repo);
  const bare = join(root, "remote.git");
  git(["init", "--bare", "--initial-branch=main", bare], root);
  git(["remote", "add", "origin", bare], repo);
  git(["push", "-u", "origin", "main"], repo);
  const counter = join(root, "pre-receive-runs").replace(/\\/g, "/");
  const report = gh013("$new", blockedRef).replace(/`/g, "");
  writeFileSync(join(bare, "hooks", "pre-receive"), [
    "#!/bin/sh",
    `echo run >> "${counter}"`,
    "blocked=",
    "while read old new ref; do",
    `  if [ "$ref" = "${blockedRef}" ]; then blocked=$new; fi`,
    "done",
    '[ -n "$blocked" ] || exit 0',
    "new=$blocked",
    "cat >&2 <<EOF",
    report,
    "EOF",
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
  return { repo, bare, attempts: () => existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0 };
}

describe("push protection through ggh commands", () => {
  test("commit --push streams the remote report, classifies it, and does not retry", async () => {
    const root = tempRoot();
    const { repo, bare, attempts } = remoteWithPushProtection(root, "refs/heads/feature");
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "settings.env"), "TOKEN=placeholder\n");

    const result = await runFixture(["commit", "--all", "-m", "add settings", "--push", "--yes", "--no-ai", "--no-verify"], { root, cwd: repo });

    expect(result.exitCode).toBe(1);
    expect(attempts()).toBe(1);
    // git's own stderr still reaches the user, followed by ggh's classification.
    expect(result.stderr).toContain("remote: error: GH013: Repository rule violations found for refs/heads/feature.");
    expect(result.stderr).toContain("Push blocked by GitHub push protection");
    expect(result.stderr).toContain("git commit --amend");
    expect(result.stderr).toContain("Rotate the secret");
    expect(result.stderr).toContain("That is their decision, not a next step");
    expect(result.stdout).toBe("");
    expect(() => git(["--git-dir", bare, "rev-parse", "--verify", "refs/heads/feature"], root)).toThrow();
  });

  test("commit --push --agent reports push_protection_blocked with findings and the push pending", async () => {
    const root = tempRoot();
    const { repo, attempts } = remoteWithPushProtection(root, "refs/heads/feature");
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "settings.env"), "TOKEN=placeholder\n");

    const result = await runFixture(["commit", "--all", "-m", "add settings", "--push", "--yes", "--no-ai", "--no-verify", "--agent"], { root, cwd: repo });

    expect(result.exitCode).toBe(1);
    expect(attempts()).toBe(1);
    const head = git(["rev-parse", "HEAD"], repo);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      status: "partially_completed",
      error: {
        code: "push_protection_blocked",
        retryability: "never",
        pushProtection: {
          findings: [
            { secretType: "GitHub Personal Access Token", commit: head, path: "config/settings.env", line: 4 },
            { secretType: "Generic Password (AI detected)", commit: head, path: "notes/setup.md", line: 12 },
          ],
          bypassUrls: [UNBLOCK_URL],
        },
      },
      effects: { completed: ["commit"], pending: ["push"], uncertain: [] },
    });
    expect(envelope.error.message).not.toContain(UNBLOCK_URL);
    const operation = JSON.parse((await runFixture(["operation", "view", envelope.operationId, "--json"], { root, cwd: repo })).stdout);
    expect(operation.steps).toEqual([{ name: "commit", state: "completed" }, { name: "push", state: "failed" }]);
  });

  test("an ordinary non-fast-forward rejection is not classified as push protection", async () => {
    const root = tempRoot();
    const { repo } = remoteWithPushProtection(root, "refs/heads/never-pushed");
    git(["switch", "-c", "feature"], repo);
    git(["push", "-u", "origin", "feature"], repo);
    const other = join(root, "other");
    git(["clone", "--branch", "feature", join(root, "remote.git"), other], root);
    git(["config", "user.name", "Fixture"], other);
    git(["config", "user.email", "fixture@example.test"], other);
    writeFileSync(join(other, "remote.txt"), "remote\n");
    git(["add", "remote.txt"], other);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "remote change"], other);
    git(["push"], other);
    writeFileSync(join(repo, "local.txt"), "local\n");

    const result = await runFixture(["commit", "--all", "-m", "local change", "--push", "--yes", "--no-ai", "--no-verify", "--agent"], { root, cwd: repo });

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).not.toBe("push_protection_blocked");
    expect(envelope.error.retryability).toBe("after_inspection");
    expect(envelope.error.pushProtection).toBeUndefined();
    expect(envelope.result.failed).toBeUndefined();
  });

  test("pr create records push_head as failed and does not open a pull request", async () => {
    const root = tempRoot();
    const { repo, bare, attempts } = remoteWithPushProtection(root, "refs/heads/feature");
    git(["remote", "set-url", "origin", "https://github.com/fixture/project.git"], repo);
    git(["config", `url.${pathToFileURL(bare).href}.insteadOf`, "https://github.com/fixture/project.git"], repo);
    git(["fetch", "origin"], repo);
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "settings.env"), "TOKEN=placeholder\n");
    git(["add", "settings.env"], repo);
    git(["commit", "-m", "add settings"], repo);
    const before = attempts();

    const result = await runFixture(["pr", "create", "--base", "main", "--title", "Add settings", "--body", "Body", "--yes", "--no-ai", "--agent"], {
      root, cwd: repo,
      responses: [
        { prefix: ["api", "repos/fixture/project"], stdout: '{"html_url":"https://github.com/fixture/project","private":true,"visibility":"private"}' },
        { prefix: ["pr", "list"], stdout: "[]" },
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(attempts() - before).toBe(1);
    expect(result.calls.some((call) => call[0] === "pr" && call[1] === "create")).toBe(false);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      status: "failed",
      error: { code: "push_protection_blocked", retryability: "never", pushProtection: { bypassUrls: [UNBLOCK_URL] } },
      result: { failed: ["push_head"] },
      effects: { completed: [], uncertain: [] },
    });
    expect(envelope.effects.pending).toContain("push_head");
    const operation = JSON.parse((await runFixture(["operation", "view", envelope.operationId, "--json"], { root, cwd: repo })).stdout);
    expect(operation.steps).toContainEqual({ name: "push_head", state: "failed" });
  });

  test("stack submit records the blocked branch as failed and keeps earlier work", async () => {
    const root = tempRoot();
    const { repo, attempts } = remoteWithPushProtection(root, "refs/heads/child");
    git(["switch", "-c", "parent"], repo);
    writeFileSync(join(repo, "parent.txt"), "parent\n");
    git(["add", "parent.txt"], repo);
    git(["commit", "-m", "parent"], repo);
    git(["config", "branch.parent.gh-merge-base", "main"], repo);
    git(["switch", "-c", "child"], repo);
    git(["config", "branch.child.gh-merge-base", "parent"], repo);
    git(["config", "branch.child.gh-merge-base-sha", git(["rev-parse", "parent"], repo)], repo);
    writeFileSync(join(repo, "child.env"), "TOKEN=placeholder\n");
    git(["add", "child.env"], repo);
    git(["commit", "-m", "child"], repo);
    git(["switch", "main"], repo);
    // Submit requires a GitHub origin; Git redirects it to the protected bare repository.
    const bare = git(["remote", "get-url", "origin"], repo);
    git(["remote", "set-url", "origin", "https://github.com/test/repo.git"], repo);
    git(["config", "url." + pathToFileURL(bare).href + ".insteadOf", "https://github.com/test/repo.git"], repo);
    const responses = [
      { prefix: ["pr", "view"], stdout: "" },
      { prefix: ["pr", "create", "--title", "parent"], stdout: "https://github.com/test/repo/pull/10" },
    ];
    const planned = JSON.parse((await runFixture(["stack", "submit", "child", "--dry-run", "--agent"], { root, cwd: repo, responses })).stdout);
    expect(planned.status).toBe("planned");
    const before = attempts();

    const result = await runFixture(["stack", "submit", "child", "--approve-plan", planned.result.snapshotId, "--agent"], { root, cwd: repo, responses });

    expect(result.exitCode).toBe(1);
    // parent pushed once, child was attempted once and never retried.
    expect(attempts() - before).toBe(2);
    expect(result.calls.some((call) => call[0] === "pr" && call[1] === "create" && call.includes("child"))).toBe(false);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      status: "partially_completed",
      error: { code: "push_protection_blocked", retryability: "never" },
      result: { failed: ["push:child"] },
      effects: { uncertain: [] },
    });
    expect(envelope.effects.completed).toEqual(expect.arrayContaining(["push:parent", "create_pr:parent"]));
    expect(envelope.effects.pending).toEqual(expect.arrayContaining(["push:child", "create_pr:child"]));
    expect(envelope.error.pushProtection.findings[0]).toMatchObject({ commit: git(["rev-parse", "child"], repo) });
    expect(git(["branch", "--show-current"], repo)).toBe("main");
    // The checkpoint is dropped: removing the secret rewrites the branch anyway.
    expect(existsSync(join(repo, ".git", "ggh-stack-recovery", "active.json"))).toBe(false);
    const operation = JSON.parse((await runFixture(["operation", "view", envelope.operationId, "--json"], { root, cwd: repo })).stdout);
    expect(operation.steps).toContainEqual({ name: "push:child", state: "failed" });
  });
});
