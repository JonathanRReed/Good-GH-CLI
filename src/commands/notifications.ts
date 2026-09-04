import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { parseJsonResponse } from "../services/ai/prompt.ts";
import { clampLimit, ghGlobal, paginateGhGlobal, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { emitJson, fail, failFromGitHub, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command("notifications [action] [id]")
    .alias("notifs")
    .description("List, view, mark, and unsubscribe from GitHub notifications")
    .option("--limit <n>", "Maximum notifications to list", "30")
    .option("-a, --all", "Include read notifications")
    .option("-y, --yes", "Skip confirmation")
    .action(async (
      action?: string,
      id?: string,
      options?: { limit?: string; all?: boolean; yes?: boolean },
    ) => {
      header("GitHub Notifications");

      if (!(await requireAuth())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !id)) {
        await listNotifications(options);
        return;
      }

      if (subcommand === "view" && id) {
        await viewNotification(id);
        return;
      }

      if (subcommand === "mark") {
        if (id) {
          await markNotification(id, options);
        } else {
          await markAllNotifications(options);
        }
        return;
      }

      if (subcommand === "unsubscribe" && id) {
        await unsubscribeNotification(id, options);
        return;
      }

      unknownAction("notification", action, ["list", "view", "mark", "unsubscribe"]);
    });

  notifications
    .command("list")
    .description("List notifications")
    .option("--limit <n>", "Maximum notifications to list", "30")
    .option("-a, --all", "Include read notifications")
    .action(async (options?: { limit?: string; all?: boolean }) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      await listNotifications(options);
    });

  notifications
    .command("view <id>")
    .description("View a notification")
    .action(async (id: string) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      await viewNotification(id);
    });

  notifications
    .command("mark [id]")
    .description("Mark one or all notifications as read")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id?: string, options?: { yes?: boolean }) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      if (id) {
        await markNotification(id, options);
      } else {
        await markAllNotifications(options);
      }
    });

  notifications
    .command("unsubscribe <id>")
    .description("Unsubscribe from a notification")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, options?: { yes?: boolean }) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      await unsubscribeNotification(id, options);
    });

  async function listNotifications(options?: { limit?: string; all?: boolean }): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const max = clampLimit(Number.parseInt(options?.limit ?? "30", 10));
    const s = p.spinner();
    s.start("Fetching notifications...");
    try {
      const endpoint = options?.all ? "/notifications?all=true" : "/notifications";
      const rows = await paginateGhGlobal<unknown>(endpoint, {
        perPage: Math.min(max, 100),
        maxPages: Math.ceil(max / 100) || 1,
      });
      const trimmed = rows.slice(0, max);
      s.stop(`Loaded ${pc.green(String(trimmed.length))} notification(s).`);
      if (jsonOut(trimmed)) return;
      if (trimmed.length === 0) {
        p.log.info(pc.dim("No notifications."));
        return;
      }
      for (const row of trimmed as Array<{ id: string; subject: { title: string; type: string; url?: string }; reason: string; unread: boolean; updated_at: string }>) {
        const mark = row.unread ? pc.yellow("●") : pc.dim("○");
        p.log.message(`  ${mark} ${pc.bold(row.subject.title)} ${pc.dim(`[${row.subject.type}]`)} ${pc.cyan(row.reason)}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch notifications."));
      failFromGitHub(err);
    }
  }

  async function viewNotification(id: string): Promise<void> {
    const s = p.spinner();
    s.start(`Fetching notification ${id}...`);
    try {
      const { stdout } = await ghGlobal(["api", `/notifications/threads/${id}`]);
      const data = parseJsonResponse(stdout, null);
      s.stop(data ? "Loaded." : "Not found.");
      if (!data) {
        fail(`Notification ${id} not found.`);
        return;
      }
      if (jsonOut(data)) return;
      const n = data as { id: string; subject: { title: string; type: string }; reason: string; unread: boolean };
      p.log.step(pc.bold(n.subject.title));
      p.log.message(`  Type:  ${pc.cyan(n.subject.type)}`);
      p.log.message(`  Reason: ${pc.cyan(n.reason)}`);
      p.log.message(`  Unread: ${n.unread ? pc.yellow("yes") : pc.dim("no")}`);
    } catch (err) {
      s.stop(pc.red("Failed to fetch notification."));
      failFromGitHub(err);
    }
  }

  async function markNotification(id: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`mark notification ${id} as read`)) return;
    if (!(await confirmOrAbort(`Mark notification ${pc.bold(id)} as read?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Marking notification ${id} as read...`);
    try {
      await ghGlobal(["api", "--method", "PATCH", `/notifications/threads/${id}`, "-f", "read=true"]);
      s.stop(pc.green("Notification marked as read."));
      if (getFlags().json) emitJson({ id, action: "mark" });
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }

  async function markAllNotifications(options?: { yes?: boolean }): Promise<void> {
    if (dryRun("mark all notifications as read")) return;
    if (!(await confirmOrAbort("Mark all notifications as read?", { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start("Marking all notifications as read...");
    try {
      await ghGlobal(["api", "--method", "PUT", "/notifications", "-f", "read=true"]);
      s.stop(pc.green("All notifications marked as read."));
      if (getFlags().json) emitJson({ action: "mark-all" });
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }

  async function unsubscribeNotification(id: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`unsubscribe from notification ${id}`)) return;
    if (!(await confirmOrAbort(`Unsubscribe from notification ${pc.bold(id)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Unsubscribing from notification ${id}...`);
    try {
      await ghGlobal(["api", "--method", "PUT", `/notifications/threads/${id}/subscription`, "-f", "ignored=true"]);
      s.stop(pc.green("Unsubscribed."));
      if (getFlags().json) emitJson({ id, action: "unsubscribe" });
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }
}
