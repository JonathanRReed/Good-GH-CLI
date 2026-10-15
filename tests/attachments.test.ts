import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const servicePath = join(import.meta.dir, "..", "src", "services", "github", "attachments.ts");
const clientPath = join(import.meta.dir, "..", "src", "services", "github", "client.ts");
const prsPath = join(import.meta.dir, "..", "src", "services", "github", "prs.ts");
const issuesPath = join(import.meta.dir, "..", "src", "services", "github", "issues.ts");
const githubPath = join(import.meta.dir, "..", "src", "services", "github.ts");
const runtimePath = join(import.meta.dir, "..", "src", "services", "runtime.ts");
const fixtureRoots: string[] = [];

function createFixtureRoot(prefix: string): string {
  const root = fixtureRoot(prefix);
  fixtureRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function imageFile(root: string, name = "screen.png"): string {
  const path = join(root, name);
  writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FQAAAABJRU5ErkJggg==", "base64"));
  return path;
}

function videoFile(root: string, name: "clip.mp4" | "clip.mov" | "clip.webm"): string {
  const path = join(root, name);
  const header = name.endsWith("webm")
    ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x86, 0x81, 0x01])
    : Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  writeFileSync(path, header);
  return path;
}

function webpFile(root: string): string {
  const path = join(root, "screen.webp");
  writeFileSync(path, Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]));
  return path;
}

function uploader(root: string, markerPath: string): string {
  const executable = process.platform === "win32" ? join(root, "uploader.exe") : join(root, "uploader");
  const script = `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(Bun.argv.slice(2)) + '\\n');\nprocess.stdout.write(JSON.stringify({url:'https://files.example/screen.png'}));\n`;
  if (process.platform === "win32") {
    writeFileSync(executable, "fixture executable marker");
    writeFileSync(`${executable}.ts`, script);
  } else {
    writeFileSync(executable, `#!/usr/bin/env bun\n${script}`);
  }
  chmodSync(executable, 0o700);
  return executable;
}

function uploaderThatFailsOnSecondFile(root: string, markerPath: string): string {
  const executable = process.platform === "win32" ? join(root, "uploader-partial.exe") : join(root, "uploader-partial");
  const script = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const marker = ${JSON.stringify(markerPath)};
const args = Bun.argv.slice(2);
const prior = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\\n').filter(Boolean) : [];
appendFileSync(marker, JSON.stringify(args) + '\\n');
if (prior.length > 0) { process.stderr.write('second upload failed'); process.exit(9); }
process.stdout.write(JSON.stringify({url:'https://files.example/first.png'}));
`;
  if (process.platform === "win32") {
    writeFileSync(executable, "fixture executable marker");
    writeFileSync(`${executable}.ts`, script);
  } else {
    writeFileSync(executable, `#!/usr/bin/env bun\n${script}`);
  }
  chmodSync(executable, 0o700);
  return executable;
}

function uploaderSpawnInterceptor(executable: string | undefined): string {
  if (process.platform !== "win32" || !executable) return "";
  return `
    const configuredUploader = ${JSON.stringify(executable)};
    const nativeSpawn = Bun.spawn.bind(Bun);
    Bun.spawn = (argv, options) => argv[0] === configuredUploader
      ? nativeSpawn([process.execPath, configuredUploader + '.ts', ...argv.slice(1)], options)
      : nativeSpawn(argv, options);
  `;
}

async function runService(input: {
  root: string;
  attachments?: string[];
  responses?: FixtureResponse[];
  config?: Record<string, unknown>;
  visibility?: "private" | "public" | "unknown";
  repo?: string;
  host?: string;
  expression?: string;
}) {
  const attachments = JSON.stringify(input.attachments ?? []);
  const invocation = input.expression ?? `
    const { prepareAttachmentPlan } = await import(${JSON.stringify(servicePath)});
    const plan = await prepareAttachmentPlan({ attachments: ${attachments}, operation: 'pr-create', recipient: 'pr:create', visibility: ${JSON.stringify(input.visibility ?? "unknown")}, repo: ${JSON.stringify(input.repo)}, host: ${JSON.stringify(input.host)}, cwd: ${JSON.stringify(input.root)} });
    process.stdout.write(JSON.stringify(plan));
  `;
  const output = `${uploaderSpawnInterceptor(typeof input.config?.attachment_upload_command === "string" ? input.config.attachment_upload_command : undefined)}\n${invocation}`;
  return runFixture([], { root: input.root, responses: input.responses, config: input.config, invoke: output });
}

async function runFallbackEdit(input: { resource: "pr" | "issue"; viewStdout: string }) {
  const root = createFixtureRoot(`ggh-attach-${input.resource}-edit-`);
  const path = imageFile(root);
  const executableTrace = join(root, "uploads.jsonl");
  const callsTrace = join(root, "gh-inputs.jsonl");
  const configuredUploader = uploader(root, executableTrace);
  const viewArgs = input.resource === "pr"
    ? ["pr", "view", "42", "--json", "body", "--repo", "acme/demo"]
    : ["issue", "view", "42", "--json", "body", "--repo", "acme/demo"];
  const action = input.resource === "pr" ? "pr" : "issue";
  const methodName = input.resource === "pr" ? "editPullRequest" : "editIssue";
  const modulePath = input.resource === "pr" ? prsPath : issuesPath;
  const result = await runFixture([], {
    root,
    config: { attachment_upload_command: configuredUploader },
    responses: [
      { prefix: [action, "edit", "--help"], stdout: "Usage: gh edit" },
      { prefix: ["repo", "view", "acme/demo", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: false }) },
      { prefix: viewArgs, stdout: input.viewStdout },
      { prefix: [action, "edit", "42"], stdout: "updated" },
    ],
    invoke: `${uploaderSpawnInterceptor(configuredUploader)}
      const { appendFileSync } = await import('node:fs');
      const spawn = Bun.spawn.bind(Bun);
      Bun.spawn = (argv, options) => {
        const child = spawn(argv, options);
        if (argv[0] === 'gh') {
          const record = (input) => appendFileSync(${JSON.stringify(callsTrace)}, JSON.stringify({args: argv.slice(1), input}) + '\\n');
          record(undefined);
          if (options?.stdin === 'pipe') {
            child.stdin = {
              write(value) { record(value); },
              async flush() {},
              async end() {},
            };
          }
        }
        return child;
      };
      const service = await import(${JSON.stringify(modulePath)});
      try {
        await service.${methodName}(42, { attachments: [${JSON.stringify(path)}], repo: 'acme/demo', host: 'github.com', visibility: 'unknown' }, ${JSON.stringify(root)});
        process.stdout.write('updated');
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.message }));
      }
    `,
  });
  const { readFileSync: readContents } = await import("node:fs");
  const ghInputs = existsSync(callsTrace)
    ? readContents(callsTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; input?: string })
    : [];
  return { root, path, executableTrace, result, ghInputs };
}

describe("GitHub attachments", () => {
  test("refuses unsupported Enterprise Server native uploads before any request", async () => {
    const root = fixtureRoot("ggh-attach-enterprise-server-");
    const result = await runService({ root, attachments: [imageFile(root)], host: "github.enterprise.test", visibility: "private", responses: [{ prefix: ["pr", "create", "--help"], stdout: "--attach <path>" }] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("GitHub.com or a GHE.com tenant");
    expect(result.calls).toEqual([]);
  });
  test("rejects missing and unsupported files before any gh request", async () => {
    const root = createFixtureRoot("ggh-attach-invalid-");
    imageFile(root, "document.pdf");
    const missing = await runService({ root, attachments: [join(root, "missing.png")] });
    const unsupported = await runService({ root, attachments: [join(root, "document.pdf")] });
    expect(missing.calls).toEqual([]);
    expect(unsupported.calls).toEqual([]);
    expect(missing.stderr).toContain("does not exist");
    expect(unsupported.stderr).toContain("Unsupported attachment type");
  });

  test("rejects text files disguised with supported media extensions", async () => {
    const root = createFixtureRoot("ggh-attach-header-");
    const path = join(root, "fake.png");
    writeFileSync(path, "this is not a PNG");
    const result = await runService({ root, attachments: [path] });
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("does not match its .png file extension");
  });

  test("rejects oversized attachments before capability lookup", async () => {
    const root = createFixtureRoot("ggh-attach-size-");
    const path = join(root, "large.png");
    writeFileSync(path, Buffer.alloc(10 * 1024 * 1024 + 1));
    const result = await runService({ root, attachments: [path] });
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("10 MiB");
  });

  test("uses native capability help and preserves path plus alt text argv", async () => {
    const root = createFixtureRoot("ggh-attach-native-");
    const path = imageFile(root, "screen shot.png");
    const result = await runService({
      root,
      attachments: [`${path}#Sign-in error screen`],
      responses: [{ prefix: ["pr", "create", "--help"], stdout: "--attach <path>\n" }],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "native", files: [{ altText: "Sign-in error screen", mediaKind: "image" }] });
    expect(result.calls).toEqual([["pr", "create", "--help"]]);
  });

  test("accepts the supported MP4, MOV, and WEBM headers", async () => {
    const root = createFixtureRoot("ggh-attach-video-");
    const paths = [videoFile(root, "clip.mp4"), videoFile(root, "clip.mov"), videoFile(root, "clip.webm")];
    for (const path of paths) {
      const result = await runService({
        root,
        attachments: [path],
        responses: [{ prefix: ["pr", "create", "--help"], stdout: "--attach <path>" }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind: "native", files: [{ mediaKind: "video" }] });
    }
  });

  test("accepts WEBP and enforces GitHub's 50-file operation limit", async () => {
    const root = createFixtureRoot("ggh-attach-webp-");
    const path = webpFile(root);
    const webp = await runService({ root, attachments: [path], responses: [{ prefix: ["pr", "create", "--help"], stdout: "--attach <path>" }] });
    const tooMany = await runService({ root, attachments: Array.from({ length: 51 }, () => path) });
    expect(JSON.parse(webp.stdout)).toMatchObject({ kind: "native", files: [{ mediaKind: "image" }] });
    expect(tooMany.calls).toEqual([]);
    expect(tooMany.stderr).toContain("at most 50 attachments");
  });

  test("refuses unsupported native CLI when no configured fallback exists", async () => {
    const root = createFixtureRoot("ggh-attach-old-gh-");
    const path = imageFile(root);
    const result = await runService({
      root,
      attachments: [path],
      responses: [{ prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" }],
    });
    expect(result.calls).toEqual([["pr", "create", "--help"]]);
    expect(result.stderr).toContain("Upgrade GitHub CLI");
  });

  test("refuses configured fallback for a planned private repository", async () => {
    const root = createFixtureRoot("ggh-attach-private-");
    const path = imageFile(root);
    const executable = uploader(root, join(root, "unused-upload-trace.jsonl"));
    const result = await runService({
      root,
      attachments: [path],
      config: { attachment_upload_command: executable },
      visibility: "private",
      responses: [{ prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" }],
    });
    expect(result.calls).toEqual([["pr", "create", "--help"]]);
    expect(result.stderr).toContain("private repository visibility");
  });

  test("refuses unknown visibility when repo inspection confirms private or cannot resolve a target", async () => {
    const root = createFixtureRoot("ggh-attach-unknown-");
    const path = imageFile(root);
    const executable = uploader(root, join(root, "unused-upload-trace.jsonl"));
    const config = { attachment_upload_command: executable };
    const privateRepo = await runService({
      root,
      attachments: [path],
      config,
      responses: [
        { prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" },
        { prefix: ["repo", "view", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: true }) },
      ],
    });
    const missingRepo = await runService({
      root,
      attachments: [path],
      config,
      responses: [{ prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" }],
    });
    expect(privateRepo.stderr).toContain("repository visibility is private");
    expect(privateRepo.calls).toEqual([["pr", "create", "--help"], ["repo", "view", "--json", "isPrivate"]]);
    expect(missingRepo.stderr).toContain("visibility could not be verified as public");
    expect(missingRepo.calls).toEqual([["pr", "create", "--help"], ["repo", "view", "--json", "isPrivate"]]);
  });

  test("calls public fallback with file and recipient argv and accepts only HTTPS JSON", async () => {
    const root = createFixtureRoot("ggh-attach-fallback-");
    const path = imageFile(root);
    const trace = join(root, "uploader-args.jsonl");
    const executable = uploader(root, trace);
    const result = await runService({
      root,
      attachments: [path],
      config: { attachment_upload_command: executable },
      responses: [
        { prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" },
        { prefix: ["repo", "view", "acme/demo", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: false }) },
      ],
      expression: `
        const { prepareAttachmentPlan, uploadFallbackAttachment } = await import(${JSON.stringify(servicePath)});
        const plan = await prepareAttachmentPlan({ attachments: [${JSON.stringify(path)}], operation: 'pr-create', recipient: 'pr:create', visibility: 'unknown', repo: 'acme/demo', host: 'github.com', cwd: ${JSON.stringify(root)} });
        if (plan.kind !== 'fallback') throw new Error('expected configured fallback');
        const url = await uploadFallbackAttachment(plan, plan.files[0]);
        process.stdout.write(url);
      `,
    });
    expect(result.stdout).toBe("https://files.example/screen.png");
    expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual([path, "pr:create"]);
    expect(result.calls[1]).toEqual(["repo", "view", "acme/demo", "--json", "isPrivate"]);
  });

  test("uses an inherited repository as the positional gh repo view target", async () => {
    const root = createFixtureRoot("ggh-attach-inherited-repo-");
    const path = imageFile(root);
    const trace = join(root, "upload-args.jsonl");
    const executable = uploader(root, trace);
    const result = await runService({
      root,
      attachments: [path],
      config: { attachment_upload_command: executable },
      responses: [
        { prefix: ["pr", "create", "--help"], stdout: "Usage: gh pr create" },
        { prefix: ["repo", "view", "acme/demo", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: false }) },
      ],
      expression: `
        const { setFlags } = await import(${JSON.stringify(runtimePath)});
        setFlags({ repo: 'acme/demo' });
        const { prepareAttachmentPlan } = await import(${JSON.stringify(servicePath)});
        const plan = await prepareAttachmentPlan({ attachments: [${JSON.stringify(path)}], operation: 'pr-create', recipient: 'pr:create', visibility: 'unknown', cwd: ${JSON.stringify(root)} });
        process.stdout.write(JSON.stringify(plan));
      `,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "fallback" });
    expect(result.calls).toEqual([
      ["pr", "create", "--help"],
      ["repo", "view", "acme/demo", "--json", "isPrivate"],
    ]);
    expect(result.calls.flat()).not.toContain("--repo");
  });

  test("keeps the created pull request URL when native upload fails", async () => {
    const root = createFixtureRoot("ggh-attach-partial-");
    const path = imageFile(root);
    const result = await runService({
      root,
      attachments: [path],
      responses: [
        { prefix: ["pr", "create", "--help"], stdout: "--attach <path>" },
        { prefix: ["pr", "create", "--title", "Example"], stdout: "https://github.com/acme/demo/pull/42\n", stderr: "attachment upload failed", exitCode: 1 },
      ],
      expression: `
        const { createPullRequest, PartialGitHubMutationError } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "services", "github.ts"))});
        try {
          await createPullRequest({ title: 'Example', body: 'Details', attachments: [${JSON.stringify(path)}], cwd: ${JSON.stringify(root)} });
        } catch (error) {
          if (!(error instanceof PartialGitHubMutationError)) throw error;
          process.stdout.write(JSON.stringify({ resourceUrl: error.resourceUrl, requestedCount: error.attachments.requestedCount, failedFiles: error.attachments.failedFiles }));
        }
      `,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ resourceUrl: "https://github.com/acme/demo/pull/42", requestedCount: 1 });
    expect(result.calls[1]).toContain("--attach");
    expect(result.calls[1]).toContain(path);
    expect(result.calls[1]).toContain("--body-file");
    expect(result.calls[1]).toContain("-");
  });

  test("keeps a PR body when configured fallback media is added", async () => {
    const run = await runFallbackEdit({ resource: "pr", viewStdout: JSON.stringify({ body: "Existing PR description" }) });
    const mutation = run.ghInputs.find(({ args, input }) => args[0] === "pr" && args[1] === "edit" && args[2] === "42" && input !== undefined);
    expect(mutation?.input).toContain("Existing PR description");
    expect(mutation?.input).toContain("https://files.example/screen.png");
    expect(existsSync(run.executableTrace)).toBe(true);
  });

  test("keeps an issue body when configured fallback media is added", async () => {
    const run = await runFallbackEdit({ resource: "issue", viewStdout: JSON.stringify({ body: "Existing issue description" }) });
    const mutation = run.ghInputs.find(({ args, input }) => args[0] === "issue" && args[1] === "edit" && args[2] === "42" && input !== undefined);
    expect(mutation?.input).toContain("Existing issue description");
    expect(mutation?.input).toContain("https://files.example/screen.png");
    expect(existsSync(run.executableTrace)).toBe(true);
  });

  test("does not upload fallback files when reading an existing edit body fails", async () => {
    for (const resource of ["pr", "issue"] as const) {
      const run = await runFallbackEdit({ resource, viewStdout: JSON.stringify({ title: "missing body field" }) });
      expect(JSON.parse(run.result.stdout).error).toContain(`Could not read the current ${resource === "pr" ? "pull request" : "issue"} body`);
      expect(existsSync(run.executableTrace)).toBe(false);
      expect(run.ghInputs.some(({ args }) => args[0] === resource && args[1] === "edit" && args[2] === "42")).toBe(false);
    }
  });

  test("does not treat a URL in stderr as proof that PR creation succeeded", async () => {
    const root = createFixtureRoot("ggh-attach-false-partial-");
    const path = imageFile(root);
    const result = await runService({
      root,
      attachments: [path],
      responses: [
        { prefix: ["pr", "create", "--help"], stdout: "--attach <path>" },
        { prefix: ["pr", "create", "--title", "Example"], stderr: "could not upload; retry at https://github.com/acme/demo/pull/42", exitCode: 1 },
      ],
      expression: `
        const { createPullRequest, PartialGitHubMutationError } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "services", "github.ts"))});
        try {
          await createPullRequest({ title: 'Example', body: 'Details', attachments: [${JSON.stringify(path)}], cwd: ${JSON.stringify(root)} });
          process.stdout.write('unexpected success');
        } catch (error) {
          process.stdout.write(JSON.stringify({ partial: error instanceof PartialGitHubMutationError, message: error.message }));
        }
      `,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ partial: false });
  });

  test("preserves completed and remaining fallback uploads when the second file fails", async () => {
    const root = createFixtureRoot("ggh-attach-partial-storage-");
    const first = imageFile(root, "first.png");
    const second = imageFile(root, "second.png");
    const uploadTrace = join(root, "upload-trace.jsonl");
    const configuredUploader = uploaderThatFailsOnSecondFile(root, uploadTrace);
    const result = await runService({
      root,
      attachments: [first, second],
      config: { attachment_upload_command: configuredUploader },
      responses: [
        { prefix: ["issue", "comment", "--help"], stdout: "Usage: gh issue comment" },
        { prefix: ["repo", "view", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: false }) },
      ],
      expression: `
        const { commentOnIssueWithAttachments } = await import(${JSON.stringify(issuesPath)});
        const { PartialAttachmentOperationError } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "services", "github.ts"))});
        try {
          await commentOnIssueWithAttachments(42, 'Comment body', { attachments: [${JSON.stringify(first)}, ${JSON.stringify(second)}] }, ${JSON.stringify(root)});
        } catch (error) {
          if (!(error instanceof PartialAttachmentOperationError)) throw error;
          process.stdout.write(JSON.stringify({
            phase: error.phase,
            uploaded: error.uploadedAttachments.map((item) => ({ path: item.file.path, url: item.url })),
            remaining: error.remainingFiles.map((file) => file.path),
            claimsResource: 'resourceUrl' in error || 'createdPRURL' in error,
          }));
        }
      `,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      phase: "storage_upload",
      uploaded: [{ path: first, url: "https://files.example/first.png" }],
      remaining: [second],
      claimsResource: false,
    });
    expect(result.calls).toEqual([
      ["issue", "comment", "--help"],
      ["repo", "view", "--json", "isPrivate"],
    ]);
    expect(readFileSync(uploadTrace, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("reports uploaded fallback URLs when the GitHub edit fails without claiming a resource", async () => {
    const root = createFixtureRoot("ggh-attach-partial-edit-");
    const path = imageFile(root);
    const uploadTrace = join(root, "upload-trace.jsonl");
    const configuredUploader = uploader(root, uploadTrace);
    const result = await runService({
      root,
      config: { attachment_upload_command: configuredUploader },
      repo: "acme/demo",
      responses: [
        { prefix: ["pr", "edit", "--help"], stdout: "Usage: gh pr edit" },
        { prefix: ["repo", "view", "acme/demo", "--json", "isPrivate"], stdout: JSON.stringify({ isPrivate: false }) },
        { prefix: ["pr", "view", "42", "--json", "body", "--repo", "acme/demo"], stdout: JSON.stringify({ body: "Existing PR body" }) },
        { prefix: ["pr", "edit", "42"], stderr: "permission denied", exitCode: 1 },
      ],
      expression: `
        const { editPullRequest, PartialAttachmentOperationError } = await import(${JSON.stringify(githubPath)});
        try {
          await editPullRequest(42, { attachments: [${JSON.stringify(path)}], repo: 'acme/demo', host: 'github.com', visibility: 'unknown' }, ${JSON.stringify(root)});
        } catch (error) {
          process.stdout.write(JSON.stringify({
            phase: error.phase,
            uploaded: error.uploadedAttachments.map((item) => ({ path: item.file.path, url: item.url })),
            remaining: error.remainingFiles.map((file) => file.path),
            claimsResource: 'resourceUrl' in error || 'createdPRURL' in error,
          }));
        }
      `,
    });
    if (!result.stdout) throw new Error(result.stderr);
    expect(JSON.parse(result.stdout)).toEqual({
      phase: "github_mutation",
      uploaded: [{ path, url: "https://files.example/screen.png" }],
      remaining: [],
      claimsResource: false,
    });
    expect(readFileSync(uploadTrace, "utf8")).toContain(path);
    expect(result.calls.at(-1)?.slice(0, 2)).toEqual(["pr", "edit"]);
  });

  test("sends long body content through stdin with --body-file -", async () => {
    const { stdinTextRequest } = await import(clientPath);
    const body = "A long body with `$HOME` preserved as literal text.";
    expect(stdinTextRequest(["pr", "create"], "--body-file", body)).toEqual({
      args: ["pr", "create", "--body-file", "-"],
      input: body,
    });
  });

  test("reads body files from stdin as bounded UTF-8", () => {
    const input = "Issue details: café\nsecond line";
    const result = spawnSync(process.execPath, ["-e", `
      const { readAttachmentBodyFile } = await import(${JSON.stringify(servicePath)});
      process.stdout.write(readAttachmentBodyFile('-'));
    `], { input, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input);

    const invalidUtf8 = spawnSync(process.execPath, ["-e", `
      const { readAttachmentBodyFile } = await import(${JSON.stringify(servicePath)});
      try { readAttachmentBodyFile('-'); } catch (error) { process.stdout.write(error.message); }
    `], { input: Buffer.from([0xff]), encoding: "utf8" });
    expect(invalidUtf8.stdout).toContain("valid UTF-8");

    const oversized = spawnSync(process.execPath, ["-e", `
      const { readAttachmentBodyFile } = await import(${JSON.stringify(servicePath)});
      try { readAttachmentBodyFile('-'); } catch (error) { process.stdout.write(error.message); }
    `], { input: "a".repeat(1024 * 1024 + 1), encoding: "utf8" });
    expect(oversized.stdout).toContain("no larger than 1 MiB");
  });

  test("reads only regular body files within the same UTF-8 size bound", async () => {
    const root = createFixtureRoot("ggh-attach-body-file-");
    const bodyPath = join(root, "body.md");
    writeFileSync(bodyPath, "Body text: résumé");
    const { readAttachmentBodyFile } = await import(servicePath);
    expect(readAttachmentBodyFile(bodyPath, root)).toBe("Body text: résumé");
    expect(() => readAttachmentBodyFile(root, root)).toThrow("regular file");

    const largeBodyPath = join(root, "large.md");
    writeFileSync(largeBodyPath, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readAttachmentBodyFile(largeBodyPath, root)).toThrow("no larger than 1 MiB");
  });
});
