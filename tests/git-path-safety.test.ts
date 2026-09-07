import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  checkLargeFiles,
  discardFiles,
  getStatus,
  resolveConflict,
  stageFiles,
  unstageAll,
} from "../src/services/git.ts";
import {
  captureStagedSnapshot,
  executeSplitCommits,
} from "../src/services/git/split.ts";

let root: string;
function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function write(path: string, content = "original\n"): void {
  writeFileSync(join(root, path), content);
}
function save(): void {
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-path-safety-")));
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "nested"));
  write("file.txt");
  write("nested/file.txt");
  save();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repository-root and literal path boundaries", () => {
  it("stages the selected root path from a nested working directory", async () => {
    write("file.txt", "selected\n");
    write("nested/file.txt", "unselected\n");
    await stageFiles(["file.txt"], join(root, "nested"));
    expect(git("diff", "--cached", "--name-only")).toBe("file.txt");
    expect(git("show", ":file.txt")).toBe("selected");
  });
  it("does not expand a selected filename as a Git glob", async () => {
    write("[x].txt", "selected\n");
    write("x.txt", "private\n");
    await stageFiles(["[x].txt"], root);
    expect(git("diff", "--cached", "--name-only")).toBe("[x].txt");
  });
  it("discards the selected root path rather than the same name below cwd", async () => {
    write("file.txt", "discard\n");
    write("nested/file.txt", "keep\n");
    await discardFiles([{ path: "file.txt" }], join(root, "nested"));
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(root, "nested/file.txt"), "utf8")).toBe("keep\n");
  });
  it("does not discard other files matched by a selected filename", async () => {
    write("[x].txt");
    write("x.txt");
    save();
    write("[x].txt", "discard\n");
    write("x.txt", "keep\n");
    await discardFiles([{ path: "[x].txt" }], root);
    expect(readFileSync(join(root, "[x].txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("keep\n");
  });
  it.skipIf(process.platform === "win32")(
    "treats pathspec magic in filenames literally when staging and discarding",
    async () => {
      const path = ":(glob)*.txt";
      write(path);
      write("other.txt");
      await stageFiles([path], root);
      expect(git("diff", "--cached", "--name-only")).toBe(path);
      save();
      write(path, "discard\n");
      write("other.txt", "keep\n");
      await discardFiles([{ path }], root);
      expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("keep\n");
    },
  );
  it("restores both sides of a staged rename", async () => {
    git("mv", "file.txt", "renamed.txt");
    await discardFiles((await getStatus(root)).staged, root);
    expect(existsSync(join(root, "file.txt"))).toBe(true);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(root, "renamed.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("refuses to overwrite an untracked file at a staged rename source", async () => {
    git("mv", "file.txt", "renamed.txt");
    write("file.txt", "private recreated file\n");
    await expect(
      discardFiles((await getStatus(root)).staged, root),
    ).rejects.toThrow(/untracked/i);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe(
      "private recreated file\n",
    );
    expect(existsSync(join(root, "renamed.txt"))).toBe(true);
  });
  it("can explicitly discard an untracked rename source without deleting its restored version", async () => {
    git("mv", "file.txt", "renamed.txt");
    write("file.txt", "discard this recreation\n");
    const status = await getStatus(root);
    await discardFiles(
      [
        ...status.staged,
        ...status.untracked.map((f) => ({ ...f, untracked: true })),
      ],
      root,
    );
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original\n");
    expect(git("status", "--porcelain")).toBe("");
  });
  it("resolves the selected root conflict from a nested working directory", async () => {
    git("checkout", "-b", "other");
    write("file.txt", "theirs\n");
    save();
    git("checkout", "main");
    write("file.txt", "ours\n");
    save();
    expect(() => git("merge", "other")).toThrow();
    await resolveConflict("file.txt", "theirs", join(root, "nested"));
    expect((await getStatus(root)).conflicts).toEqual([]);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("theirs\n");
    expect(readFileSync(join(root, "nested/file.txt"), "utf8")).toBe(
      "original\n",
    );
  });
  it("checks staged objects across the entire repository from a subdirectory", async () => {
    write("file.txt", "staged root\n");
    write("nested/file.txt", "staged nested\n");
    git("add", "-A");
    const result = await checkLargeFiles(
      (await getStatus(root)).staged,
      join(root, "nested"),
    );
    expect(result).toEqual({ blocked: [], warnings: [] });
  });
  it("captures and splits all staged paths from a subdirectory", async () => {
    write("file.txt", "staged root\n");
    write("nested/file.txt", "staged nested\n");
    git("add", "-A");
    const snapshot = await captureStagedSnapshot(join(root, "nested"));
    expect(snapshot.files.map((f) => f.path).sort()).toEqual([
      "file.txt",
      "nested/file.txt",
    ]);
    await executeSplitCommits(snapshot, [
      { subject: "split", body: "", files: snapshot.files.map((f) => f.path) },
    ]);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "HEAD:file.txt")).toBe("staged root");
    expect(git("show", "HEAD:nested/file.txt")).toBe("staged nested");
  });
  it("unstages the whole repository from a subdirectory", async () => {
    write("file.txt", "keep root\n");
    write("nested/file.txt", "keep nested\n");
    git("add", "-A");
    await unstageAll(join(root, "nested"));
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("keep root\n");
  });
  it("unstages an unborn repository without deleting working files", async () => {
    git("update-ref", "-d", "HEAD");
    await unstageAll(join(root, "nested"));
    expect(git("ls-files")).toBe("");
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original\n");
  });
  it("applies repository-relative review patches from a subdirectory", async () => {
    write("file.txt", "updated\n");
    const patch = execFileSync("git", ["diff"], {
      cwd: root,
      encoding: "utf8",
    });
    git("restore", "--", "file.txt");
    await applyPatch(patch, join(root, "nested"));
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("updated\n");
    expect(readFileSync(join(root, "nested/file.txt"), "utf8")).toBe(
      "original\n",
    );
  });
  it("fails closed rather than reporting a corrupt index as clean", async () => {
    write(".git/index", "invalid index");
    await expect(getStatus(root)).rejects.toThrow(/index|status/i);
  });
  it("discards a partially staged addition once and returns valid JSON", async () => {
    write("new.txt", "staged\n");
    git("add", "new.txt");
    write("new.txt", "unstaged\n");
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "bin", "ggh.ts"),
        "discard",
        "--all",
        "--yes",
        "--json",
      ],
      {
        cwd: root,
        env: { ...process.env, GGH_NO_PLUGINS: "1", NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr: code ? stderr : "" }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(JSON.parse(stdout)).toEqual({ discarded: ["new.txt"], count: 1 });
    expect(git("status", "--porcelain")).toBe("");
  });
});
