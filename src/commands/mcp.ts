import { Command } from "commander";
import { createInterface } from "node:readline";
import packageJson from "../../package.json";
import { header, p, pc } from "../utils/ui.ts";

/**
 * `ggh mcp` — exposes ggh as a Model Context Protocol (MCP) server over stdio.
 *
 * Other AI tools (Claude Code, Cursor, etc.) can connect to ggh as a tool
 * provider and get structured access to PRs, issues, stacks, and AI features
 * without reimplementing the `gh` wrapper.
 *
 * The protocol is JSON-RPC 2.0 over stdio. We implement the core MCP methods:
 * - initialize: handshake
 * - tools/list: enumerate available tools
 * - tools/call: execute a tool
 *
 * No external MCP SDK dependency — the protocol is simple enough to implement
 * directly, keeping ggh's dependency surface minimal.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

function getTools(): McpTool[] {
  return [
    {
      name: "ggh_status",
      description: "Get repository, GitHub, and AI provider status in one call",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { getStatus, getAheadBehind, getRepoRoot, worktreeList } = await import("../services/git.ts");
        const { getActivePullRequest, getGitHubAuthStatus } = await import("../services/github.ts");
        const [gitStatus, root, drift, activePr, ghStatus, wtList] = await Promise.all([
          getStatus(),
          getRepoRoot().catch(() => ""),
          getAheadBehind().catch(() => ({ ahead: 0, behind: 0, hasUpstream: false })),
          getActivePullRequest().catch(() => null),
          getGitHubAuthStatus().catch((): { authenticated: boolean; login?: string } => ({ authenticated: false })),
          worktreeList().catch(() => []),
        ]);
        return {
          repository: gitStatus.isRepo
            ? {
                root,
                branch: gitStatus.branch,
                detached: Boolean(gitStatus.isDetached),
                ahead: drift.ahead,
                behind: drift.behind,
                hasUpstream: drift.hasUpstream,
                staged: gitStatus.staged.length,
                unstaged: gitStatus.unstaged.length,
                untracked: gitStatus.untracked.length,
                conflicts: gitStatus.conflicts.length,
                worktrees: wtList.length,
              }
            : null,
          pullRequest: activePr,
          github: { authenticated: ghStatus.authenticated, login: ghStatus.login || null },
        };
      },
    },
    {
      name: "ggh_pr_view",
      description: "View a pull request (details, or current branch's PR if no number given)",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "number", description: "PR number (omit for current branch's PR)" },
        },
      },
      handler: async (args) => {
        const { viewPullRequest, getActivePullRequest } = await import("../services/github.ts");
        let num = args.number as number | undefined;
        if (num === undefined) {
          const active = await getActivePullRequest();
          if (!active) return { error: "No PR found for current branch" };
          num = active.number;
        }
        return await viewPullRequest(num);
      },
    },
    {
      name: "ggh_pr_list",
      description: "List open pull requests in the current repository",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum PRs to return (default 30)" },
          state: { type: "string", description: "open, closed, or all (default open)" },
        },
      },
      handler: async (args) => {
        const { listPullRequests } = await import("../services/github.ts");
        return await listPullRequests({
          limit: args.limit as number | undefined,
          state: args.state as string | undefined,
        });
      },
    },
    {
      name: "ggh_issue_list",
      description: "List issues in the current repository",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum issues (default 30)" },
          state: { type: "string", description: "open, closed, or all (default open)" },
        },
      },
      handler: async (args) => {
        const { listIssues } = await import("../services/github.ts");
        return await listIssues({
          limit: args.limit as number | undefined,
          state: args.state as string | undefined,
        });
      },
    },
    {
      name: "ggh_issue_view",
      description: "View a specific issue with full details and comments",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "number", description: "Issue number" },
        },
        required: ["number"],
      },
      handler: async (args) => {
        const { viewIssue } = await import("../services/github.ts");
        return await viewIssue(args.number as number);
      },
    },
    {
      name: "ggh_checks",
      description: "Get CI/CD check runs for the current branch's pull request",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const { getPullRequestChecks } = await import("../services/github.ts");
        return await getPullRequestChecks();
      },
    },
    {
      name: "ggh_stack",
      description: "Get the current stacked branch graph",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { getStackGraph, getStackAncestors, getStackDescendants } = await import("../services/git.ts");
        const { getCurrentBranch } = await import("../services/git.ts");
        const graph = await getStackGraph();
        const current = await getCurrentBranch();
        const ancestors = getStackAncestors(graph, current);
        const descendants = getStackDescendants(graph, current);
        const nodes = [...graph.values()].map((n) => ({
          branch: n.branch,
          parent: n.parent,
          ahead: n.ahead,
        }));
        return { current, ancestors, descendants, nodes };
      },
    },
    {
      name: "ggh_notifications",
      description: "List unread GitHub notifications",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum notifications (default 30)" },
        },
      },
      handler: async (args) => {
        const { paginateGhGlobal } = await import("../services/github.ts");
        const limit = args.limit as number | undefined ?? 30;
        const rows = await paginateGhGlobal("/notifications", {
          perPage: Math.min(limit, 100),
          maxPages: Math.ceil(limit / 100) || 1,
        });
        return rows.slice(0, limit);
      },
    },
    {
      name: "ggh_commits",
      description: "List recent commits on the current branch",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits (default 10)" },
        },
      },
      handler: async (args) => {
        const { getRecentCommits } = await import("../services/git.ts");
        return await getRecentCommits(args.count as number | undefined ?? 10);
      },
    },
    {
      name: "ggh_diff",
      description: "Get the staged or branch diff (sanitized for AI consumption)",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "staged or branch (default staged)" },
        },
      },
      handler: async (args) => {
        const { getStagedDiff, getBranchDiff, detectDefaultBranch } = await import("../services/git.ts");
        const { sanitizeDiffForAI } = await import("../utils/diff.ts");
        if (args.type === "branch") {
          const base = await detectDefaultBranch();
          const diff = await getBranchDiff(base);
          return { diff: sanitizeDiffForAI(diff).diff, base };
        }
        const diff = await getStagedDiff();
        return { diff: sanitizeDiffForAI(diff).diff };
      },
    },
  ];
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Run as a Model Context Protocol server (for AI tool integration)")
    .option("--list-tools", "Print available MCP tools and exit")
    .action(async (options?: { listTools?: boolean }) => {
      if (options?.listTools) {
        header("MCP Tools");
        const tools = getTools();
        for (const tool of tools) {
          p.log.message(`  ${pc.bold(pc.cyan(tool.name))} ${pc.dim(tool.description)}`);
        }
        p.outro(`${tools.length} tool(s) available.`);
        return;
      }

      // Run as MCP server over stdio
      const rl = createInterface({ input: process.stdin, terminal: false });
      const tools = getTools();
      const toolMap = new Map(tools.map((t) => [t.name, t]));

      const send = (response: JsonRpcResponse) => {
        process.stdout.write(JSON.stringify(response) + "\n");
      };

      rl.on("line", (line: string) => {
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(line);
        } catch {
          return; // ignore malformed lines
        }

        const { method, params, id } = request;

        switch (method) {
          case "initialize":
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "ggh", version: packageJson.version },
              },
            });
            break;

          case "tools/list":
            send({
              jsonrpc: "2.0",
              id,
              result: {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                })),
              },
            });
            break;

          case "tools/call": {
            const toolName = params?.name as string;
            const args = (params?.arguments as Record<string, unknown>) || {};
            const tool = toolMap.get(toolName);
            if (!tool) {
              send({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Unknown tool: ${toolName}` },
              });
              break;
            }
            tool
              .handler(args)
              .then((result) => {
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                  },
                });
              })
              .catch((err: unknown) => {
                send({
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32603,
                    message: err instanceof Error ? err.message : String(err),
                  },
                });
              });
            break;
          }

          case "notifications/initialized":
            // No response needed for notifications
            break;

          default:
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown method: ${method}` },
            });
        }
      });

      // Keep the process alive until stdin closes; let pending tool calls drain.
      rl.on("close", () => {
        process.exitCode = 0;
      });
    });
}
