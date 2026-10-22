import { run } from "../../utils/exec.ts";
import type { ReviewThreadsResult } from "../github/review-threads.ts";
import type { ReviewMark } from "./ledger.ts";

export interface ReviewSince {
  fromHead: string;
  rewritten: boolean;
  commits: Array<{ sha: string; subject: string }>;
  files: string[];
  threadsChanged: ReviewThreadsResult;
  rangeDiff?: string;
  ambiguity?: string;
}

export async function reviewChanges(input: {
  cwd: string; fromHead: string; headSha: string; mergeBase: string; mark?: ReviewMark; threads: ReviewThreadsResult;
}): Promise<ReviewSince> {
  const { cwd, fromHead, headSha, mergeBase, mark, threads } = input;
  const ancestor = await run("git", ["merge-base", "--is-ancestor", fromHead, headSha], { cwd, reject: false });
  if (ancestor.exitCode > 1) throw new Error("Cannot compare the previous review head. Fetch its commit or start a full review.");
  const rewritten = ancestor.exitCode === 1;
  const commits = await run("git", ["log", "--format=%H%x00%s", "--reverse", `${fromHead}..${headSha}`, "--"], { cwd });
  const files = await run("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", fromHead, headSha, "--"], { cwd });
  const result: ReviewSince = {
    fromHead, rewritten,
    commits: commits.stdout.trim().split("\n").filter(Boolean).map(line => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    }),
    files: files.stdout.split("\0").filter(Boolean), threadsChanged: threads,
  };
  if (rewritten) {
    const oldBase = mark?.mergeBase ?? (await run("git", ["merge-base", fromHead, headSha], { cwd })).stdout.trim();
    const diff = await run("git", ["range-diff", "--no-color", "--no-ext-diff", `${oldBase}..${fromHead}`, `${mergeBase}..${headSha}`], { cwd });
    result.rangeDiff = diff.stdout;
    result.ambiguity = "History was rewritten. Range-diff matches patches heuristically; inspect the full PR if matches are ambiguous.";
  }
  return result;
}
