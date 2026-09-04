import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { clampLimit, ghGlobal, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function registerGistCommand(program: Command): void {
  const gist = program
    .command("gist [action] [idOrFiles...]")
    .alias("gists")
    .description("List, view, create, edit, and delete GitHub Gists")
    .option("--limit <n>", "Maximum gists to list", "30")
    .option("-p, --public", "Create a public gist")
    .option("-d, --desc <text>", "Gist description")
    .option("--add <file>", "File to add when editing")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      action?: string,
      idOrFiles?: string[],
      options?: { limit?: string; public?: boolean; desc?: string; add?: string; yes?: boolean },
    ) => {
      header("GitHub Gists");

      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();
      const first = idOrFiles?.[0];

      if (subcommand === "list" || (!action && !first)) {
        await listGists(options?.limit);
        return;
      }

      if (subcommand === "view" && first) {
        await viewGist(first);
        return;
      }

      if (subcommand === "create") {
        const files = idOrFiles ?? [];
        if (files.length === 0) {
          fail("gist create requires at least one file path.");
          return;
        }
        await createGist(files, options);
        return;
      }

      if (subcommand === "edit" && first) {
        await editGist(first, options);
        return;
      }

      if (subcommand === "delete" && first) {
        await deleteGist(first, options);
        return;
      }

      unknownAction("gist", action, ["list", "view", "create", "edit", "delete"]);
    });

  gist
    .command("list")
    .description("List gists")
    .option("--limit <n>", "Maximum gists to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Gists");
      if (!(await requireAuth())) return;
      await listGists(options?.limit);
    });

  gist
    .command("view <id>")
    .description("View a gist")
    .action(async (id: string) => {
      header("GitHub Gists");
      if (!(await requireAuth())) return;
      await viewGist(id);
    });

  gist
    .command("create <files...>")
    .description("Create a gist from files")
    .option("-p, --public", "Create a public gist")
    .option("-d, --desc <text>", "Gist description")
    .option("-y, --yes", "Skip confirmation")
    .action(async (files: string[], options?: { public?: boolean; desc?: string; yes?: boolean }) => {
      header("GitHub Gists");
      if (!(await requireAuth())) return;
      await createGist(files, options);
    });

  gist
    .command("edit <id>")
    .description("Edit a gist")
    .option("--add <file>", "File to add when editing")
    .option("-d, --desc <text>", "Gist description")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, options?: { add?: string; desc?: string; yes?: boolean }) => {
      header("GitHub Gists");
      if (!(await requireAuth())) return;
      await editGist(id, options);
    });

  gist
    .command("delete <id>")
    .description("Delete a gist")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, options?: { yes?: boolean }) => {
      header("GitHub Gists");
      if (!(await requireAuth())) return;
      await deleteGist(id, options);
    });

  async function listGists(limit?: string): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const max = clampLimit(Number.parseInt(limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching gists...");
    try {
      const { stdout } = await ghGlobal(["api", `/gists?per_page=${max}`], { reject: false });
      const rows = parseJsonResponse<Array<{ id: string; description?: string; updated_at?: string }>>(stdout, []);
      s.stop(`Loaded ${pc.green(String(rows.length))} gist(s).`);
      if (jsonOut(rows)) return;
      if (rows.length === 0) {
        p.log.info(pc.dim("No gists found."));
        return;
      }
      for (const row of rows) {
        p.log.message(`  ${pc.bold(row.id)} ${pc.cyan(row.description ?? "")} ${pc.dim((row.updated_at ?? "").slice(0, 10))}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch gists."));
      failFromGitHub(err);
    }
  }

  async function viewGist(id: string): Promise<void> {
    const s = p.spinner();
    s.start(`Fetching gist ${id}...`);
    try {
      const { stdout } = await ghGlobal(["api", `/gists/${id}`], { reject: false });
      const data = parseJsonResponse(stdout, null);
      s.stop(data ? "Loaded." : "Not found.");
      if (!data) {
        fail(`Gist ${id} not found.`);
        return;
      }
      if (jsonOut(data)) return;
      const gist = data as { description?: string; html_url?: string; files?: Record<string, unknown> };
      p.log.step(pc.bold(gist.description ?? id));
      if (gist.html_url) p.log.message(`  URL: ${pc.dim(gist.html_url)}`);
      if (gist.files) {
        for (const [file] of Object.entries(gist.files)) {
          p.log.message(`  ${pc.dim("file")} ${pc.cyan(file)}`);
        }
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch gist."));
      failFromGitHub(err);
    }
  }

  async function createGist(files: string[], options?: { public?: boolean; desc?: string; yes?: boolean }): Promise<void> {
    if (dryRun(`create a gist from ${files.length} file(s)`)) return;
    if (!(await confirmOrAbort(`Create a ${options?.public ? "public" : "secret"} gist?`, { assumeYes: options?.yes }))) return;
    const args = ["gist", "create", ...files];
    if (options?.public) args.push("--public");
    if (options?.desc) args.push("--desc", options.desc);
    const s = p.spinner();
    s.start("Creating gist...");
    try {
      const { stdout } = await ghGlobal(args);
      s.stop(pc.green("Gist created."));
      if (jsonOut({ files, public: !!options?.public, url: stdout.trim() })) return;
      if (stdout.trim()) p.log.message(pc.dim(stdout.trim()));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to create gist."));
      failFromGitHub(err);
    }
  }

  async function editGist(id: string, options?: { add?: string; desc?: string; yes?: boolean }): Promise<void> {
    if (dryRun(`edit gist ${id}`)) return;
    if (!(await confirmOrAbort(`Edit gist ${pc.bold(id)}?`, { assumeYes: options?.yes }))) return;
    const args = ["gist", "edit", id];
    if (options?.add) args.push("--add", options.add);
    if (options?.desc) args.push("--desc", options.desc);
    const s = p.spinner();
    s.start(`Editing gist ${id}...`);
    try {
      await ghGlobal(args);
      s.stop(pc.green("Gist updated."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to edit gist."));
      failFromGitHub(err);
    }
  }

  async function deleteGist(id: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`delete gist ${id}`)) return;
    if (!(await confirmOrAbort(`Delete gist ${pc.bold(id)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Deleting gist ${id}...`);
    try {
      await ghGlobal(["gist", "delete", id, "--yes"]);
      s.stop(pc.green("Gist deleted."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to delete gist."));
      failFromGitHub(err);
    }
  }
}
