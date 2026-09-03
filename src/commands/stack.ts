import { Command } from "commander";
import {
  detectDefaultBranch,
  getCurrentBranch,
  getStackAncestors,
  getStackDescendants,
  getStackGraph,
  getStatus,
  isGitRepo,
  isRebaseInProgress,
  push,
  restackBranch,
  setBranchMergeBase,
  switchBranch,
  type StackNode,
} from "../services/git.ts";
import { createPullRequest, getActivePullRequest, getGitHubAuthStatus } from "../services/github.ts";
import { getFlags } from "../services/runtime.ts";
import { isDryRun } from "../utils/flags.ts";
import {
  confirmPrompt,
  emitJson,
  fail,
  header,
  p,
  pc,
  promptInput,
  searchablePicker,
} from "../utils/ui.ts";

/** Renders the stack as a tree, marking branches that have drifted from their parent. */
function renderTree(graph: Map<string, StackNode>, roots: string[]): string[] {
  const lines: string[] = [];

  function walk(branch: string, prefix: string, isLast: boolean, depth: number): void {
    const node = graph.get(branch);
    if (!node) return;

    const connector = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
    const marker = node.isCurrent ? pc.green("●") : pc.dim("○");
    const name = node.isCurrent ? pc.bold(pc.green(branch)) : branch;

    const meta: string[] = [];
    if (node.ahead > 0) meta.push(pc.cyan(`+${node.ahead}`));
    if (node.behind > 0) meta.push(pc.yellow(`${node.behind} behind parent`));
    const suffix = meta.length ? `  ${pc.dim("(")}${meta.join(pc.dim(", "))}${pc.dim(")")}` : "";

    lines.push(`${pc.dim(prefix)}${pc.dim(connector)}${marker} ${name}${suffix}`);

    const children = node.children.slice().sort();
    children.forEach((child, i) => {
      const nextPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : pc.dim("│") + "  ");
      walk(child, nextPrefix, i === children.length - 1, depth + 1);
    });
  }

  roots.forEach((root, i) => walk(root, "", i === roots.length - 1, 0));
  return lines;
}

export function registerStackCommand(program: Command): void {
  const stack = program
    .command("stack")
    .alias("stk")
    .description("Stacked branches: view, restack, and submit the chain");

  stack.command("list", { isDefault: true })
    .alias("ls")
    .description("Show the branch stack as a tree")
    .option("--all", "Show every branch, not just the current stack")
    .action(async (options?: { all?: boolean }) => {
      header("Branch Stack");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const graph = await getStackGraph();
      if (graph.size === 0) {
        p.log.info(pc.dim("No branches yet."));
        return;
      }

      if (getFlags().json) {
        emitJson([...graph.values()]);
        return;
      }

      const current = await getCurrentBranch();
      let roots = [...graph.values()].filter((n) => !n.parent).map((n) => n.branch).sort();

      if (!options?.all) {
        // Narrow to the tree the current branch belongs to.
        const ancestors = getStackAncestors(graph, current);
        const rootOfCurrent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : current;
        if (roots.includes(rootOfCurrent)) roots = [rootOfCurrent];
      }

      for (const line of renderTree(graph, roots)) {
        p.log.message(line);
      }

      const drifted = [...graph.values()].filter((n) => n.behind > 0);
      if (drifted.length > 0) {
        p.log.warn(
          `${drifted.length} branch(es) are behind their parent. Run ${pc.bold(pc.cyan("ggh stack restack"))} to replay them.`,
        );
      }
      p.outro(pc.dim(options?.all ? "every branch" : "run with --all to see every branch"));
    });

  stack.command("on <parent>")
    .description("Record the parent of the current branch, adopting it into a stack")
    .action(async (parent: string) => {
      header("Set Stack Parent");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      const current = await getCurrentBranch();
      if (current === parent) {
        fail("A branch cannot be stacked on itself.");
        return;
      }
      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would record ${current} as stacked on ${parent}`);
        return;
      }
      await setBranchMergeBase(current, parent);
      p.log.success(pc.green(`${pc.bold(current)} is now stacked on ${pc.bold(parent)}.`));
      p.outro("Done.");
    });

  stack.command("restack [branch]")
    .description("Rebase a branch and everything above it onto their recorded parents")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (branch?: string, options?: { yes?: boolean }) => {
      header("Restack");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      if (await isRebaseInProgress()) {
        fail("A rebase is already in progress. Finish it with `git rebase --continue` or `--abort` first.");
        return;
      }

      const status = await getStatus();
      if (status.hasChanges) {
        fail("Working tree has uncommitted changes. Commit or stash them before restacking.");
        return;
      }

      const start = branch || (await getCurrentBranch());
      const graph = await getStackGraph();
      if (!graph.has(start)) {
        fail(`Branch '${start}' not found.`);
        return;
      }

      // Parents must be replayed before their children, so include the start
      // branch first, then its descendants breadth-first.
      const order = [start, ...getStackDescendants(graph, start)].filter((b) => graph.get(b)?.parent);

      if (order.length === 0) {
        p.log.info(pc.dim(`${start} has no recorded parent and nothing stacked on it.`));
        return;
      }

      p.log.step(`Will replay ${order.length} branch(es):`);
      for (const b of order) {
        p.log.message(`  ${pc.cyan(b)} ${pc.dim("onto")} ${pc.cyan(graph.get(b)?.parent ?? "?")}`);
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would rebase ${order.length} branch(es)`);
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Rebase ${order.length} branch(es)?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Restack cancelled.");
        return;
      }

      const original = await getCurrentBranch();
      for (const b of order) {
        const parent = graph.get(b)?.parent;
        if (!parent) continue;
        const s = p.spinner();
        s.start(`Rebasing ${pc.cyan(b)} onto ${pc.cyan(parent)}...`);
        const result = await restackBranch(b, parent);
        if (result.ok) {
          s.stop(pc.green(result.message));
        } else {
          s.stop(pc.red(result.message));
          fail("Restack stopped. Resolve the conflict, then run `ggh stack restack` again.");
          return;
        }
      }

      try {
        await switchBranch(original);
      } catch {
        // Original branch may have been the one that moved; harmless
      }
      p.log.success(pc.green("Stack replayed cleanly."));
      p.outro("Done.");
    });

  stack.command("submit [branch]")
    .description("Push the stack and open a Pull Request for each branch against its real parent")
    .option("-d, --draft", "Open every Pull Request as a draft")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (branch?: string, options?: { draft?: boolean; yes?: boolean }) => {
      header("Submit Stack");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const auth = await getGitHubAuthStatus();
      if (!auth.authenticated) {
        fail(
          auth.notInstalled
            ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
            : "GitHub CLI is not authenticated. Run `gh auth login`.",
        );
        return;
      }

      const start = branch || (await getCurrentBranch());
      const graph = await getStackGraph();
      const defaultBranch = await detectDefaultBranch();

      // Submit from the bottom of the stack up, so each parent branch exists on
      // the remote before the child Pull Request points at it.
      const ancestors = getStackAncestors(graph, start).reverse();
      const chain = [...ancestors, start].filter((b) => b !== defaultBranch && graph.has(b));

      if (chain.length === 0) {
        fail(`${start} is not part of a stack. Use \`ggh stack on <parent>\` to record its parent.`);
        return;
      }

      p.log.step(`Stack from the bottom up:`);
      for (const b of chain) {
        const parent = graph.get(b)?.parent ?? defaultBranch;
        p.log.message(`  ${pc.cyan(b)} ${pc.dim("→")} ${pc.cyan(parent)}`);
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would push and open ${chain.length} Pull Request(s)`);
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Push and open Pull Requests for ${chain.length} branch(es)?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Cancelled.");
        return;
      }

      const original = await getCurrentBranch();
      const opened: Array<{ branch: string; base: string; url: string }> = [];

      for (const b of chain) {
        const base = graph.get(b)?.parent ?? defaultBranch;
        const s = p.spinner();
        s.start(`Pushing ${pc.cyan(b)}...`);
        try {
          await switchBranch(b);
          await push({ branch: b, setUpstream: true });
          s.stop(`${pc.cyan(b)} pushed.`);
        } catch (err) {
          s.stop(pc.red(`Failed to push ${b}.`));
          fail(String(err));
          return;
        }

        const existing = await getActivePullRequest();
        if (existing) {
          p.log.info(`${pc.cyan(b)} already has Pull Request #${existing.number}; updated by the push.`);
          opened.push({ branch: b, base, url: existing.url });
          continue;
        }

        const prSpinner = p.spinner();
        prSpinner.start(`Opening Pull Request for ${pc.cyan(b)} against ${pc.cyan(base)}...`);
        try {
          const url = await createPullRequest({
            title: b,
            body: `Part of a stack. Base: \`${base}\`.\n\nStack:\n${chain
              .map((x) => (x === b ? `- **${x}** ← this Pull Request` : `- ${x}`))
              .join("\n")}`,
            base,
            draft: options?.draft,
          });
          prSpinner.stop(pc.green(`Pull Request opened for ${b}.`));
          opened.push({ branch: b, base, url });
        } catch (err) {
          prSpinner.stop(pc.red(`Failed to open a Pull Request for ${b}.`));
          fail(String(err));
          return;
        }
      }

      try {
        await switchBranch(original);
      } catch {
        // Best effort
      }

      if (getFlags().json) {
        emitJson(opened);
        return;
      }
      for (const entry of opened) {
        p.log.message(`  ${pc.cyan(entry.branch)} → ${pc.cyan(entry.base)}  ${pc.dim(entry.url)}`);
      }
      p.outro(pc.green(`${opened.length} Pull Request(s) in the stack.`));
    });

  stack.command("next")
    .description("Create a branch stacked on the current one")
    .argument("[name]", "Branch name")
    .action(async (name?: string) => {
      header("Stack a New Branch");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      const parent = await getCurrentBranch();

      let branch = name;
      if (!branch) {
        const typed = await promptInput({
          message: `New branch stacked on ${parent}:`,
          validate: (v) => (!v || !v.trim() ? "Branch name required" : undefined),
        });
        if (!typed) {
          p.cancel("Cancelled.");
          return;
        }
        branch = typed.trim().replace(/\s+/g, "-");
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would create ${branch} stacked on ${parent}`);
        return;
      }

      try {
        await switchBranch(branch, true, process.cwd(), parent);
        p.log.success(pc.green(`Created ${pc.bold(branch)} stacked on ${pc.bold(parent)}.`));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });

  stack.command("checkout")
    .alias("co")
    .description("Pick a branch from the stack and switch to it")
    .action(async () => {
      header("Switch Within Stack");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      const graph = await getStackGraph();
      const items = [...graph.values()].map((n) => ({
        value: n.branch,
        label: n.isCurrent ? `* ${n.branch}` : n.branch,
        hint: n.parent ? `on ${n.parent}${n.behind > 0 ? ` · ${n.behind} behind` : ""}` : "root",
      }));
      const picked = await searchablePicker<string>({ title: "Switch to:", items, pageSize: 10 });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      try {
        await switchBranch(picked);
        p.log.success(pc.green(`Switched to ${pc.bold(picked)}.`));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });
}
