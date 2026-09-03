import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommitStyle } from "../utils/conventions.ts";

export type AIProvider = "codex" | "grok" | "claude" | "ollama";
export type CloneMode = "blobless" | "shallow" | "standard";

export interface GoodGhConfig {
  ai_provider?: AIProvider;
  codex_model?: string;
  grok_model?: string;
  claude_model?: string;
  ollama_model?: string;
  default_clone_dir?: string;
  default_clone_mode?: CloneMode;
  commit_style?: "auto" | CommitStyle;
  /** Per-attempt timeout for an AI provider invocation, in milliseconds. */
  ai_timeout_ms?: number;
  first_run_completed?: boolean;
}

const DEFAULT_CONFIG: Required<GoodGhConfig> = {
  ai_provider: "codex",
  codex_model: "gpt-5.6-luna",
  grok_model: "grok-4.5",
  claude_model: "sonnet",
  ollama_model: "qwen2.5-coder",
  default_clone_dir: ".",
  default_clone_mode: "standard",
  commit_style: "auto",
  ai_timeout_ms: 120_000,
  first_run_completed: false,
};

export function getConfigDir(): string {
  const baseDir =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(baseDir, "good-gh");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

/** Per-repository overrides, so a work repo and a personal repo can differ. */
export const PROJECT_CONFIG_FILENAME = ".ggh.json";

function readJsonFile(filePath: string): Partial<GoodGhConfig> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Partial<GoodGhConfig>;
  } catch {
    return {};
  }
}

/** Walks up from `cwd` to the filesystem root looking for a project config. */
export function findProjectConfigPath(cwd = process.cwd()): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Environment overrides, named after the config keys they set:
 * GGH_AI_PROVIDER, GGH_CODEX_MODEL, GGH_GROK_MODEL, GGH_AI_TIMEOUT_MS,
 * GGH_COMMIT_STYLE, GGH_DEFAULT_CLONE_DIR, GGH_DEFAULT_CLONE_MODE.
 */
function readEnvConfig(): Partial<GoodGhConfig> {
  const env: Partial<GoodGhConfig> = {};
  const provider = process.env.GGH_AI_PROVIDER;
  if (provider === "codex" || provider === "grok" || provider === "claude" || provider === "ollama") {
    env.ai_provider = provider;
  }
  if (process.env.GGH_CODEX_MODEL) env.codex_model = process.env.GGH_CODEX_MODEL;
  if (process.env.GGH_GROK_MODEL) env.grok_model = process.env.GGH_GROK_MODEL;
  if (process.env.GGH_DEFAULT_CLONE_DIR) env.default_clone_dir = process.env.GGH_DEFAULT_CLONE_DIR;

  const mode = process.env.GGH_DEFAULT_CLONE_MODE;
  if (mode === "standard" || mode === "blobless" || mode === "shallow") env.default_clone_mode = mode;

  const style = process.env.GGH_COMMIT_STYLE;
  if (style === "auto" || style === "conventional" || style === "gitmoji" || style === "concise") {
    env.commit_style = style;
  }

  const timeout = Number.parseInt(process.env.GGH_AI_TIMEOUT_MS ?? "", 10);
  if (!Number.isNaN(timeout) && timeout >= 5_000) env.ai_timeout_ms = timeout;

  return env;
}

export interface ConfigSource {
  key: keyof GoodGhConfig;
  value: unknown;
  /** Which layer supplied the effective value. */
  source: "default" | "user" | "project" | "env";
}

/**
 * Resolves configuration with the precedence every CLI is expected to honour:
 * environment > project file > user file > defaults. Command-line flags sit
 * above all of these and are applied by the commands themselves.
 */
export function getConfig(cwd = process.cwd()): GoodGhConfig {
  const user = readJsonFile(getConfigPath());
  const projectPath = findProjectConfigPath(cwd);
  const project = projectPath ? readJsonFile(projectPath) : {};
  const env = readEnvConfig();

  const merged = { ...DEFAULT_CONFIG, ...user, ...project, ...env };
  if (!existsSync(getConfigPath()) && !projectPath) {
    merged.first_run_completed = user.first_run_completed ?? false;
  }
  return merged;
}

/** Same resolution, but reporting which layer won each key. */
export function getConfigWithSources(cwd = process.cwd()): ConfigSource[] {
  const user = readJsonFile(getConfigPath());
  const projectPath = findProjectConfigPath(cwd);
  const project = projectPath ? readJsonFile(projectPath) : {};
  const env = readEnvConfig();

  return (Object.keys(DEFAULT_CONFIG) as Array<keyof GoodGhConfig>).map((key) => {
    if (env[key] !== undefined) return { key, value: env[key], source: "env" as const };
    if (project[key] !== undefined) return { key, value: project[key], source: "project" as const };
    if (user[key] !== undefined) return { key, value: user[key], source: "user" as const };
    return { key, value: DEFAULT_CONFIG[key], source: "default" as const };
  });
}

export function saveConfig(updates: Partial<GoodGhConfig>): GoodGhConfig {
  // Only the user-level file is ever written; project and env layers are yours.
  const current = { ...DEFAULT_CONFIG, ...readJsonFile(getConfigPath()) };
  const updated: GoodGhConfig = {
    ...current,
    ...updates,
  };

  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(getConfigPath(), JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}
