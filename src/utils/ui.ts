import * as p from "@clack/prompts";
import * as readline from "node:readline/promises";
import pc from "picocolors";
import type { AIProvider } from "../services/ai/index.ts";

export { p, pc };

export async function promptInput(options: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${pc.cyan("◆")}  ${options.message}\n`);
    const defaultVal = options.initialValue || options.defaultValue;
    const hint = defaultVal
      ? pc.dim(` [default: ${defaultVal}]`)
      : options.placeholder
        ? pc.dim(` (${options.placeholder})`)
        : "";
    const promptStr = `${pc.dim("│")}  ${pc.cyan("›")} ${hint ? hint + " " : ""}`;
    const answer = await rl.question(promptStr);
    const result = answer.trim() || defaultVal || "";
    if (options.validate) {
      const err = options.validate(result);
      if (err) {
        process.stdout.write(`${pc.yellow("└")}  ${pc.yellow(err)}\n`);
        rl.close();
        return promptInput(options);
      }
    }
    process.stdout.write(`${pc.dim("└")}\n`);
    return result;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export function header(title: string): void {
  p.intro(pc.bgCyan(pc.black(` good-gh `)) + " " + pc.bold(title));
}

export function footer(message?: string): void {
  p.outro(message ? pc.green(`✔ ${message}`) : pc.dim("Done."));
}

export function formatError(message: string): string {
  return pc.red(`✖ ${message}`);
}

export function formatSuccess(message: string): string {
  return pc.green(`✔ ${message}`);
}

export function formatInfo(message: string): string {
  return pc.cyan(`ℹ ${message}`);
}

export function formatWarning(message: string): string {
  return pc.yellow(`▲ ${message}`);
}

export async function promptFirstRunProvider(_available: AIProvider[]): Promise<"codex" | "grok"> {
  p.note(
    "Good GH CLI detected your local AI logins (Codex / Grok).\nNo API keys or credit cards required!",
    "First-Time Setup",
  );

  const options = [
    {
      value: "codex" as const,
      label: "Codex (Luna / ChatGPT)",
      hint: "Fast & high-quality using gpt-5.6-luna (Recommended)",
    },
    {
      value: "grok" as const,
      label: "xAI Grok",
      hint: "Using your local grok CLI session",
    },
  ];

  const selection = await p.select({
    message: "Choose your primary AI commit provider:",
    options,
    initialValue: "codex",
  });

  if (p.isCancel(selection)) {
    p.cancel("Setup cancelled. Defaulting to Codex (Luna).");
    return "codex";
  }

  return selection as "codex" | "grok";
}
