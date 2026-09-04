import pc from "picocolors";
import {
  describeAIFailure,
  type AIAttempt,
  type AIAttemptFailure,
  type AIProvider,
} from "../services/ai/index.ts";
import { getFlags, isNonInteractive } from "../services/runtime.ts";
import { cancel, emitJson, intro, log, note, outro, spinner } from "./output.ts";
import { confirmPrompt, selectMenu } from "./prompts.ts";

/**
 * Drop-in replacement for the @clack/prompts surface this CLI still used
 * (logging, spinner, note, intro/outro). Everything writes to stderr so stdout
 * stays reserved for data.
 */
export const p = { log, spinner, note, intro, outro, cancel };

export { pc };
export { data, emitJson, renderDiff, restoreTerminal } from "./output.ts";

/**
 * One-line narration for a spinner while the provider chain falls back, e.g.
 * "Codex [gpt-5.6-luna] usage limit or credits exhausted — trying xAI Grok [grok-4.5]...".
 */
export function formatAIFallback(failure: AIAttemptFailure, next?: AIAttempt): string {
  const failed = `${pc.yellow(failure.providerName)} ${pc.dim(`[${failure.model}]`)} ${failure.reason}`;
  if (!next) return `${failed} — no providers left`;
  return `${failed} — trying ${pc.cyan(next.providerName)} ${pc.dim(`[${next.model}]`)}...`;
}

/**
 * Prints exactly why AI generation failed, per provider and model, plus what to
 * do about it. Never swallow a provider error: "AI unavailable" alone is useless.
 */
export function reportAIFailure(err: unknown, headline: string): void {
  const { summary, steps } = describeAIFailure(err);
  p.log.warn(pc.yellow(headline));
  for (const line of summary.split("\n")) {
    p.log.message(`  ${pc.red("✖")} ${line}`);
  }
  for (const step of steps) {
    p.log.message(`  ${pc.cyan("→")} ${pc.dim(step)}`);
  }
}

export {
  confirmPrompt,
  multiSelectMenu,
  promptInput,
  promptSecretInput,
  searchablePicker,
  selectMenu,
} from "./prompts.ts";
export type {
  MenuOption,
  MultiSelectMenuOption,
  PickerItem,
  SelectMenuOption,
} from "./prompts.ts";

/**
 * Reports a command failure and marks the process as failed, so `ggh` can be
 * used in scripts and CI without every caller remembering to set exitCode.
 */
export function fail(message: string): void {
  process.exitCode = 1;
  p.log.error(message);
}

/**
 * Handles an unknown error from a `gh` call. If it's a `GitHubError`, uses its
 * message; otherwise falls back to `String(err)`. Replaces 85 copies of the
 * same ternary across command files.
 */
export function failFromGitHub(err: unknown): void {
  fail(err instanceof Error ? err.message : String(err));
}

/**
 * Emits `value` as JSON and reports whether it did. Collapses the
 * `if (getFlags().json) { emitJson(v); return; }` triplet found at ~95
 * call sites into `if (jsonOut(v)) return;`.
 */
export function jsonOut(value: unknown): boolean {
  if (!getFlags().json) return false;
  emitJson(value);
  return true;
}

/**
 * Confirms a destructive action, honouring an explicit `--yes`. Returns true
 * when the caller should proceed. Prints `cancelText` (default "Cancelled.")
 * on decline; pass `cancelText: null` when the caller handles decline itself
 * (e.g. positive-logic `if (proceed) { ... }` flows).
 */
export async function confirmOrAbort(
  message: string,
  options?: { assumeYes?: boolean; initialValue?: boolean; cancelText?: string | null },
): Promise<boolean> {
  const confirmed = await confirmPrompt({
    message,
    initialValue: options?.initialValue ?? true,
    assumeYes: options?.assumeYes,
  });
  if (!confirmed && options?.cancelText !== null) {
    p.cancel(options?.cancelText ?? "Cancelled.");
  }
  return confirmed;
}

/**
 * Reports an unrecognised positional action with the valid choices, e.g.
 * `Unknown draft action: bogus. Try create, list, resume, or drop.`
 */
export function unknownAction(domain: string, action: string | undefined, valid: string[]): void {
  const last = valid[valid.length - 1];
  const list = valid.length > 1 ? `${valid.slice(0, -1).join(", ")}, or ${last}` : (last ?? "");
  fail(`Unknown ${domain} action: ${action}. Try ${list}.`);
}

export function header(title: string): void {
  p.intro(pc.bgCyan(pc.black(` good-gh `)) + " " + pc.bold(title));
}

type FirstRunProvider = "codex" | "grok" | "claude" | "ollama";

export async function promptFirstRunProvider(available: AIProvider[]): Promise<FirstRunProvider> {
  const detected = new Set(available.map((provider) => provider.id));

  if (detected.size === 0) {
    p.log.warn(
      pc.yellow(
        "No local AI CLI was detected. Install and sign in to `codex`, `grok`, or `claude`, or install `ollama`, to enable AI messages.",
      ),
    );
    p.log.info(pc.dim("Until then, `ggh commit -m \"...\"` and `ggh commit --no-ai` still work."));
  } else {
    p.note(
      `Detected local AI login(s): ${[...detected].join(", ")}.\nNo API keys or credit cards required.`,
      "First-Time Setup",
    );
  }

  const describe = (id: FirstRunProvider, ok: string, install: string) =>
    detected.has(id) ? `detected — ${ok}` : `not detected (${install})`;

  const options = [
    { value: "codex" as const, label: "Codex (ChatGPT)", hint: describe("codex", "hosted; sends sanitized repository content", "run `codex login`") },
    { value: "grok" as const, label: "xAI Grok", hint: describe("grok", "hosted; sends sanitized repository content", "run `grok login`") },
    { value: "claude" as const, label: "Claude Code", hint: describe("claude", "hosted; sends sanitized repository content", "run `claude login`") },
    { value: "ollama" as const, label: "Ollama (local)", hint: describe("ollama", "offline, nothing leaves this machine", "install from ollama.com") },
  ];

  // Preselect something that actually works rather than always defaulting to Codex.
  const initialValue: FirstRunProvider =
    (["codex", "grok", "claude", "ollama"] as const).find((id) => detected.has(id)) ?? "codex";

  if (isNonInteractive()) {
    p.log.info(pc.dim(`Defaulting to ${initialValue} (nothing to prompt on).`));
    return initialValue;
  }

  const selection = await selectMenu<FirstRunProvider>({
    message: "Choose your primary AI provider:",
    options,
    initialValue,
  });

  if (selection === null) {
    p.cancel(`Setup cancelled. Defaulting to ${initialValue}.`);
    return initialValue;
  }

  return selection;
}
