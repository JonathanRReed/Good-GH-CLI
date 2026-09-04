import { Command } from "commander";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { clampLimit, gh, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, header, p, pc, promptSecretInput, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function buildSecretSetRequest(name: string, value: string): { args: string[]; input: string } {
  return { args: ["secret", "set", name], input: value };
}

export function registerSecretCommand(program: Command): void {
  const secret = program
    .command("secret [action] [name]")
    .alias("secrets")
    .description("List, set, and delete repository secrets")
    .option("--limit <n>", "Maximum secrets to list", "30")
    .option("-b, --body <value>", "Secret value")
    .option("--body-file <path>", "Read secret value from a file")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      action?: string,
      name?: string,
      options?: { limit?: string; body?: string; bodyFile?: string; yes?: boolean },
    ) => {
      header("GitHub Secrets");

      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !name)) {
        await listSecrets(options?.limit);
        return;
      }

      if (subcommand === "set" && name) {
        await setSecret(name, options);
        return;
      }

      if (subcommand === "delete" && name) {
        await deleteSecret(name, options);
        return;
      }

      unknownAction("secret", action, ["list", "set", "delete"]);
    });

  secret
    .command("list")
    .description("List secrets")
    .option("--limit <n>", "Maximum secrets to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Secrets");
      if (!(await requireAuth())) return;
      await listSecrets(options?.limit);
    });

  secret
    .command("set <name> [value]")
    .description("Set a secret")
    .option("-b, --body <value>", "Secret value")
    .option("--body-file <path>", "Read secret value from a file")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      name: string,
      value?: string,
      options?: { body?: string; bodyFile?: string; yes?: boolean },
    ) => {
      header("GitHub Secrets");
      if (!(await requireAuth())) return;
      await setSecret(name, {
        body: options?.body ?? value,
        bodyFile: options?.bodyFile,
        yes: options?.yes,
      });
    });

  secret
    .command("delete <name>")
    .description("Delete a secret")
    .option("-y, --yes", "Skip confirmation")
    .action(async (name: string, options?: { yes?: boolean }) => {
      header("GitHub Secrets");
      if (!(await requireAuth())) return;
      await deleteSecret(name, options);
    });

  async function listSecrets(limit?: string): Promise<void> {
    const max = clampLimit(Number.parseInt(limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching secrets...");
    try {
      const { stdout } = await gh(["secret", "list", "--json", "name,updatedAt"]);
      const rows = parseJsonResponse<unknown[]>(stdout, []).slice(0, max);
      s.stop(`Loaded ${pc.green(String(rows.length))} secret(s).`);
      if (jsonOut(rows)) return;
      if (rows.length === 0) {
        p.log.info(pc.dim("No secrets found."));
        return;
      }
      for (const row of rows as Array<{ name: string; updatedAt?: string }>) {
        p.log.message(`  ${pc.cyan(row.name)} ${pc.dim(row.updatedAt ? `(${row.updatedAt.slice(0, 10)})` : "")}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch secrets."));
      failFromGitHub(err);
    }
  }

  async function setSecret(name: string, options?: { body?: string; bodyFile?: string; yes?: boolean }): Promise<void> {
    let value = options?.body;
    if (!value && options?.bodyFile) {
      // gh secret set --body-file exists in newer versions; otherwise we read the file ourselves.
      try {
        const fs = await import("node:fs");
        value = fs.readFileSync(options.bodyFile, "utf-8");
      } catch (err) {
        fail(`Could not read secret file: ${String(err)}`);
        return;
      }
    }
    if (!value) {
      if (dryRun(`set secret ${name}`)) return;
      const typed = await promptSecretInput({
        message: `Secret value for ${name}:`,
        validate: (v) => (!v ? "Secret value required" : undefined),
      });
      if (!typed) {
        p.cancel("Cancelled.");
        return;
      }
      value = typed;
    }

    if (dryRun(`set secret ${name}`)) return;

    if (!(await confirmOrAbort(`Set secret ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;

    const s = p.spinner();
    s.start(`Setting secret ${name}...`);
    try {
      const request = buildSecretSetRequest(name, value);
      await gh(request.args, { input: request.input });
      s.stop(pc.green("Secret set."));
      if (jsonOut({ name, action: "set" })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to set secret."));
      failFromGitHub(err);
    }
  }

  async function deleteSecret(name: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`delete secret ${name}`)) return;
    if (!(await confirmOrAbort(`Delete secret ${pc.bold(name)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Deleting secret ${name}...`);
    try {
      await gh(["secret", "delete", name, "--yes"]);
      s.stop(pc.green("Secret deleted."));
      if (jsonOut({ name, action: "delete" })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to delete secret."));
      failFromGitHub(err);
    }
  }
}
