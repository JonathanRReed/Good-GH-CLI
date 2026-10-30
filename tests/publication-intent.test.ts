import { describe, expect, test } from "bun:test";
import {
  parsePublicationIntent,
  publicationIntent,
  type PublicationIntent,
} from "../src/services/publication-intent.ts";
import type {
  PullRequestPlan,
  RepositoryPlan,
} from "../src/services/publication.ts";

const tip = "0123456789abcdef0123456789abcdef01234567";

const repositoryPlan: RepositoryPlan = {
  kind: "repo",
  cwd: "/work",
  host: "github.com",
  target: "owner/project",
  remote: "origin",
  remoteUrl: "https://github.com/owner/project.git",
  pushUrl: "https://github.com/owner/project.git",
  visibility: "private",
  description: "Private project metadata",
  push: false,
  steps: ["create_repository"],
};

const pullRequestPlan: PullRequestPlan = {
  kind: "pr",
  cwd: "/work",
  root: "/work/repo",
  source: "/work/repo",
  host: "github.enterprise.test",
  target: "owner/project",
  remote: "origin",
  remoteUrl: "git@github.enterprise.test:owner/project.git",
  pushUrl: "git@github.enterprise.test:owner/project.git",
  visibility: "internal",
  remoteAtPrepare: "https://github.enterprise.test/owner/project.git",
  createRepository: false,
  head: "feature/change",
  headTip: tip,
  remoteHeadTip: tip,
  base: "main",
  baseTip: tip,
  mergeBaseTip: tip,
  steps: ["create_pull_request"],
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function copyIntent(intent: PublicationIntent): Record<string, unknown> {
  const value: unknown = JSON.parse(JSON.stringify(intent));
  return record(value);
}

function intentPlan(intent: Record<string, unknown>): Record<string, unknown> {
  const plan = record(intent.plan);
  intent.plan = plan;
  return plan;
}

describe("publication intent codec", () => {
  test("builds metadata-only repository intents without content", () => {
    const plan = {
      ...repositoryPlan,
      title: "do not save this",
      body: "do not save this either",
      sourceContent: "private source text",
    };
    const intent = publicationIntent(plan, { attachments: ["/tmp/image.png"] });

    expect(intent).toMatchObject({
      schemaVersion: 1,
      kind: "publication",
      requiresPrContent: false,
      requiresAttachments: false,
      requiresDescription: true,
      plan: { kind: "repo", target: "owner/project" },
    });
    expect(intent.plan).not.toHaveProperty("description");
    expect(intent.plan).not.toHaveProperty("title");
    expect(intent.plan).not.toHaveProperty("body");
    expect(intent.plan).not.toHaveProperty("sourceContent");
    expect(parsePublicationIntent(intent)).toEqual(intent);
  });

  test("round trips repository plans that target an empty remote", () => {
    const intent = publicationIntent({
      ...repositoryPlan,
      description: undefined,
      steps: ["create_repository"],
    });
    expect(parsePublicationIntent(intent)).toEqual(intent);
  });

  test("round trips required pull request metadata and optional remote tips", () => {
    const intent = publicationIntent(pullRequestPlan);
    expect(intent).toMatchObject({
      requiresPrContent: true,
      requiresAttachments: false,
      requiresDescription: false,
      plan: {
        kind: "pr",
        remoteHeadTip: tip,
        remoteAtPrepare: "https://github.enterprise.test/owner/project.git",
      },
    });
    expect(parsePublicationIntent(intent)).toEqual(intent);
    for (const remoteUrl of ["https://github.enterprise.test/owner/project", "ssh://git@github.enterprise.test:22/owner/project.git", "git@github.enterprise.test:owner/project"]) {
      const supported = publicationIntent({ ...pullRequestPlan, remoteUrl });
      expect(parsePublicationIntent(supported).plan.remoteUrl).toBe(remoteUrl);
    }
    const browser = publicationIntent(pullRequestPlan, { web: true, draft: true });
    expect(parsePublicationIntent(browser)).toMatchObject({ creationMode: "browser", draft: true });
  });

  test("rejects payloads, credentials, unknown steps, and malformed schemas", () => {
    const valid = publicationIntent(repositoryPlan);
    const withDescription = copyIntent(valid);
    intentPlan(withDescription).description = "secret text";
    const withCredentialUrl = copyIntent(valid);
    intentPlan(withCredentialUrl).remoteUrl =
      "https://token@github.com/owner/project.git";
    const withUnknownStep = copyIntent(valid);
    intentPlan(withUnknownStep).steps = ["run-arbitrary-command"];
    const withSchemaVersion = copyIntent(valid);
    withSchemaVersion.schemaVersion = 2;
    const withArbitraryArgument = copyIntent(valid);
    intentPlan(withArbitraryArgument).argv = ["--upload"];

    for (const raw of [
      withDescription,
      withCredentialUrl,
      withUnknownStep,
      withSchemaVersion,
      withArbitraryArgument,
    ]) {
      expect(() => parsePublicationIntent(raw)).toThrow(
        "Invalid publication intent",
      );
    }
  });

  test("rejects invalid paths, tips, host and target mismatches, and oversized data", () => {
    const valid = publicationIntent(pullRequestPlan);
    const invalidPath = copyIntent(valid);
    intentPlan(invalidPath).root = "relative/repo";
    const invalidTip = copyIntent(valid);
    intentPlan(invalidTip).headTip = "not-a-commit";
    const mismatchedHost = copyIntent(valid);
    intentPlan(mismatchedHost).host = "other.example";
    const oversized = copyIntent(valid);
    intentPlan(oversized).target = "x/" + "a".repeat(40_000);

    for (const raw of [invalidPath, invalidTip, mismatchedHost, oversized]) {
      expect(() => parsePublicationIntent(raw)).toThrow(
        "Invalid publication intent",
      );
    }
  });
});

test("round-trips independent local and live remote base snapshots", () => {
  const plan = { ...pullRequestPlan, localBaseTip: "a".repeat(40), remoteBaseTip: "b".repeat(40) };
  expect(parsePublicationIntent(publicationIntent(plan)).plan).toEqual(plan);
  for (const field of ["localBaseTip", "remoteBaseTip"]) {
    const intent = copyIntent(publicationIntent(plan));
    intentPlan(intent)[field] = "not-a-commit";
    expect(() => parsePublicationIntent(intent)).toThrow("Invalid publication intent");
  }
});
