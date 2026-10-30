import type { Command } from "commander";
import { requireAuth } from "../services/github.ts";
import { INBOX_SECTIONS, readInbox, validInboxFilter, type InboxPullRequest, type InboxResult, type InboxSectionName } from "../services/inbox.ts";
import { readProjectIndex } from "../services/projects/index-store.ts";
import type { ProjectIndexFile } from "../services/projects/types.ts";
import { fitProjectLine, shortPath } from "../services/projects/view.ts";
import { safeHumanText } from "../utils/output.ts";
import { fail, jsonOut, p, pc } from "../utils/ui.ts";

const TITLES: Record<InboxSectionName, string> = { reviewRequested: "Review requested", needsFix: "Needs your fix", readyToMerge: "Ready to merge" };
const REASONS: Record<string, string> = {
  requested_directly: "requested directly", requested_via_team: "via team",
  checks_failing: "checks failing", changes_requested: "changes requested", conflicts: "merge conflicts",
  merge_queue: "in merge queue", approved: "approved", no_review_required: "no review required",
  checks_passing: "checks pass", mergeable: "mergeable",
};

function formatInbox(result: InboxResult): string[] {
  const lines: string[] = [];
  const row = (pr: InboxPullRequest) => {
    const reasons = pr.reasons.map(reason => {
      if (reason === "requested_via_team" && pr.request?.teams.length) return `via ${pr.request.teams.join(", ")}`;
      // A stacked or unverified PR is not plainly green, so it never renders like one.
      if (reason === "stacked") return pc.yellow(`stacked on #${pr.stackedOn ?? "?"}`);
      if (reason === "no_checks") return pc.yellow("no checks (unverified)");
      return REASONS[reason] ?? reason;
    });
    if (pr.defaultBranch !== null && pr.baseRefName.toLowerCase() !== pr.defaultBranch.toLowerCase()) reasons.push(`base ${pr.baseRefName}`);
    lines.push(fitProjectLine(`  ${pc.bold(`#${pr.number}`)} ${pc.cyan(pr.repo)} ${safeHumanText(pr.title).replace(/[\r\n\t]/g, " ")}${pr.draft ? ` ${pc.dim("[draft]")}` : ""}`));
    const where = pr.local ? `${pr.local.branchCheckedOut ? `on ${pr.headRefName} · ` : ""}${shortPath(pr.local.path)}` : "no local clone";
    lines.push(fitProjectLine(`      ${pc.dim(`${reasons.join(" · ")} · ${where}`)}`));
    // Never truncate or re-quote a command someone may paste.
    for (const command of pr.next) lines.push(`      ${pc.green("→")} ${command}`);
  };
  for (const name of INBOX_SECTIONS) {
    const section = result.sections[name];
    if (section.state === "unavailable") {
      lines.push(`${pc.bold(TITLES[name])}  ${pc.yellow(`unavailable: ${section.reason}`)}${section.retryAt ? pc.dim(` (retry after ${section.retryAt})`) : ""}`);
      continue;
    }
    const more = section.total > section.items.length ? pc.dim(` (showing ${section.items.length})`) : "";
    lines.push(`${pc.bold(TITLES[name])}  ${section.total}${section.complete ? "" : "+"}${more}`);
    for (const pr of section.items) row(pr);
  }
  // Both of your sections come from one search, so report its hidden PRs once.
  for (const name of ["reviewRequested", "needsFix"] as const) {
    const section = result.sections[name];
    if (section.state === "available" && section.skipped) lines.push(pc.dim(`${section.skipped} ${name === "reviewRequested" ? `review request${section.skipped === 1 ? "" : "s"}` : "of your PRs"} hidden: ${section.skippedReason ?? "unavailable"}`));
  }
  if (result.waiting) lines.push(pc.dim(`${result.waiting} more of your open PRs are waiting on review, checks, or mergeability.`));
  return lines;
}

export function registerInboxCommand(program: Command): void {
  program.command("inbox [filter]")
    .description("Review requests, PRs that need your fix, and PRs ready to merge, tied to local clones")
    .option("--limit <n>", "Maximum PRs per section, up to 50", "10")
    .addHelpText("after", "\nFilter by owner or owner/repo. Read-only: the next commands are suggestions and never run.\nLocal clones come from the projects index; run ggh projects to refresh it.")
    .action(async (filter: string | undefined, options: { limit?: string }) => {
      if (filter !== undefined && !validInboxFilter(filter)) { fail("Filter by an owner or owner/repo, such as acme or acme/demo.", { code: "invalid_arguments" }); return; }
      // Reject nonsense instead of silently falling back to the default, and say when a value is clamped.
      const requested = options.limit ?? "10";
      if (!/^\d+$/.test(requested) || Number(requested) < 1) { fail(`Invalid --limit ${JSON.stringify(requested)}. Use a whole number from 1 to 50.`, { code: "invalid_arguments" }); return; }
      let limit = Number(requested);
      if (limit > 50) { p.log.warn(`--limit ${limit} is above the maximum of 50; showing 50 per section.`); limit = 50; }
      if (!(await requireAuth())) return;
      // A broken index costs the cross-reference, not the inbox.
      let index: Pick<ProjectIndexFile, "clones" | "updatedAt"> = { clones: [], updatedAt: new Date(0).toISOString() };
      try { index = readProjectIndex(); } catch (error) { p.log.warn(error instanceof Error ? error.message : String(error)); }
      const s = p.spinner();
      s.start("Reading your pull request inbox...");
      const result = await readInbox({ limit, filter, clones: index.clones, indexedAt: index.updatedAt });
      // JSON output suppresses the warning, so the payload says it too.
      if (limit < Number(requested)) result.requestedLimit = Number(requested);
      const failures = INBOX_SECTIONS.flatMap(name => { const section = result.sections[name]; return section.state === "unavailable" ? [section.reason] : []; });
      s.stop(failures.length === INBOX_SECTIONS.length ? pc.red("Inbox unavailable.") : `Inbox for ${result.login ?? result.host}.`);
      const json = jsonOut(result);
      if (failures.length === INBOX_SECTIONS.length) { fail(`Could not read the inbox from ${result.host}: ${failures[0]}. Check gh auth status and retry.`, { code: "provider_unavailable" }); return; }
      if (json) return;
      for (const line of formatInbox(result)) p.log.message(line);
      if (!index.clones.length) p.log.info(pc.dim("No local clones indexed. Run ggh projects to find them."));
    });
}
