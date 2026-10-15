import type { Command, Option } from "commander";
import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

async function fileCandidates(prefix: string, cwd: string): Promise<string[]> {
  const directory = dirname(prefix);
  const separator = process.platform === "win32" && prefix.includes("\\") ? "\\" : "/";
  const trailing = prefix.endsWith("/") || process.platform === "win32" && prefix.endsWith("\\");
  const part = trailing ? "" : basename(prefix);
  const base = trailing ? prefix : directory === "." ? "" : `${directory}${separator}`;
  const entries = await readdir(resolve(cwd, base || "."), { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.name.startsWith(part) && !/[\r\n\t]/.test(entry.name))
    .map(entry => `${base}${entry.name}${entry.isDirectory() ? separator : ""}`);
}

async function valueCandidates(option: Option, prefix: string, cwd: string): Promise<string[]> {
  if (option.argChoices) return option.argChoices;
  if (/^--(?:base|branch|head)$/.test(option.long ?? "")) {
    const { listBranches } = await import("./git.ts");
    return (await listBranches(cwd).catch(() => [])).map(branch => branch.name);
  }
  if (/^--(?:attach|body-file|from|dir|source|file|output)$/.test(option.long ?? "")) return fileCandidates(prefix, cwd);
  return [];
}

export async function completionCandidates(program: Command, words: readonly string[], cwd = process.cwd()): Promise<string[]> {
  const prefix = words.at(-1) ?? "";
  const previous = words.slice(0, -1);
  let current = program;
  let awaiting: Option | undefined;
  let literal = false;
  let argumentsSeen = 0;
  for (const word of previous) {
    if (awaiting) {
      if (!awaiting.optional || !word.startsWith("-")) { awaiting = undefined; continue; }
      awaiting = undefined;
    }
    if (word === "--") { literal = true; continue; }
    if (!literal && word.startsWith("-")) {
      const option = current.options.find(candidate => candidate.long === word || candidate.short === word);
      if (option?.required || option?.optional) awaiting = option;
      continue;
    }
    const next = !literal ? current.commands.find(command => command.name() === word || command.aliases().includes(word)) : undefined;
    if (next) { current = next; argumentsSeen = 0; }
    else argumentsSeen++;
  }
  let candidates: string[];
  if (awaiting?.optional && prefix.startsWith("-")) awaiting = undefined;
  if (awaiting) candidates = await valueCandidates(awaiting, prefix, cwd);
  else if (!literal && prefix.startsWith("-")) candidates = current.options.filter(option => !option.hidden).flatMap(option => [option.short, option.long].filter((flag): flag is string => Boolean(flag)));
  else if (current.name() === "completion") candidates = ["zsh", "bash", "fish", "powershell"];
  else {
    candidates = !literal ? current.commands.filter(command => command.name() !== "help").flatMap(command => [command.name(), ...command.aliases()]) : [];
    const argument = current.registeredArguments[argumentsSeen] ?? current.registeredArguments.find(item => item.variadic);
    if (argument?.argChoices) candidates.push(...argument.argChoices);
    if (argument && /branch|target/i.test(argument.name()) && ["switch", "checkout", "on", "restack"].includes(current.name())) {
      const { listBranches } = await import("./git.ts");
      candidates.push(...(await listBranches(cwd).catch(() => [])).map(branch => branch.name));
    } else if (argument && /file|path|directory/i.test(argument.name())) candidates.push(...await fileCandidates(prefix, cwd));
    else if (argument?.name() === "id" && current.parent?.name() === "operation") {
      const { listOperations } = await import("./operations.ts");
      candidates.push(...(await listOperations(cwd).catch(() => [])).map(record => record.id));
    }
  }
  return [...new Set(candidates)].filter(candidate => candidate.startsWith(prefix)).sort();
}
