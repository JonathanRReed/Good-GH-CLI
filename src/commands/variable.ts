import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { clampLimit, gh, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, header, p, pc, promptInput, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function registerVariableCommand(program: Command): void {
  const variable = program
    .command("variable [action] [name]")
    .alias("variables")
    .description("List, set, and delete repository variables")
    .option("--limit <n>", "Maximum variables to list", "30")
    .option("-b, --body <value>", "Variable value")
    .option("--body-file <path>", "Read variable value from a file")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      action?: string,
      name?: string,
      options?: { limit?: string; body?: string; bodyFile?: string; yes?: boolean },
    ) => {
      header("GitHub Variables");

      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !name)) {
        await listVariables(options?.limit);
        return;
      }

      if (subcommand === "set" && name) {
        await setVariable(name, options);
        return;
      }

      if (subcommand === "delete" && name) {
        await deleteVariable(name, options);
        return;
      }

      unknownAction("variable", action, ["list", "set", "delete"]);
    });

  variable
    .command("list")
    .description("List variables")
    .option("--limit <n>", "Maximum variables to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Variables");
      if (!(await requireAuth())) return;
      await listVariables(options?.limit);
    });

  variable
    .command("set <name> [value]")
    .description("Set a variable")
    .option("-b, --body <value>", "Variable value")
    .option("--body-file <path>", "Read variable value from a file")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      name: string,
      value?: string,
      options?: { body?: string; bodyFile?: string; yes?: boolean },
    ) => {
      header("GitHub Variables");
      if (!(await requireAuth())) return;
      await setVariable(name, {
        body: options?.body ?? value,
        bodyFile: options?.bodyFile,
        yes: options?.yes,
      });
    });

  variable
    .command("delete <name>")
    .description("Delete a variable")
    .option("-y, --yes", "Skip confirmation")
    .action(async (name: string, options?: { yes?: boolean }) => {
      header("GitHub Variables");
      if (!(await requireAuth())) return;
      await deleteVariable(name, options);
    });

  async function listVariables(limit?: string): Promise<void> {
    const max = clampLimit(Number.parseInt(limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching variables...");
    try {
      const { stdout } = await gh(["variable", "list", "--json", "name,updatedAt"]);
      const rows = parseJsonResponse<unknown[]>(stdout, []).slice(0, max);
      s.stop(`Loaded ${pc.green(String(rows.length))} variable(s).`);
      if (jsonOut(rows)) return;
      if (rows.length === 0) {
        p.log.info(pc.dim("No variables found."));
        return;
      }
      for (const row of rows as Array<{ name: string; updatedAt?: string }>) {
        p.log.message(`  ${pc.cyan(row.name)} ${pc.dim(row.updatedAt ? `(${row.updatedAt.slice(0, 10)})` : "")}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch variables."));
      failFromGitHub(err);
    }
  }

  async function setVariable(
    name: string,
    options?: { body?: string; bodyFile?: string; yes?: boolean },
  ): Promise<void> {
    let value = options?.body;
    if (!value && options?.bodyFile) {
      try {
        const fs = await import("node:fs");
        value = fs.readFileSync(options.bodyFile, "utf-8");
      } catch (err) {
        fail(`Could not read variable file: ${String(err)}`);
        return;
      }
    }
    if (!value) {
      if (dryRun(`set variable ${name}`)) return;
      const typed = await promptInput({
        message: `Variable value for ${name}:`,
        validate: (v) => (!v ? "Variable value required" : undefined),
      });
      if (!typed) {
        p.cancel("Cancelled.");
        return;
      }
      value = typed;
    }

    if (dryRun(`set variable ${name}`)) return;

    if (!(await confirmOrAbort(`Set variable ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;

    const s = p.spinner();
    s.start(`Setting variable ${name}...`);
    try {
      await gh(["variable", "set", name], { input: value });
      s.stop(pc.green("Variable set."));
      if (jsonOut({ name, action: "set" })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to set variable."));
      failFromGitHub(err);
    }
  }

  async function deleteVariable(name: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`delete variable ${name}`)) return;
    if (!(await confirmOrAbort(`Delete variable ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Deleting variable ${name}...`);
    try {
      await gh(["variable", "delete", name, "--yes"]);
      s.stop(pc.green("Variable deleted."));
      if (jsonOut({ name, action: "delete" })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to delete variable."));
      failFromGitHub(err);
    }
  }
}
