import { afterAll, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { completionCandidates } from "../src/services/completion.ts";

const root = mkdtempSync(join(tmpdir(), "ggh-completion-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function program(): Command {
  const command = new Command();
  const pr = command.command("pr").alias("prs").option("--json");
  pr.command("create").option("--base <branch>").option("--title <title>").option("--body-file <file>");
  command.command("status").alias("st");
  return command;
}

describe("command-tree completion", () => {
  test("resolves nested flags and aliases without suggesting subcommands inside option values", async () => {
    expect(await completionCandidates(program(), ["pr", "create", "--ba"], root)).toEqual(["--base"]);
    expect(await completionCandidates(program(), ["prs", "create", "--body"], root)).toEqual(["--body-file"]);
    expect(await completionCandidates(program(), ["pr", "create", "--title", "create", "--ba"], root)).toEqual(["--base"]);
    expect(await completionCandidates(program(), ["st"], root)).toEqual(["st", "status"]);
  });

  test("completes local filenames with spaces as a single candidate", async () => {
    writeFileSync(join(root, "proof image.png"), "synthetic proof");
    expect(await completionCandidates(program(), ["pr", "create", "--body-file", "proof"], root)).toEqual(["proof image.png"]);
  });

  for (const shell of ["bash", "zsh"]) {
    test.skipIf(process.platform === "win32" || !Bun.which(shell))(`executes nested flag completion in ${shell}`, async () => {
      const entry = join(import.meta.dir, "..", "bin", "ggh.ts");
      const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const shim = join(root, "ggh");
      writeFileSync(shim, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(entry)} "$@"\n`);
      chmodSync(shim, 0o700);
      const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root, GGH_NO_PLUGINS: "1", GGH_NO_RECORDS: "1" };
      const generated = Bun.spawn([process.execPath, entry, "completion", shell], { env, stdout: "pipe", stderr: "pipe" });
      const script = await new Response(generated.stdout).text();
      expect(await generated.exited).toBe(0);
      const file = join(root, `${shell}.completion`);
      writeFileSync(file, script);
      const invocation = shell === "bash"
        ? 'source "$1"; COMP_WORDS=(ggh pr create --ba); COMP_CWORD=3; _ggh_completions; printf "%s\\n" "${COMPREPLY[@]}"'
        : 'compdef() { :; }; compadd() { print -rl -- "${candidates[@]}"; }; source "$1"; words=(ggh prs create --ba); CURRENT=4; _ggh';
      const child = Bun.spawn([shell, ...(shell === "bash" ? ["--noprofile", "--norc"] : ["-f"]), "-c", invocation, "probe", file], { env, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      expect(output.trim().split("\n")).toEqual(["--base"]);
    });
  }

  for (const shell of ["fish", "pwsh"]) {
    test.skipIf(!Bun.which(shell))(`executes registered nested completion in ${shell}`, async () => {
      const entry = join(import.meta.dir, "..", "bin", "ggh.ts");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const shim = join(root, process.platform === "win32" ? "ggh.cmd" : "ggh");
      writeFileSync(shim, process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
      if (process.platform !== "win32") chmodSync(shim, 0o700);
      const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: root, GGH_NO_PLUGINS: "1", GGH_NO_RECORDS: "1" };
      const generated = Bun.spawn([process.execPath, entry, "completion", shell], { env, stdout: "pipe", stderr: "pipe" });
      const file = join(root, `${shell}.completion`);
      writeFileSync(file, await new Response(generated.stdout).text());
      expect(await generated.exited).toBe(0);
      let args: string[];
      if (shell === "fish") args = ["-c", 'source $argv[1]; complete -C "ggh pr create --ba"', file];
      else {
        const probe = join(root, "complete.ps1");
        writeFileSync(probe, 'param($Completion)\n. $Completion\n$line = "ggh pr create --ba"\n(TabExpansion2 -inputScript $line -cursorColumn $line.Length).CompletionMatches | ForEach-Object { $_.ListItemText }\n');
        args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", probe, "-Completion", file];
      }
      const child = Bun.spawn([shell, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
      expect(output.trim().split(/\r?\n/)).toEqual(["--base"]);
    });
  }
});
