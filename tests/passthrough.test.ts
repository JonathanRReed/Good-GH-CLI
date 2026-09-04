import { describe, expect, it } from "bun:test";
import { createProgram } from "../src/index.ts";
import { decideGitForward } from "../src/utils/passthrough.ts";

const program = await createProgram();
const forward = (...args: string[]) => decideGitForward(program, args).forward;

describe("git passthrough decision", () => {
  it("forwards explicitly with `ggh git` and `ggh --`", () => {
    expect(forward("git", "status")).toBe(true);
    expect(forward("--", "log", "--oneline")).toBe(true);
    expect(forward("git", "commit", "-m", "x")).toBe(true);
  });

  it("forwards commands ggh does not define", () => {
    expect(forward("push")).toBe(true);
    expect(forward("rebase", "-i", "HEAD~3")).toBe(true);
    expect(forward("add", ".")).toBe(true);
  });

  it("keeps ggh's own invocations", () => {
    expect(forward("status")).toBe(false);
    expect(forward("status", "--json")).toBe(false);
    expect(forward("log")).toBe(false);
    expect(forward("log", "-n", "5")).toBe(false);
    expect(forward("log", "--all", "--stat")).toBe(false);
    expect(forward("switch", "main")).toBe(false);
    expect(forward("checkout", "main")).toBe(false);
    expect(forward("sw", "-c", "feat/x")).toBe(false);
    expect(forward("commit")).toBe(false);
    expect(forward("commit", "-m", "fix: parser", "-y")).toBe(false);
    expect(forward("commit", "--amend", "--no-verify")).toBe(false);
    expect(forward("commit", "--dry-run")).toBe(false);
    expect(forward("config")).toBe(false);
    expect(forward("config", "set", "ai_provider", "grok")).toBe(false);
    expect(forward("config", "list", "--json")).toBe(false);
    expect(forward("worktree", "list")).toBe(false);
    expect(forward("stash")).toBe(false);
    expect(forward("clone")).toBe(false);
  });

  it("hands shadowed commands to git when the flags are git's", () => {
    expect(forward("status", "-s")).toBe(true);
    expect(forward("status", "--porcelain")).toBe(true);
    expect(forward("log", "--oneline")).toBe(true);
    expect(forward("log", "-p", "-3")).toBe(true);
    expect(forward("log", "--since=yesterday")).toBe(true);
    expect(forward("checkout", "-b", "feat/x")).toBe(true);
    expect(forward("checkout", "--", "src/app.ts")).toBe(true);
    expect(forward("switch", "-")).toBe(true);
    // --fixup is now a ggh option, so ggh handles it (better UX than raw git).
    expect(forward("commit", "-am", "wip")).toBe(true);
    // ggh's stash command handles push/save/list/pop/drop with -m; --index is git-only.
    expect(forward("stash", "push", "-m", "wip")).toBe(false);
    expect(forward("stash", "pop", "--index")).toBe(true);
    expect(forward("config", "user.name")).toBe(true);
    expect(forward("config", "--global", "user.email", "me@x")).toBe(true);
    expect(forward("worktree", "prune")).toBe(true);
    expect(forward("log", "main..feat", "--", "src/")).toBe(true);
  });

  it("does not forward commands that only exist in ggh, even with odd flags", () => {
    // Commander will report the unknown flag itself; git would not know these words.
    expect(forward("sync", "--nonsense")).toBe(false);
    expect(forward("undo", "--hard")).toBe(false);
    expect(forward("stack", "list", "--weird")).toBe(false);
  });

  it("explains the decision", () => {
    expect(decideGitForward(program, ["log", "--oneline"]).reason).toContain("--oneline");
    expect(decideGitForward(program, ["config", "user.name"]).reason).toContain("subcommand");
  });
});
