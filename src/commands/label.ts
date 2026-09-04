import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import {
  clampLimit,
  gh,
  requireAuth,
} from "../services/github.ts";
import { requireGitRepo } from "../services/git.ts";
import { dryRun } from "../utils/flags.ts";
import { failFromGitHub, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function registerLabelCommand(program: Command): void {
  const label = program
    .command("label [action] [name]")
    .alias("labels")
    .description("List, create, edit, and delete issue labels")
    .option("--limit <n>", "Maximum labels to list", "30")
    .option("-c, --color <color>", "Label color")
    .option("-d, --description <text>", "Label description")
    .option("--new-name <name>", "Rename a label")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      action?: string,
      name?: string,
      options?: {
        limit?: string; color?: string; description?: string; newName?: string; yes?: boolean;
      },
    ) => {
      header("GitHub Labels");

      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !name)) {
        await listLabels(options?.limit);
        return;
      }

      if (subcommand === "create" && name) {
        await createLabel(name, options);
        return;
      }

      if (subcommand === "edit" && name) {
        await editLabel(name, options);
        return;
      }

      if (subcommand === "delete" && name) {
        await deleteLabel(name, options);
        return;
      }

      unknownAction("label", action, ["list", "create", "edit", "delete"]);
    });

  label
    .command("list")
    .description("List labels")
    .option("--limit <n>", "Maximum labels to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Labels");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await listLabels(options?.limit);
    });

  label
    .command("create <name>")
    .description("Create a label")
    .option("-c, --color <color>", "Label color")
    .option("-d, --description <text>", "Label description")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      name: string,
      options?: { color?: string; description?: string; yes?: boolean },
    ) => {
      header("GitHub Labels");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await createLabel(name, options);
    });

  label
    .command("edit <name>")
    .description("Edit a label")
    .option("-c, --color <color>", "Label color")
    .option("-d, --description <text>", "Label description")
    .option("--new-name <name>", "Rename a label")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      name: string,
      options?: { color?: string; description?: string; newName?: string; yes?: boolean },
    ) => {
      header("GitHub Labels");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await editLabel(name, options);
    });

  label
    .command("delete <name>")
    .description("Delete a label")
    .option("-y, --yes", "Skip confirmation")
    .action(async (name: string, options?: { yes?: boolean }) => {
      header("GitHub Labels");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await deleteLabel(name, options);
    });

  async function listLabels(limit?: string): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const max = clampLimit(Number.parseInt(limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching labels...");
    try {
      const { stdout } = await gh(["label", "list", "-L", String(max), "--json", "name,color,description"]);
      const rows = parseJsonResponse<unknown[]>(stdout, []);
      s.stop(`Loaded ${pc.green(String(rows.length))} label(s).`);
      if (jsonOut(rows)) return;
      if (rows.length === 0) {
        p.log.info(pc.dim("No labels found."));
        return;
      }
      for (const row of rows as Array<{ name: string; color: string; description?: string }>) {
        p.log.message(`  ${pc.bold(`#${row.color}`)} ${pc.cyan(row.name)} ${pc.dim(row.description ?? "")}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch labels."));
      failFromGitHub(err);
    }
  }

  async function createLabel(
    name: string,
    options?: { color?: string; description?: string; yes?: boolean },
  ): Promise<void> {
    if (dryRun(`create label ${name}`)) return;
    if (!(await confirmOrAbort(`Create label ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;
    const args = ["label", "create", name];
    if (options?.color) args.push("--color", options.color.replace(/^#/, ""));
    if (options?.description) args.push("--description", options.description);
    const s = p.spinner();
    s.start(`Creating label ${name}...`);
    try {
      await gh(args);
      s.stop(pc.green("Label created."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to create label."));
      failFromGitHub(err);
    }
  }

  async function editLabel(
    name: string,
    options?: { color?: string; description?: string; newName?: string; yes?: boolean },
  ): Promise<void> {
    if (dryRun(`edit label ${name}`)) return;
    if (!(await confirmOrAbort(`Edit label ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;
    const args = ["label", "edit", name];
    if (options?.newName) args.push("--name", options.newName);
    if (options?.color) args.push("--color", options.color.replace(/^#/, ""));
    if (options?.description) args.push("--description", options.description);
    const s = p.spinner();
    s.start(`Editing label ${name}...`);
    try {
      await gh(args);
      s.stop(pc.green("Label updated."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to edit label."));
      failFromGitHub(err);
    }
  }

  async function deleteLabel(name: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`delete label ${name}`)) return;
    if (!(await confirmOrAbort(`Delete label ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Deleting label ${name}...`);
    try {
      await gh(["label", "delete", name, "--yes"]);
      s.stop(pc.green("Label deleted."));
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to delete label."));
      failFromGitHub(err);
    }
  }
}
