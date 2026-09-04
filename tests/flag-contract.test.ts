import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyGlobalFlags, DRY_RUN_CAPABLE, JSON_CAPABLE, REPO_SCOPED } from "../src/utils/flags.ts";
import { createProgram } from "../src/index.ts";

const commandsDir = join(import.meta.dir, "..", "src", "commands");

/** Source of every module that implements a command domain (`pr` → pr.ts, pr-create.ts, ...). */
function sourceFor(domain: string): string {
  const files = readdirSync(commandsDir).filter((f) => f === `${domain}.ts` || f.startsWith(`${domain}-`));
  return files.map((f) => readFileSync(join(commandsDir, f), "utf-8")).join("\n");
}

/**
 * The README promises that a flag a command advertises is a flag the command
 * honours. A domain listed as capable whose implementation never reads the
 * flag would accept `--dry-run` and then mutate anyway. This cannot prove the
 * flag is honoured on every path, but it stops the sets from drifting.
 */
const program = await createProgram();
const registered = new Set(program.commands.map((c) => c.name()));

describe("global flag contract", () => {

  it("delivers duplicated parent options to the selected subcommand", async () => {
    const testProgram = new Command();
    const domain = testProgram.command("plugin [action]").option("--from <path>");
    let received: string | undefined;
    domain
      .command("install")
      .option("--from <path>")
      .action((options: { from?: string }) => {
        received = options.from;
      });
    applyGlobalFlags(testProgram);

    await testProgram.parseAsync(["node", "test", "plugin", "install", "--from", "./trusted.ts"]);

    expect(received).toBe("./trusted.ts");
  });

  it("every advertised domain is a registered command", () => {
    for (const domain of [...JSON_CAPABLE, ...DRY_RUN_CAPABLE, ...REPO_SCOPED]) {
      expect(registered.has(domain), `${domain} is in a capability set but not registered`).toBe(true);
    }
  });

  for (const domain of JSON_CAPABLE) {
    it(`\`ggh ${domain} --json\` is implemented`, () => {
      const source = sourceFor(domain);
      expect(source.length, `no source found for ${domain}`).toBeGreaterThan(0);
      expect(/getFlags\(\)\.json|emitJson\(|jsonOut\(/.test(source), `${domain} advertises --json but never emits JSON`).toBe(true);
    });
  }

  for (const domain of DRY_RUN_CAPABLE) {
    it(`\`ggh ${domain} --dry-run\` is implemented`, () => {
      const source = sourceFor(domain);
      expect(source.length, `no source found for ${domain}`).toBeGreaterThan(0);
      expect(/isDryRun\(\)|dryRun\(/.test(source), `${domain} advertises --dry-run but never checks it`).toBe(true);
    });
  }

  it("commands that mutate the repository or remote advertise --dry-run", () => {
    // Anything that calls a mutating git/gh/fs helper should be previewable.
    // The (?<![\w.]) guard excludes method calls (`args.push(`, `map.commit(`),
    // so read-only builders like log/browse/completion don't false-positive.
    const mutating =
      /(?<![\w.])(?:commit\(|squashCommits|undoCommit|stashPush|stashPop|stashDrop|worktreeAdd|worktreeRemove|discardFiles|stageFiles|stageAll|unstageAll|switchBranch|renameBranch|applyPatch|resolveConflict|push\(|pullRebase|deleteLocalBranch|fetchPullRequestBranch|checkoutPullRequest|createPullRequest|mergePullRequest|setPullRequestState|commentOnPullRequest|editPullRequest|submitPullRequestReview|createIssue|setIssueState|commentOnIssue|createRelease|deleteRelease|uploadRelease|createRepository|rerunWorkflowRun|cancelWorkflowRun|writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync)\b/;
    for (const file of readdirSync(commandsDir)) {
      const domain = file.replace(/\.ts$/, "").split("-")[0] ?? "";
      if (["completion", "config", "status", "log", "clone", "api", "browse", "search", "notifications", "checks", "changelog", "switch", "resolve", "run", "plugin", "alias", "ignore", "mcp", "triage"].includes(domain)) continue;
      const source = readFileSync(join(commandsDir, file), "utf-8");
      if (mutating.test(source)) {
        expect(DRY_RUN_CAPABLE.has(domain), `${file} mutates but "${domain}" is not in DRY_RUN_CAPABLE`).toBe(true);
      }
    }
  });
});
