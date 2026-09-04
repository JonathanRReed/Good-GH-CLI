import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import {
  clampLimit,
  ghGlobal,
  listIssues,
  requireAuth,
} from "../services/github.ts";
import {
  type AIAttempt,
  type AIAttemptFailure,
  generateTriageWithFallback,
  type TriageItem,
} from "../services/ai/index.ts";
import type { AIProvider as ConfigAIProvider } from "../services/config.ts";
import { dryRun } from "../utils/flags.ts";
import {
  jsonOut, emitJson,
  fail,
  failFromGitHub,
  formatAIFallback,
  header,
  p,
  pc,
  reportAIFailure,
} from "../utils/ui.ts";

const PRIORITY_TAG: Record<string, string> = {
  high: pc.red("high"),
  medium: pc.yellow("medium"),
  low: pc.dim("low"),
};

export function registerTriageCommand(program: Command): void {
  program
    .command("triage")
    .description("AI-triage notifications and issues (read-only)")
    .option("--limit <n>", "Maximum items to triage", "30")
    .option("--source <source>", "What to triage: notifications, issues, or both (default)", "both")
    .option("--provider <provider>", "Override AI provider (codex, grok, claude, or ollama)")
    .addHelpText("after", `
Groups your open notifications and issues, suggests labels, and drafts
responses. Prints suggestions and changes nothing. -R scopes issues to
another repository; notifications are account-wide and ignore it.`)
    .addHelpText("after", `
Examples:
  ggh triage
  ggh triage --source issues --limit 10
  ggh triage --json | jq '.suggestions'`)
    .action(async (options?: {
      limit?: string;
      source?: string;
      provider?: string;
    }) => {
      header("AI Triage");
      if (!(await requireAuth())) return;

      const max = clampLimit(Number.parseInt(options?.limit ?? "30", 10));
      const source = (options?.source ?? "both").toLowerCase();
      if (!["notifications", "issues", "both"].includes(source)) {
        fail(`Unknown source: ${source}. Try notifications, issues, or both.`);
        return;
      }

      if (dryRun("triage notifications with AI")) {
        jsonOut({ items: [], groups: [], suggestions: [], dryRun: true });
        return;
      }

      const items: TriageItem[] = [];
      const fetchSpinner = p.spinner();
      fetchSpinner.start("Fetching items to triage...");

      try {
        if (source === "notifications" || source === "both") {
          const { stdout } = await ghGlobal(["api", "/notifications", "--field", `per_page=${max}`]);
          const notifs = parseJsonResponse<Array<{
            id: string;
            subject: { title: string; type: string };
            reason: string;
            unread: boolean;
          }>>(stdout, []);
          if (Array.isArray(notifs)) {
            for (const n of notifs) {
              if (!n?.subject?.title) continue;
              items.push({
                id: n.id,
                title: n.subject.title,
                type: n.subject.type,
                reason: n.reason,
              });
            }
          }
        }
        if (source === "issues" || source === "both") {
          const issues = await listIssues({ limit: max, state: "open" });
          for (const i of issues) {
            items.push({
              id: `issue-${i.number}`,
              title: `#${i.number} ${i.title}`,
              type: "Issue",
            });
          }
        }
        fetchSpinner.stop(`Loaded ${pc.green(String(items.length))} item(s).`);
      } catch (err) {
        fetchSpinner.stop(pc.red("Failed to fetch items."));
        failFromGitHub(err);
        return;
      }

      if (items.length === 0) {
        if (jsonOut({ items: [], groups: [], suggestions: [] })) return;
        p.log.success(pc.green("Nothing to triage — your inbox is empty!"));
        return;
      }

      const s = p.spinner();
      s.start("Triaging with AI...");
      let triage;
      try {
        const { result, providerName, model } = await generateTriageWithFallback(
          items,
          options?.provider as ConfigAIProvider | undefined,
          (failure: AIAttemptFailure, next?: AIAttempt) => s.message(formatAIFallback(failure, next)),
        );
        triage = result;
        s.stop(`Triaged by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
      } catch (err) {
        s.stop(pc.red("Triage failed."));
        reportAIFailure(err, "Could not triage with AI:");
        if (getFlags().json) {
          emitJson({ items, groups: [], suggestions: [], error: "ai-failed" });
        }
        process.exitCode = 1;
        return;
      }

      if (jsonOut({ items, ...triage })) return;

      // Display groups
      if (triage.groups.length > 0) {
        p.log.step("Groups:");
        for (const group of triage.groups) {
          p.log.message(`  ${pc.bold(pc.cyan(group.label))} (${group.itemIds.length}) ${pc.dim(group.summary)}`);
          for (const id of group.itemIds) {
            const item = items.find((i) => i.id === id);
            if (item) {
              p.log.message(`    ${pc.dim("•")} ${item.title}`);
            }
          }
        }
      }

      // Display suggestions
      if (triage.suggestions.length > 0) {
        p.log.step("Suggestions:");
        for (const sug of triage.suggestions) {
          const item = items.find((i) => i.id === sug.itemId);
          if (!item) continue;
          const priority = PRIORITY_TAG[sug.priority] ?? pc.dim(sug.priority);
          const label = sug.suggestedLabel ? pc.cyan(sug.suggestedLabel) : pc.dim("no label");
          p.log.message(`  ${pc.bold(priority)} ${label} ${pc.dim(item.title)}`);
          if (sug.draftResponse) {
            p.log.message(`    ${pc.dim("draft:")} ${sug.draftResponse}`);
          }
        }
      }

      if (triage.groups.length === 0 && triage.suggestions.length === 0) {
        p.log.info(pc.dim("AI found nothing actionable."));
      }

      p.outro(pc.dim("Apply labels with `ggh label create <name>` and responses with `ggh issue comment <num> -b \"...\"`."));
    });
}
