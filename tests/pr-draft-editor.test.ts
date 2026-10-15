import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editPrDraft, readPrDraft, PrDraftEditorError } from "../src/services/pr-draft-editor.ts";
import { setFlags } from "../src/services/runtime.ts";

const roots: string[] = [];
const originalEditor = process.env.GIT_EDITOR;
afterEach(() => {
  if (originalEditor === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = originalEditor;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(): string { const root = mkdtempSync(join(tmpdir(), "ggh-editor-test-")); roots.push(root); return root; }
test("configured editor writes Unicode and multiline Markdown, and user files survive cleanup", async () => {
  setFlags({ json: false, agent: false, noInput: false, dryRun: false });
  const root = directory(), script = join(root, "editor script.ts"), file = join(root, "draft.md");
  writeFileSync(file, "Old title\n\nOld body");
  writeFileSync(script, 'await Bun.write(process.argv[2]!, "Résumé 🌍\\n\\n## Changes\\n\\n- Café\\n- Done\\n");');
  process.env.GIT_EDITOR = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  const session = await editPrDraft({ title: "seed", body: "body" }, root, file);
  expect(session.draft).toEqual({ title: "Résumé 🌍", body: "## Changes\n\n- Café\n- Done\n" });
  session.removeGeneratedDraft();
  expect(readPrDraft(file)).toEqual(session.draft);
});
test("failed editor preserves a recoverable generated draft", async () => {
  const root = directory(), script = join(root, "fail.ts");
  writeFileSync(script, "process.exit(7);");
  process.env.GIT_EDITOR = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  let retainedPath: string | undefined;
  try { await editPrDraft({ title: "Keep me", body: "Line one\nLine two" }, root); } catch (error) { expect(error).toBeInstanceOf(PrDraftEditorError); if (error instanceof PrDraftEditorError) retainedPath = error.retainedPath; }
  expect(retainedPath).toBeDefined();
  if (!retainedPath) throw new Error("Expected retained draft");
  const path = retainedPath;
  expect(readFileSync(path, "utf8")).toBe("Keep me\n\nLine one\nLine two");
  rmSync(join(path, ".."), { recursive: true, force: true });
});
