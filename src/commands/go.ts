import { Option, type Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectPath } from "../services/projects/discovery.ts";
import { getConfig } from "../services/config.ts";
import { getFlags, recordCompletedEffect } from "../services/runtime.ts";
import { refreshProjectIndex } from "../services/projects/index-store.ts";
import { readCloneStatus } from "../services/projects/status.ts";
import { renderProjectCard } from "../services/projects/view.ts";
import { parseCommandArguments } from "../utils/command-args.ts";
import { commandExists, run } from "../utils/exec.ts";
import { data, fail, jsonOut } from "../utils/ui.ts";
import { selectProject } from "./projects.ts";

export async function openProjectEditor(path: string): Promise<void> {
  const configured = process.env.VISUAL || process.env.EDITOR;
  const args = configured ? existsSync(configured) && statSync(configured).isFile() ? [configured] : parseCommandArguments(configured) : ["code", "cursor", "zed"].filter(commandExists).slice(0, 1);
  const executable = args.shift();
  if (!executable) throw new Error("No editor found. Set VISUAL or EDITOR, or install code, cursor, or zed.");
  await run(executable, [...args, path], { cwd: path, stdio: "inherit", timeoutMs: 0 });
}

export async function openProjectT3(path: string): Promise<void> {
  if (commandExists("t3")) { await run("t3", [path], { cwd: path, stdio: "inherit", timeoutMs: 10_000 }); return; }
  // Only use a scheme advertised by the installed application, never infer it from its name.
  if (process.platform === "darwin") {
    for (const base of ["/Applications", join(homedir(), "Applications")]) {
      const plist = join(base, "T3 Code.app", "Contents", "Info.plist");
      if (!existsSync(plist)) continue;
      const result = await run("plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist], { reject: false, timeoutMs: 3000 });
      if (result.exitCode !== 0) continue;
      const types: unknown = JSON.parse(result.stdout);
      if (Array.isArray(types) && types.some(type => type && typeof type === "object" && "CFBundleURLSchemes" in type && Array.isArray(type.CFBundleURLSchemes) && type.CFBundleURLSchemes.includes("t3"))) {
        throw new Error("T3 has a URL handler, but no verified route for opening a local project. Open this path in T3 Code, or install a t3 CLI.");
      }
    }
  }
  throw new Error("No t3 CLI or supported T3 URL scheme found. Open the project in T3 Code, or use ggh go --editor.");
}

export function registerGoCommand(program: Command): void {
  program.command("go <query>").description("Find a project and print its path or open it")
    .option("--wide", "Show full checkout details")
    .option("--print", "Print only the checkout path")
    .option("--editor", "Open in VISUAL, EDITOR, code, cursor, or zed")
    .option("--t3", "Open with an installed T3 CLI or URL scheme")
    .addOption(new Option("--shell", "Use the newline-safe shell path protocol").hideHelp())
    .action(async (query: string, options: { print?: boolean; editor?: boolean; t3?: boolean; shell?: boolean; wide?: boolean }) => {
      if ([options.print, options.editor, options.t3].filter(Boolean).length > 1 || options.shell && (!options.print || getFlags().json)) { fail("Choose one of --print, --editor, or --t3. --shell requires --print without JSON.", { code: "invalid_arguments" }); return; }
      const index = await refreshProjectIndex();
      const clone = await selectProject(index.clones, query); if (!clone) return;
      const requestedPath = clone.checkouts.find(checkout => checkout.path === projectPath(query))?.path;
      const checkout = clone.checkouts.find(checkout => checkout.path === requestedPath && existsSync(checkout.path)) ?? clone.checkouts.find(checkout => existsSync(checkout.path));
      if (!checkout) { fail("Project has no available checkout. Refresh projects after mounting or restoring it."); return; }
      const path = checkout.path;
      const target = options.print ? "cd" : options.editor ? "editor" : options.t3 ? "t3" : getConfig().go_default ?? "cd";
      if (!options.print && !getFlags().json) renderProjectCard({ clone, status: await readCloneStatus(clone) }, undefined, true, { wide: options.wide });
      if (target === "editor") {
        await openProjectEditor(path);
        recordCompletedEffect("editor_opened");
      } else if (target === "t3") {
        await openProjectT3(path);
        recordCompletedEffect("t3_opened");
      }
      if (jsonOut({ schemaVersion: 1, path, target })) return;
      // A valid path suffix prevents command substitution stripping path newlines.
      data(options.shell ? `${path}/.` : path);
    });
}
