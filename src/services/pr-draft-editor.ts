import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { privateTemporaryDirectory } from "./private-storage.ts";
import { parseCommandArguments } from "../utils/command-args.ts";
import { run } from "../utils/exec.ts";

export interface PrDraft { title: string; body: string }
export interface PrDraftSession {
  path: string;
  draft: PrDraft;
  removeGeneratedDraft(): void;
}

export class PrDraftEditorError extends Error {
  constructor(message: string, readonly retainedPath: string | undefined, cause: unknown) {
    super(message, { cause });
    this.name = "PrDraftEditorError";
  }
}

export function readPrDraft(path: string): PrDraft {
  const info = statSync(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("PR draft must be a regular UTF-8 file no larger than 1 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  const newline = text.indexOf("\n");
  const title = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/, "");
  // eslint-disable-next-line no-control-regex
  if (!title.trim() || title.length > 256 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("PR draft needs a nonempty first-line title, at most 256 characters, without control characters.");
  const rest = newline < 0 ? "" : text.slice(newline + 1);
  if (rest && !rest.startsWith("\n") && !rest.startsWith("\r\n")) throw new Error("Separate the PR title and Markdown body with a blank line.");
  return { title, body: rest.startsWith("\r\n") ? rest.slice(2) : rest.startsWith("\n") ? rest.slice(1) : "" };
}

export async function editPrDraft(seed: PrDraft, cwd: string, file?: string): Promise<PrDraftSession> {
  let directory: string | undefined;
  let path: string;
  if (file === undefined) {
    directory = privateTemporaryDirectory("good-gh-pr-draft-");
    path = join(directory, "pull-request.md");
  } else path = resolve(cwd, file);
  try {
    if (directory) writeFileSync(path, `${seed.title}\n\n${seed.body}`, { mode: 0o600 });
    else if (!statSync(path).isFile()) throw new Error("PR draft must be a regular file.");
    const editor = (await run("git", ["var", "GIT_EDITOR"], { cwd })).stdout.trim();
    const argv = existsSync(editor) && statSync(editor).isFile() ? [editor] : parseCommandArguments(editor);
    const executable = argv.shift();
    if (!executable) throw new Error("Configure an editor with git config core.editor, GIT_EDITOR, VISUAL, or EDITOR.");
    await run(executable, [...argv, path], { cwd, stdio: "inherit", timeoutMs: 0 });
    return { path, draft: readPrDraft(path), removeGeneratedDraft: () => { if (directory) rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    throw new PrDraftEditorError(error instanceof Error ? error.message : String(error), existsSync(path) ? path : undefined, error);
  }
}
