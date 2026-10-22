import { commandExists, run } from "../../utils/exec.ts";
import { renderDiff } from "../../utils/ui.ts";

export type ReviewPager = "tuicr" | "delta" | "renderer";
export function detectReviewPager(incremental: boolean, available = commandExists): ReviewPager {
  // tuicr's PR view cannot restrict itself to a locally marked revision range.
  if (!incremental && available("tuicr")) return "tuicr";
  return available("delta") ? "delta" : "renderer";
}

export async function showReviewPager(input: { pager: ReviewPager; pr: number; cwd: string; from: string; head: string; repo: string; host: string }): Promise<void> {
  const { pager, pr, cwd, from, head } = input;
  if (pager === "tuicr") { await run("tuicr", ["pr", String(pr)], { cwd, stdio: "inherit", env: { GH_REPO: input.repo, GH_HOST: input.host } }); return; }
  const diff = await run("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", from, head, "--"], { cwd });
  if (pager === "delta") await run("delta", [], { cwd, input: diff.stdout, stdio: "inherit" });
  else renderDiff(diff.stdout);
}
