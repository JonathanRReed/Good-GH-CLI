import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { clampLimit, ghGlobal, paginateGhGlobal, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { emitJson, failFromGitHub, header, p, pc, jsonOut } from "../utils/ui.ts";

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command("notifications")
    .alias("notifs")
    .description("List notifications or mark them read without prompting")
    .option("--limit <n>", "Maximum notifications to list", "30")
    .option("-a, --all", "Include read notifications")
    .action(async (options: { limit?: string; all?: boolean }) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      await listNotifications(options);
    });

  notifications.command("list")
    .description("List notifications")
    .option("--limit <n>", "Maximum notifications to list", "30")
    .option("-a, --all", "Include read notifications")
    .action(async (options: { limit?: string; all?: boolean }) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      await listNotifications(options);
    });

  notifications.command("mark [id]")
    .description("Mark one notification read, or all when no ID is supplied")
    .action(async (id?: string) => {
      header("GitHub Notifications");
      if (!(await requireAuth())) return;
      if (id) await markNotification(id);
      else await markAllNotifications();
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
        p.log.message(`  ${pc.dim(row.id)} ${mark} ${pc.bold(row.subject.title)} ${pc.dim(`[${row.subject.type}]`)} ${pc.cyan(row.reason)}`);
      }
    } catch (err) {
      s.stop(pc.red("Failed to fetch notifications."));
      failFromGitHub(err);
    }
  }

  async function markNotification(id: string): Promise<void> {
    if (dryRun(`mark notification ${id} as read`)) return;
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

  async function markAllNotifications(): Promise<void> {
    if (dryRun("mark all notifications as read")) return;
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

}
