import { Command } from "commander";
import {
  detectDefaultBranch,
  execGitWithRetry,
  getCurrentBranch,
  getRebaseBranch,
  getRemoteTrackingBranch,
  getStackAncestors,
  getStackDescendants,
  getStackGraph,
  getStatus,
  hasRemoteBranch,
  isAncestor,
  isDetachedHead,
  isRebaseInProgress,
  push,
  recordParentTip,
  requireGitRepo,
  restackBranch,
  setBranchMergeBase,
  switchBranch,
  type StackNode,
} from "../services/git.ts";
import { createPullRequest, getActivePullRequest, requireAuth } from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import { validateBranchName } from "../utils/branch-name.ts";
import {
  confirmOrAbort, jsonOut,
  fail,
  failFromGitHub,
  header,
  p,
  pc,
  promptInput,
  searchablePicker,
} from "../utils/ui.ts";

/** Renders the stack as a tree, marking branches that have drifted from their parent. */
function renderTree(graph: Map<string, StackNode>, roots: string[], defaultBranch = "main"): string[] {
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
    if (node.parent === null && node.recordedParent && !node.parentExists) {
      meta.push(pc.yellow(`parent merged → ${defaultBranch}`));
    }
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
      if (!(await requireGitRepo())) return;

      const [graph, defaultBranch] = await Promise.all([getStackGraph(), detectDefaultBranch()]);
      if (graph.size === 0) {
        p.log.info(pc.dim("No branches yet."));
        return;
      }

      if (jsonOut([...graph.values()])) return;

      const current = await getCurrentBranch();
      let roots = [...graph.values()].filter((n) => !n.parent).map((n) => n.branch).sort();

      if (!options?.all) {
        // Narrow to the tree the current branch belongs to.
        const ancestors = getStackAncestors(graph, current);
        const rootOfCurrent = ancestors.at(-1) ?? current;
        if (roots.includes(rootOfCurrent)) roots = [rootOfCurrent];
      }

      for (const line of renderTree(graph, roots, defaultBranch)) {
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
      if (!(await requireGitRepo())) return;
      const [detached, current] = await Promise.all([isDetachedHead(), getCurrentBranch()]);
      if (detached) {
        fail("Cannot stack a branch from a detached HEAD. Please checkout a named branch first.");
        return;
      }
      if (current === parent) {
        fail("A branch cannot be stacked on itself.");
        return;
      }
      const graph = await getStackGraph();
      const invalidName = validateBranchName(parent);
      if (invalidName || !graph.has(parent)) { fail(invalidName || `Parent branch "${parent}" does not exist locally.`); return; }
      if (getStackAncestors(graph, parent).includes(current)) { fail("Recording this parent would create a stack cycle."); return; }
      if (dryRun(`record ${current} as stacked on ${parent}`)) return;
      await setBranchMergeBase(current, parent);
      if (jsonOut({ branch: current, parent })) return;
      p.log.success(pc.green(`${pc.bold(current)} is now stacked on ${pc.bold(parent)}.`));
      p.outro("Done.");
    });

  stack
    .command("restack [branch]")
    .description("Rebase a branch and everything above it onto their recorded parents")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--continue", "Continue a rebase in progress, then finish restacking")
    .option("--abort", "Abort the current rebase without restacking other branches")
    .action(async (branch?: string, options?: { yes?: boolean; continue?: boolean; abort?: boolean }) => {
      header("Restack");
      if (!(await requireGitRepo())) return;

      // --continue/--abort may run from a detached HEAD that the rebase left
      // behind, so only guard the fresh-restack path.
      if (!options?.continue && !options?.abort && await isDetachedHead()) {
        fail("Cannot restack from a detached HEAD. Checkout a named branch first.");
        return;
      }

      const [rebaseInProgress, defaultBranch] = await Promise.all([isRebaseInProgress(), detectDefaultBranch()]);

      if (options?.continue || options?.abort) {
        if (!rebaseInProgress) {
          fail("No rebase in progress. Use `ggh stack restack` to start.");
          return;
        }

        const rebaseBranch = await getRebaseBranch();
        if (!rebaseBranch) {
          fail("Could not determine which branch is being rebased.");
          return;
        }

        if (dryRun(options?.abort ? "abort the active rebase" : "continue the active rebase and restack descendants")) return;

        if (options?.abort) {
          try {
            await execGitWithRetry(["rebase", "--abort"]);
            p.log.warn("Rebase aborted. No further branches were changed.");
            return;
          } catch (err) {
            fail(`Failed to abort rebase: ${String(err)}`);
            return;
          }
        } else {
          try {
            await execGitWithRetry(["rebase", "--continue"], {
              env: { ...process.env, GIT_EDITOR: "true" },
            });
            const finishedParent = (await getStackGraph()).get(rebaseBranch)?.parent;
            if (finishedParent) await recordParentTip(rebaseBranch, finishedParent);
            p.log.success("Rebase continued.");
          } catch (err) {
            fail(`Failed to continue rebase: ${String(err)}`);
            return;
          }
        }

        // Resume with the remaining descendants of the branch that was being rebased.
        const graph = await getStackGraph();
        const order = getStackDescendants(graph, rebaseBranch);

        for (const b of order) {
          const node = graph.get(b);
          const parent = node?.parent ?? (node?.recordedParent && !node?.parentExists ? defaultBranch : null);
          if (!parent) continue;
          const s = p.spinner();
          s.start(`Rebasing ${pc.cyan(b)} onto ${pc.cyan(parent)}...`);
          const result = await restackBranch(b, parent);
          if (result.ok) {
            s.stop(pc.green(result.message));
          } else {
            s.stop(pc.red(result.message));
            fail("Restack stopped. Resolve the conflict, then run `ggh stack restack --continue`.");
            return;
          }
        }

        p.log.success(pc.green("Stack replayed cleanly."));
        p.outro("Done.");
        return;
      }

      if (rebaseInProgress) {
        fail("A rebase is already in progress. Finish it with `ggh stack restack --continue` or `ggh stack restack --abort`.");
        return;
      }

      // Untracked files do not block a rebase; tracked modifications do.
      const status = await getStatus();
      if (status.staged.length || status.unstaged.length || status.conflicts.length) {
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
      const order = [start, ...getStackDescendants(graph, start)].filter(
        (b) => graph.get(b)?.parent || (graph.get(b)?.recordedParent && !graph.get(b)?.parentExists),
      );

      if (order.length === 0) {
        p.log.info(pc.dim(`${start} has no recorded parent and nothing stacked on it.`));
        return;
      }

      p.log.step(`Will replay ${order.length} branch(es):`);
      for (const b of order) {
        const node = graph.get(b);
        const parent = node?.parent ?? (node?.recordedParent && !node?.parentExists ? defaultBranch : null);
        p.log.message(`  ${pc.cyan(b)} ${pc.dim("onto")} ${pc.cyan(parent ?? "?")}`);
      }

      if (dryRun(`rebase ${order.length} branch(es)`)) return;

      if (!(await confirmOrAbort(`Rebase ${order.length} branch(es)?`, { assumeYes: options?.yes, cancelText: "Restack cancelled." }))) return;

      const original = await getCurrentBranch();
      for (const b of order) {
        const node = graph.get(b);
        const parent = node?.parent ?? (node?.recordedParent && !node?.parentExists ? defaultBranch : null);
        if (!parent) continue;
        const s = p.spinner();
        s.start(`Rebasing ${pc.cyan(b)} onto ${pc.cyan(parent)}...`);
        const result = await restackBranch(b, parent);
        if (result.ok) {
          s.stop(pc.green(result.message));
        } else {
          s.stop(pc.red(result.message));
          fail("Restack stopped. Resolve the conflict, then run `ggh stack restack --continue`.");
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
      if (!(await requireGitRepo())) return;
      if (!branch && await isDetachedHead()) {
        fail("Cannot submit a stack from a detached HEAD. Checkout a named branch first.");
        return;
      }

      const [authed, start, graph, defaultBranch] = await Promise.all([
        requireAuth(),
        branch ? Promise.resolve(branch) : getCurrentBranch(),
        getStackGraph(),
        detectDefaultBranch(),
      ]);
      if (!authed) return;

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

      if (dryRun(`push and open ${chain.length} Pull Request(s)`)) return;

      if (!(await confirmOrAbort(`Push and open Pull Requests for ${chain.length} branch(es)?`, { assumeYes: options?.yes }))) return;

      const original = await getCurrentBranch();
      const opened: Array<{ branch: string; base: string; url: string }> = [];

      for (const b of chain) {
        const base = graph.get(b)?.parent ?? defaultBranch;

        // If this is a child, make sure its parent exists on the remote first.
        if (base !== defaultBranch && !(await hasRemoteBranch(base))) {
          p.log.warn(`Parent branch ${pc.cyan(base)} does not exist on the remote yet. Pushing it first.`);
          const parentSpinner = p.spinner();
          parentSpinner.start(`Pushing parent ${pc.cyan(base)}...`);
          try {
            await switchBranch(base);
            await push({ branch: base, setUpstream: true });
            parentSpinner.stop(`${pc.cyan(base)} pushed.`);
          } catch (parentErr) {
            parentSpinner.stop(pc.red(`Failed to push parent ${base}.`));
            fail(String(parentErr));
            return;
          }
        }

        const s = p.spinner();
        s.start(`Pushing ${pc.cyan(b)}...`);
        try {
          await switchBranch(b);

          const upstream = await getRemoteTrackingBranch();
          let forceWithLease = false;
          if (upstream) {
            const isAnc = await isAncestor(upstream, b);
            if (!isAnc) {
              p.log.warn(`Remote ${upstream} is not an ancestor of ${b}; pushing with --force-with-lease.`);
              forceWithLease = true;
            }
          }

          await push({ branch: b, setUpstream: true, forceWithLease });
          s.stop(`${pc.cyan(b)} pushed.`);
        } catch (err) {
          s.stop(pc.red(`Failed to push ${b}.`));
          failFromGitHub(err);
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
          failFromGitHub(err);
          return;
        }
      }

      try {
        await switchBranch(original);
      } catch {
        // Best effort
      }

      if (jsonOut(opened)) return;
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
      if (!(await requireGitRepo())) return;
      if (await isDetachedHead()) {
        fail("Cannot stack a branch from a detached HEAD. Checkout a named branch first.");
        return;
      }
      const parent = await getCurrentBranch();

      let branch = name;
      if (!branch) {
        const typed = await promptInput({
          message: `New branch stacked on ${parent}:`,
          validate: (v) => {
            if (!v || !v.trim()) return "Branch name required";
            return validateBranchName(v.trim()) || undefined;
          },
        });
        if (!typed) {
          p.cancel("Cancelled.");
          return;
        }
        branch = typed.trim().replace(/\s+/g, "-");
      } else {
        const validationError = validateBranchName(branch);
        if (validationError) {
          fail(validationError);
          return;
        }
      }

      if (dryRun(`create ${branch} stacked on ${parent}`)) return;

      try {
        await switchBranch(branch, true, process.cwd(), parent);
        if (jsonOut({ branch, parent, created: true })) return;
        p.log.success(pc.green(`Created ${pc.bold(branch)} stacked on ${pc.bold(parent)}.`));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });

  stack.command("checkout")
    .alias("co")
    .description("Pick a branch from the stack and switch to it")
    .action(async () => {
      header("Switch Within Stack");
      if (!(await requireGitRepo())) return;
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
      if (dryRun(`switch to ${picked}`)) return;
      try {
        await switchBranch(picked);
        p.log.success(pc.green(`Switched to ${pc.bold(picked)}.`));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });
}
