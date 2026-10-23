import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specimens, statusResponses } from "./cases.ts";
import { replayCli } from "./replay.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Real local Git generates all three porcelain formats; only CLI retrieval is replayed. */
export async function dirtyStatusCase(count: number) {
  const root = mkdtempSync(join(tmpdir(), "ggh-dirty-bench-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe", env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_DATE: "2026-10-22T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T12:00:00Z",
  } });
  try {
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
    for (const name of ["conflict.txt", "rename-old.txt", ...Array.from({ length: count - 3 }, (_, i) => `file-${i + 1}.txt`)]) writeFileSync(join(repo, name), "base\n");
    git("add", "."); git("commit", "-m", "base");
    git("checkout", "-b", "other"); writeFileSync(join(repo, "conflict.txt"), "other\n"); git("commit", "-am", "other");
    git("checkout", "main"); writeFileSync(join(repo, "conflict.txt"), "main\n"); git("commit", "-am", "main");
    try { git("merge", "other"); throw new Error("Expected a conflict"); } catch {
      if (!git("ls-files", "--unmerged").includes("conflict.txt")) throw new Error("Fixture did not conflict");
    }
    git("update-ref", "refs/remotes/origin/main", "HEAD"); git("config", "remote.origin.url", "https://offline.invalid/fixture/repo");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"); git("config", "branch.main.remote", "origin"); git("config", "branch.main.merge", "refs/heads/main");
    git("mv", "rename-old.txt", "rename-new.txt"); writeFileSync(join(repo, "untracked.txt"), "new\n");
    const expected = [
      { label: "branch main and upstream origin/main", pattern: '# branch\\.head main[\\s\\S]*# branch\\.upstream origin/main|^## main\\.\\.\\.origin/main$|"branch":"main","head":"[a-f0-9]+","upstream":"origin/main"' },
      { label: "zero ahead and behind", pattern: '# branch\\.ab \\+0 -0|^## main\\.\\.\\.origin/main$|^\\{"contract":"ggh.agent",(?!.*"(?:ahead|behind)":)[^\\n]+\\}\\n?$' },
      { label: "unmerged UU conflict.txt", pattern: 'u UU [^\\n]* conflict\\.txt|^UU conflict\\.txt$|\\["UU","conflict.txt"\\]' },
      { label: "index rename with old and new paths", pattern: '2 R\\. [^\\n]* rename-new\\.txt\\trename-old\\.txt|^R  rename-old\\.txt -> rename-new\\.txt$|\\["R\\.","rename-new.txt","rename-old.txt"\\]' },
      { label: "untracked untracked.txt", pattern: '^\\?\\?? untracked\\.txt$|\\["\\?\\?","untracked.txt"\\]' },
    ];
    for (let i = 1; i <= count - 3; i++) {
      const name = `file-${i}.txt`;
      const xy = i % 3 === 1 ? "MM" : i % 3 === 2 ? "M." : ".M";
      writeFileSync(join(repo, name), "index\n");
      if (xy[0] === "M") git("add", name);
      if (xy[1] === "M") writeFileSync(join(repo, name), "worktree\n");
      expected.push({ label: `${xy} ${name} index/worktree state`, pattern: `1 ${escape(xy)} [^\\n]* ${escape(name)}$|^${escape(xy.replaceAll(".", " "))} ${escape(name)}$|${escape(JSON.stringify([xy, name]))}` });
    }
    const nativeOutput = git("status", "--porcelain=v2", "--branch");
    const nativeV1Output = git("status", "--porcelain=v1", "-b");
    const raw = git("status", "--porcelain=v2", "--branch", "-z", "-uall");
    const specimen = specimens[0]; if (!specimen) throw new Error("Missing status specimen");
    const responses = statusResponses(specimen).map(response => response.prefix[0] === "status" ? { ...response, stdout: raw } : response);
    const out = await replayCli(["status", "--agent"], responses);
    // Reconstruct the previous raw-record result using the same Git response and envelope.
    // This is a byte comparison of formats, not an execution of a previous binary.
    const previous = JSON.parse(out.stdout);
    previous.result.changes = raw.split("\0").filter(field => field && !field.startsWith("# "));
    const previousOutput = JSON.stringify(previous) + "\n";
    return { count, expected, nativeOutput, nativeV1Output, previousOutput, out };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
