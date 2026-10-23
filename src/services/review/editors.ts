import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseCommandArguments, quoteShellArgument } from "../../utils/command-args.ts";
import { commandExists, run } from "../../utils/exec.ts";
import { privateTemporaryDirectory } from "../private-storage.ts";

export interface ReviewEditor {
  kind: "code" | "cursor" | "zed" | "difftool";
  command: string;
  args: string[];
}

export function detectReviewEditor(env = process.env, available = commandExists): ReviewEditor | undefined {
  function parse(value: string | undefined, explicit = false): ReviewEditor | undefined {
    if (!value?.trim()) return undefined;
    const argv = existsSync(value) && statSync(value).isFile() ? [value] : parseCommandArguments(value);
    const [command, ...args] = argv;
    if (!command || !available(command)) {
      if (explicit) throw new Error("GGH_REVIEW_EDITOR is not executable.");
      return undefined;
    }
    const name = basename(command).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    const kind = name === "code" || name === "cursor" || name === "zed" ? name : "difftool";
    if (!explicit && kind === "difftool" && !["idea", "subl", "sublime_text", "mate", "gvim", "mvim", "gedit", "kate"].includes(name)) return undefined;
    return { kind, command, args: args.filter(arg => !["--wait", "-w", "--foreground"].includes(arg)) };
  }
  if (env.GGH_REVIEW_EDITOR) return parse(env.GGH_REVIEW_EDITOR, true);
  for (const value of [env.VISUAL, env.EDITOR, "code", "cursor", "zed", "idea"]) {
    const editor = parse(value);
    if (editor) return editor;
  }
  return undefined;
}

export function editorInvocation(editor: ReviewEditor, checkout: string, pairs: Array<[string, string]>, incremental: boolean): string[] {
  if (editor.kind === "code" || editor.kind === "cursor") return [editor.command, ...editor.args, checkout];
  if (editor.kind === "zed") return [editor.command, ...editor.args, ...pairs.flatMap(pair => ["--diff", ...pair])];
  if (incremental && pairs.length === 0) return [];
  return [editor.command, ...editor.args, checkout];
}

export async function launchReviewGui(argv: string[], cwd: string): Promise<void> {
  if (!argv.length) return;
  const child = Bun.spawn(argv, { cwd, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

export async function materializeReviewPairs(cwd: string, from: string, head: string, files: string[]): Promise<Array<[string, string]>> {
  const root = privateTemporaryDirectory("review-");
  const exec = promisify(execFile);
  const pairs: Array<[string, string]> = [];
  const changes = (await run("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", from, head, "--"], { cwd })).stdout.split("\0");
  const oldPaths = new Map<string, string>();
  for (let i = 0; i < changes.length;) {
    const status = changes[i++];
    const path = changes[i++];
    if (status?.startsWith("R")) {
      const next = changes[i++];
      if (path !== undefined && next !== undefined) oldPaths.set(next, path);
    }
  }
  // File names from git are untrusted. Use indexed temp paths, never repository paths.
  for (const [index, file] of files.entries()) {
    const pair: [string, string] = [join(root, "base", String(index), basename(file)), join(root, "head", String(index), basename(file))];
    for (const [side, revision] of [[0, from], [1, head]] as const) {
      const path = pair[side];
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const sourcePath = side === 0 ? oldPaths.get(file) ?? file : file;
      const listed = await run("git", ["ls-tree", "-z", revision, "--", `:(literal)${sourcePath}`], { cwd });
      const [mode, , oid] = listed.stdout.split("\t")[0]!.split(" ");
      const content = mode === "160000" ? Buffer.from(`Subproject commit ${oid}\n`)
        : listed.stdout ? (await exec("git", ["cat-file", "blob", `${revision}:${sourcePath}`], { cwd, encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })).stdout
        : Buffer.alloc(0);
      writeFileSync(path, content, { mode: 0o600 });
    }
    pairs.push(pair);
  }
  return pairs;
}

export async function openReviewEditor(input: {
  editor: ReviewEditor; cwd: string; from: string; head: string; files: string[]; incremental: boolean;
}): Promise<string | undefined> {
  const { editor, cwd, from, head, files, incremental } = input;
  if (incremental && !files.length) return undefined;
  if (editor.kind === "code" || editor.kind === "cursor") {
    let hint: string | undefined;
    try {
      const extensions = await run(editor.command, [...editor.args, "--list-extensions"], { cwd, timeoutMs: 3_000 });
      if (!extensions.stdout.toLowerCase().split(/\r?\n/).includes("github.vscode-pull-request-github")) hint = `Install GitHub Pull Requests in ${editor.kind} for PR diffs and comments.`;
    } catch { /* An unavailable extension probe does not prove the extension is missing. */ }
    await launchReviewGui(editorInvocation(editor, cwd, [], incremental), cwd);
    if (incremental) {
      const pairs = await materializeReviewPairs(cwd, from, head, files);
      for (const pair of pairs) await launchReviewGui([editor.command, ...editor.args, "--diff", ...pair], cwd);
    }
    return hint;
  }
  if (!files.length) return undefined;
  if (editor.kind === "zed") {
    const pairs = await materializeReviewPairs(cwd, from, head, files);
    await launchReviewGui(editorInvocation(editor, cwd, pairs, incremental), cwd);
    return undefined;
  }
  const configured = await run("git", ["config", "--get", "diff.tool"], { cwd, reject: false });
  const args = ["difftool", "-y", "--dir-diff"];
  if (configured.exitCode !== 0) {
    if (basename(editor.command).replace(/\.exe$/i, "") !== "idea") throw new Error("Configure git diff.tool and difftool.<tool>.cmd for this editor, or use --pager.");
    args.push(`--extcmd=${[editor.command, ...editor.args, "diff"].map(quoteShellArgument).join(" ")}`);
  }
  // --no-symlinks prevents a directory diff tool from editing worktree files.
  await launchReviewGui(["git", ...args, "--no-symlinks", from, head, "--"], cwd);
  return undefined;
}
