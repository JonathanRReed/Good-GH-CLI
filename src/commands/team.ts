import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  getCurrentBranch,
  getStackGraph,
  getStackAncestors,
  getStackDescendants,
  getRecentCommits,
  requireGitRepo,
} from "../services/git.ts";
import { getGitHubAuthStatus, ghGlobal, requireAuth } from "../services/github.ts";
import { emitJson, fail, failFromGitHub, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

interface StackSnapshot {
  user: string;
  branch: string;
  ancestors: string[];
  descendants: string[];
  recentCommits: string[];
  publishedAt: string;
}

export function registerTeamCommand(program: Command): void {
  const team = program
    .command("team [action]")
    .description("Publish your stack graph to a secret gist, or pull a teammate's stack")
    .option("--user <username>", "GitHub username to pull (for `pull` action)")
    .option("--gist <id>", "Gist ID to pull from (alternative to --user)")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText("after", `
Examples:
  ggh team publish -y
  ggh team pull --user octocat
  ggh team pull --gist abc123
  ggh team list --json`)
    .action(async (action?: string, options?: { user?: string; gist?: string; yes?: boolean }) => {
      header("Team Stacks");

      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "publish" || (!action && !options?.gist && !options?.user)) {
        const auth = await getGitHubAuthStatus();
        await publishStack(auth.login || "user", options);
        return;
      }

      if (subcommand === "pull" || subcommand === "view") {
        await pullStack(options);
        return;
      }

      if (subcommand === "list") {
        await listTeamGists();
        return;
      }

      unknownAction("team", action, ["publish", "pull", "list"]);
    });

  team
    .command("publish")
    .description("Publish your stack as a secret gist")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (options?: { yes?: boolean }) => {
      header("Team Stacks");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      const auth = await getGitHubAuthStatus();
      await publishStack(auth.login || "user", options);
    });

  team
    .command("pull")
    .alias("view")
    .description("Fetch a teammate's stack")
    .option("--user <username>", "GitHub username to pull")
    .option("--gist <id>", "Gist ID to pull from (alternative to --user)")
    .action(async (options?: { user?: string; gist?: string }) => {
      header("Team Stacks");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await pullStack(options);
    });

  team
    .command("list")
    .description("List your team-stack gists")
    .action(async () => {
      header("Team Stacks");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await listTeamGists();
    });

  async function buildSnapshot(user: string): Promise<StackSnapshot> {
    const graph = await getStackGraph();
    const branch = await getCurrentBranch();
    const ancestors = getStackAncestors(graph, branch);
    const descendants = getStackDescendants(graph, branch);
    const recentCommits = await getRecentCommits(10);

    return {
      user,
      branch,
      ancestors,
      descendants,
      recentCommits,
      publishedAt: new Date().toISOString(),
    };
  }

  async function publishStack(user: string, options?: { yes?: boolean }): Promise<void> {
    const snapshot = await buildSnapshot(user);

    if (getFlags().json) {
      // JSON mode skips human preview; dry-run still reports without publishing.
      if (dryRun(`publish stack to a secret gist`)) {
        emitJson({ ...snapshot, gistUrl: null, dryRun: true });
        return;
      }
    } else {
      p.log.step(`Publishing stack for ${pc.bold(pc.cyan(user))}:`);
      p.log.message(`  Branch:      ${pc.green(snapshot.branch)}`);
      p.log.message(`  Ancestors:   ${snapshot.ancestors.length > 0 ? snapshot.ancestors.join(" → ") : pc.dim("(root)")}`);
      p.log.message(`  Descendants: ${snapshot.descendants.length > 0 ? snapshot.descendants.join(", ") : pc.dim("(none)")}`);

      if (dryRun(`publish stack to a secret gist`)) return;

      if (!(await confirmOrAbort(`Publish stack as a secret gist?`, { assumeYes: options?.yes }))) return;
    }

    const content = JSON.stringify(snapshot, null, 2);
    const args = [
      "gist",
      "create",
      "--desc",
      `ggh-team-stack: ${user} on ${snapshot.branch}`,
      "--filename",
      "stack.json",
    ];

    // Pass content via stdin to avoid shell escaping issues
    const s = p.spinner();
    s.start("Publishing to a secret gist...");
    try {
      const { stdout } = await ghGlobal([...args], { input: content });
      const url = stdout.trim().split("\n").pop()?.trim() ?? "";
      s.stop(pc.green("Stack published!"));
      if (jsonOut({ ...snapshot, gistUrl: url })) return;
      p.log.success(pc.bold(pc.cyan(url)));
      const gistId = url.split("/").filter(Boolean).pop() ?? "";
      p.log.info(pc.dim(`Teammates can pull with: ggh team pull --gist ${gistId}`));

      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to publish."));
      failFromGitHub(err);
    }
  }

  async function pullStack(options?: { user?: string; gist?: string }): Promise<void> {
    let gistId = options?.gist;

    if (!gistId && options?.user) {
      // Find the user's most recent ggh-team-stack gist
      const s = p.spinner();
      s.start(`Searching for ${options.user}'s stack gist...`);
      try {
        const { stdout } = await ghGlobal(["gist", "list", "-L", "50", "--json", "id,description,updatedAt"]);
        const parsed = JSON.parse(stdout);
        const gists: Array<{ id: string; description: string; updatedAt: string }> = Array.isArray(parsed) ? parsed : [];
        const teamGist = gists.find((g) => (g.description ?? "").includes(`ggh-team-stack: ${options.user}`));
        s.stop(teamGist ? "Found." : "Not found.");
        if (!teamGist) {
          fail(`No team stack gist found for user "${options.user}". Ask them to run \`ggh team publish\`.`);
          return;
        }
        gistId = teamGist.id;
        p.log.info(pc.dim(`Found gist: ${gistId} (updated ${teamGist.updatedAt.slice(0, 10)})`));
      } catch (err) {
        s.stop(pc.red("Failed to search gists."));
        failFromGitHub(err);
        return;
      }
    }

    if (!gistId) {
      fail("Provide --gist <id> or --user <username>.");
      return;
    }

    const s = p.spinner();
    s.start(`Fetching gist ${gistId}...`);
    try {
      const { stdout } = await ghGlobal(["api", `/gists/${gistId}`]);
      const data = JSON.parse(stdout) as {
        description?: string;
        html_url?: string;
        files?: Record<string, { content?: string }>;
      };
      s.stop("Loaded.");

      const stackFile = data.files?.["stack.json"];
      if (!stackFile?.content) {
        fail("Gist does not contain a stack.json file.");
        return;
      }

      const parsed = JSON.parse(stackFile.content);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ancestors) || !Array.isArray(parsed.descendants)) {
        fail("Team stack gist contains invalid data.");
        return;
      }
      const snapshot = parsed as StackSnapshot;

      if (jsonOut({ ...snapshot, gistUrl: data.html_url })) return;

      p.log.step(`Stack for ${pc.bold(pc.cyan(snapshot.user))}:`);
      p.log.message(`  Branch:      ${pc.green(snapshot.branch)}`);
      p.log.message(`  Ancestors:   ${snapshot.ancestors.length > 0 ? snapshot.ancestors.join(" → ") : pc.dim("(root)")}`);
      p.log.message(`  Descendants: ${snapshot.descendants.length > 0 ? snapshot.descendants.join(", ") : pc.dim("(none)")}`);
      p.log.message(`  Published:   ${pc.dim(snapshot.publishedAt)}`);

      if (snapshot.recentCommits.length > 0) {
        p.log.step("Recent commits:");
        for (const c of snapshot.recentCommits) {
          p.log.message(`  ${pc.dim("•")} ${c}`);
        }
      }

      p.outro(pc.dim("Switch to a branch with `ggh switch <branch>`."));
    } catch (err) {
      s.stop(pc.red("Failed to fetch gist."));
      failFromGitHub(err);
    }
  }

  async function listTeamGists(): Promise<void> {
    const s = p.spinner();
    s.start("Fetching your gists...");
    try {
      const { stdout } = await ghGlobal(["gist", "list", "-L", "50", "--json", "id,description,updatedAt"]);
      const parsed = JSON.parse(stdout);
      const gists: Array<{ id: string; description: string; updatedAt: string }> = Array.isArray(parsed) ? parsed : [];
      s.stop("Loaded.");

      const teamGists = gists.filter((g) => (g.description ?? "").includes("ggh-team-stack"));

      if (jsonOut(teamGists)) return;

      if (teamGists.length === 0) {
        p.log.info(pc.dim("No team stack gists found. Publish with `ggh team publish`."));
        return;
      }

      p.log.step(`${teamGists.length} team stack(s):`);
      for (const g of teamGists) {
        const desc = g.description ?? "";
        const user = desc.replace("ggh-team-stack:", "").trim().split(" on ")[0] || "unknown";
        const branch = desc.split(" on ")[1] || "";
        p.log.message(`  ${pc.bold(g.id)} ${pc.cyan(user)} ${pc.dim(branch)} ${pc.dim((g.updatedAt ?? "").slice(0, 10))}`);
      }
      p.outro(pc.dim("Pull with `ggh team pull --gist <id>`."));
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }
}
