import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { applyGlobalFlags, DRY_RUN_CAPABLE, JSON_CAPABLE, REPO_SCOPED } from "../src/utils/flags.ts";
import { createProgram } from "../src/index.ts";

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
});
