import { AGENT_CAPABLE } from "../utils/flags.ts";
import type { Command } from "commander";
import { envelopeSchema, coreResultSchemas } from "../services/agent-contract.ts";
import { buildAgentBrief, readBriefCheckout, type AgentBrief } from "../services/agent-brief.ts";
import { data, emitJson, safeHumanText } from "../utils/output.ts";
import { fail, jsonOut } from "../utils/ui.ts";
import { NOT_A_GIT_REPOSITORY } from "../services/git.ts";
import { registerAgentSkillCommand } from "./agent-skill.ts";

function formatBrief(brief: AgentBrief): string {
  const { checkout: c } = brief;
  const drift = c.upstream ? ` ${safeHumanText(c.upstream)} +${c.ahead ?? 0} -${c.behind ?? 0}` : " (no upstream)";
  const lines = [
    `${safeHumanText(c.root)}`,
    `branch ${c.branch === null ? "(detached)" : safeHumanText(c.branch)} ${c.head ?? "(unborn)"}${drift}${c.operation ? ` [${c.operation} in progress]` : ""}`,
    `commits ${c.unpublished ?? "?"} unpublished, ${c.aheadOfDefault ?? "?"} ahead of default${c.stackOperation ? ` [stack ${c.stackOperation.mode} of ${safeHumanText(c.stackOperation.selected)} unfinished]` : ""}`,
    `changes ${c.staged} staged, ${c.unstaged} unstaged, ${c.untracked} untracked, ${c.conflicts} conflicts`,
  ];
  const off = (label: string, section: { state: string; reason?: string }) => `${label} ${section.state}${section.reason ? `: ${safeHumanText(section.reason)}` : ""}`;
  const pr = brief.pullRequest;
  lines.push(pr.state === "available"
    ? `pr #${pr.number} ${pr.prState}${pr.draft ? " draft" : ""} into ${safeHumanText(pr.base)} review ${pr.reviewDecision ?? "none"} mergeable ${pr.mergeable}${pr.headMatchesLocal ? "" : " (local HEAD differs)"} ${safeHumanText(pr.url)}`
    : pr.state === "none" ? "pr none" : off("pr", pr));
  const { ci, reviewThreads: threads, linkedIssues: issues, stack } = brief;
  lines.push(ci.state === "available"
    ? `ci ${Object.entries(ci.counts).map(([bucket, count]) => `${count} ${bucket}`).join(", ") || "no checks"}${ci.failing.length ? ` (${ci.failing.map(safeHumanText).join(", ")})` : ""}`
    : off("ci", ci));
  lines.push(threads.state === "available" ? `threads ${threads.unresolved}${threads.complete === false ? "+" : ""} unresolved` : off("threads", threads));
  lines.push(issues.state === "available"
    ? `issues ${issues.items.map(issue => `${issue.repo ? safeHumanText(issue.repo) : ""}#${issue.number}${issue.artifacts.state === "available" ? ` (${issue.artifacts.items.length} artifacts)` : ""}`).join(", ") || "none"}${issues.more ? ` +${issues.more} more` : ""}`
    : off("issues", issues));
  lines.push(stack.state === "available"
    ? `stack #${stack.number} position ${stack.position}/${stack.size}${stack.below.length ? `, below ${stack.below.map(member => `#${member.number}`).join(" ")}` : ""}`
    : stack.state === "none" ? "stack none" : off("stack", stack));
  for (const hint of brief.next ?? []) lines.push(`next ${hint}`);
  return lines.join("\n");
}

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Discover the versioned automation contract and skill");
  registerAgentSkillCommand(agent);
  agent.command("brief").description("Summarize checkout, branch PR, CI, review threads, linked issues and stack in one read")
    .option("--local", "Skip every GitHub read")
    .action(async (options: { local?: boolean }) => {
      const checkout = await readBriefCheckout();
      if (!checkout) { fail(NOT_A_GIT_REPOSITORY, { code: "invalid_arguments" }); return; }
      const brief = await buildAgentBrief(checkout, { local: options.local });
      if (!jsonOut(brief)) data(formatBrief(brief));
    });
  agent.command("schema [command...]").description("Print the envelope schema and managed command paths, or one command's inputs and result schema")
    .action((target: string[] = []) => {
      const paths: string[][] = [];
      const inputs: Array<{
        path: string[];
        aliases: string[];
        arguments: Array<{ name: string; required: boolean; variadic: boolean; choices?: string[] }>;
        options: Array<{ name: string; short?: string; long?: string; takesValue: boolean; optionalValue: boolean; choices?: string[] }>;
      }> = [];
      function visit(parent: Command, prefix: string[]): void {
        for (const command of parent.commands) {
          if (prefix.length === 0 && !AGENT_CAPABLE.has(command.name())) continue;
          const path = [...prefix, command.name()];
          paths.push(path);
          inputs.push({
            path,
            aliases: command.aliases(),
            arguments: command.registeredArguments.map(argument => ({ name: argument.name(), required: argument.required, variadic: argument.variadic, ...(argument.argChoices ? { choices: argument.argChoices } : {}) })),
            options: command.options.filter(option => !option.hidden).map(option => ({ name: option.attributeName(), ...(option.short ? { short: option.short } : {}), ...(option.long ? { long: option.long } : {}), takesValue: option.required || option.optional, optionalValue: option.optional, ...(option.argChoices ? { choices: option.argChoices } : {}) })),
          });
          visit(command, path);
        }
      }
      visit(program, []);
      if (!target.length) {
        emitJson({ envelope: envelopeSchema, supportedCommandPaths: paths, inputs, unmanagedEscapes: ["ggh git", "ggh gh", "ggh --"], unsupportedDomains: program.commands.filter(command => !AGENT_CAPABLE.has(command.name()) && !["git", "gh"].includes(command.name())).map(command => command.name()), coreResultSchemas });
        return;
      }
      // Resolve aliases (st, co) to canonical names, then return only that command and its subcommands.
      const path: string[] = [];
      for (const word of target) {
        const match = inputs.find(entry => entry.path.length === path.length + 1 && entry.path.slice(0, -1).join(" ") === path.join(" ") && (entry.path.at(-1) === word || entry.aliases.includes(word)));
        if (!match) break;
        path.push(match.path.at(-1) ?? word);
      }
      if (path.length !== target.length) {
        fail(`Unknown agent command: ${target.join(" ")}. Run ggh agent schema --agent for every path.`, { code: "invalid_arguments" });
        return;
      }
      const within = (candidate: string[]) => path.every((word, index) => candidate[index] === word);
      type ResultSchema = { commandPaths: string[][]; includesSubcommands?: boolean };
      const applies = (value: ResultSchema) => value.commandPaths.some(paths => within(paths) || (value.includesSubcommands === true && paths.every((word, index) => path[index] === word)));
      const results = Object.fromEntries(Object.entries(coreResultSchemas as Record<string, unknown>)
        .filter(([, value]) => typeof value === "object" && value !== null && applies(value as ResultSchema)));
      emitJson({ envelope: envelopeSchema, command: path, inputs: inputs.filter(entry => within(entry.path)), resultSchemas: results });
    });
}
