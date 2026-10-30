import type { Command } from "commander";
import { clampLimit, requireAuth } from "../services/github.ts";
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
  checks_passing: "checks pass", no_checks: "no checks", mergeable: "mergeable",
};

// Home paths shorten only when the result needs no quoting, so ~ still expands.
function shellWord(arg: string): string {
  const short = arg.startsWith("/") ? shortPath(arg) : arg;
  return /^[\w@%+=:,./~-]+$/.test(short) ? short : `'${arg.replaceAll("'", "'\\''")}'`;
}

function formatInbox(result: InboxResult): string[] {
  const lines: string[] = [];
  const row = (pr: InboxPullRequest) => {
    const reasons = pr.reasons.map(reason => reason === "requested_via_team" && pr.request?.teams.length ? `via ${pr.request.teams.join(", ")}` : REASONS[reason] ?? reason);
    lines.push(fitProjectLine(`  ${pc.bold(`#${pr.number}`)} ${pc.cyan(pr.repo)} ${safeHumanText(pr.title).replace(/[\r\n\t]/g, " ")}${pr.draft ? ` ${pc.dim("[draft]")}` : ""}`));
    const where = pr.local ? `${pr.local.branchCheckedOut ? `on ${pr.headRefName} · ` : ""}${shortPath(pr.local.path)}` : "no local clone";
    lines.push(fitProjectLine(`      ${pc.dim(`${reasons.join(" · ")} · ${where}`)}`));
    // Never truncate a command someone may paste.
    if (pr.next.length) lines.push(`      ${pc.green("→")} ${pr.next.map(step => step.map(shellWord).join(" ")).join(" && ")}`);
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
      if (!(await requireAuth())) return;
      // A broken index costs the cross-reference, not the inbox.
      let index: Pick<ProjectIndexFile, "clones" | "updatedAt"> = { clones: [], updatedAt: new Date(0).toISOString() };
      try { index = readProjectIndex(); } catch (error) { p.log.warn(error instanceof Error ? error.message : String(error)); }
      const s = p.spinner();
      s.start("Reading your pull request inbox...");
      const result = await readInbox({ limit: clampLimit(Number.parseInt(options.limit ?? "10", 10), 50, 10), filter, clones: index.clones, indexedAt: index.updatedAt });
      const failures = INBOX_SECTIONS.flatMap(name => { const section = result.sections[name]; return section.state === "unavailable" ? [section.reason] : []; });
      s.stop(failures.length === INBOX_SECTIONS.length ? pc.red("Inbox unavailable.") : `Inbox for ${result.login ?? result.host}.`);
      const json = jsonOut(result);
      if (failures.length === INBOX_SECTIONS.length) { fail(`Could not read the inbox from ${result.host}: ${failures[0]}. Check gh auth status and retry.`, { code: "provider_unavailable" }); return; }
      if (json) return;
      for (const line of formatInbox(result)) p.log.message(line);
      if (!index.clones.length) p.log.info(pc.dim("No local clones indexed. Run ggh projects to find them."));
    });
}
