import { Command } from "commander";
import { gh } from "../services/github.ts";
import { fail, failFromGitHub, header } from "../utils/ui.ts";

export function registerBrowseCommand(program: Command): void {
  program
    .command("browse [path]")
    .description("Open the repository in a browser")
    .action(async (path?: string) => {
      header("Browse");
      const args = ["browse"];
      if (path) args.push(path);
      try {
        const { exitCode } = await gh(args, { stdio: "inherit", reject: false });
        if (exitCode !== 0) {
          fail("Could not open the repository in a browser.");
        }
      } catch (err) {
        failFromGitHub(err);
      }
    });
}
