import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CommitStyle } from "../utils/conventions.ts";

export type AIProvider = "codex" | "grok" | "claude" | "ollama";
export type CloneMode = "blobless" | "shallow" | "standard";

export const AI_PROVIDERS: readonly AIProvider[] = ["codex", "grok", "claude", "ollama"];
export const CLONE_MODES: readonly CloneMode[] = ["blobless", "shallow", "standard"];
export const COMMIT_STYLES = ["auto", "conventional", "gitmoji", "concise"] as const;

export interface GoodGhConfig {
  ai_provider?: AIProvider;
  /**
   * When false, only the configured provider is tried. Set this when the
   * provider was chosen for privacy (e.g. a local Ollama) so a failure never
   * silently falls through to a hosted model.
   */
  ai_fallback?: boolean;
  codex_model?: string;
  grok_model?: string;
  claude_model?: string;
  ollama_model?: string;
  default_clone_dir?: string;
  default_clone_mode?: CloneMode;
  commit_style?: "auto" | CommitStyle;
  /** Per-attempt timeout for an AI provider invocation, in milliseconds. */
  ai_timeout_ms?: number;
  /** User-owned consent to send sanitized repository content to hosted AI CLIs. */
  hosted_ai_consent?: boolean;
  first_run_completed?: boolean;
}

export const DEFAULT_CONFIG: Required<GoodGhConfig> = {
  ai_provider: "codex",
  ai_fallback: true,
  codex_model: "gpt-5.6-luna",
  grok_model: "grok-4.5",
  claude_model: "sonnet",
  ollama_model: "qwen2.5-coder",
  default_clone_dir: ".",
  default_clone_mode: "standard",
  commit_style: "auto",
  ai_timeout_ms: 120_000,
  hosted_ai_consent: false,
  first_run_completed: false,
};

export const MIN_AI_TIMEOUT_MS = 5_000;
export const MAX_AI_TIMEOUT_MS = 3_600_000;

/** A model slug: letters, digits, and the punctuation vendors actually use. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface ConfigProblem {
  key: string;
  message: string;
}

/**
 * Validates one config key/value. Returns the coerced value, or a problem.
 * Used for `ggh config set`, for environment variables, and for the project
 * `.ggh.json` a cloned repository may ship — which is untrusted input.
 */
export function validateConfigValue(key: string, raw: unknown): { value?: unknown; problem?: string } {
  switch (key as keyof GoodGhConfig) {
    case "ai_provider":
      return AI_PROVIDERS.includes(raw as AIProvider)
        ? { value: raw }
        : { problem: `must be one of ${AI_PROVIDERS.join(", ")}` };
    case "ai_fallback":
    case "hosted_ai_consent":
    case "first_run_completed": {
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "1" || raw === "on") return { value: true };
      if (raw === "false" || raw === "0" || raw === "off") return { value: false };
      return { problem: "must be true or false" };
    }
    case "codex_model":
    case "grok_model":
    case "claude_model":
    case "ollama_model":
      return typeof raw === "string" && MODEL_PATTERN.test(raw)
        ? { value: raw }
        : { problem: "must be a model name (letters, digits, . _ : / -)" };
    case "default_clone_dir": {
      if (typeof raw !== "string" || !raw.trim()) return { problem: "must be a directory path" };
      if (raw.includes("\0")) return { problem: "must not contain NUL" };
      return { value: raw };
    }
    case "default_clone_mode":
      return CLONE_MODES.includes(raw as CloneMode)
        ? { value: raw }
        : { problem: `must be one of ${CLONE_MODES.join(", ")}` };
    case "commit_style":
      return (COMMIT_STYLES as readonly string[]).includes(raw as string)
        ? { value: raw }
        : { problem: `must be one of ${COMMIT_STYLES.join(", ")}` };
    case "ai_timeout_ms": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < MIN_AI_TIMEOUT_MS || n > MAX_AI_TIMEOUT_MS) {
        return { problem: `must be an integer between ${MIN_AI_TIMEOUT_MS} and ${MAX_AI_TIMEOUT_MS}` };
      }
      return { value: n };
    }
    default:
      return { problem: "unknown key" };
  }
}

export function isConfigKey(key: string): key is keyof GoodGhConfig {
  return Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key);
}

/**
 * Drops anything in a raw object that is not a known key with a valid value.
 * Problems are returned so the CLI can warn about a typo'd or hostile file
 * instead of silently ignoring it.
 */
export function sanitizeConfig(raw: unknown): { config: Partial<GoodGhConfig>; problems: ConfigProblem[] } {
  const config: Partial<GoodGhConfig> = {};
  const problems: ConfigProblem[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, problems: [{ key: "<root>", message: "must be a JSON object" }] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isConfigKey(key)) {
      problems.push({ key, message: "unknown key" });
      continue;
    }
    const { value: ok, problem } = validateConfigValue(key, value);
    if (problem) problems.push({ key, message: problem });
    else (config as Record<string, unknown>)[key] = ok;
  }
  return { config, problems };
}

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

/**
 * Project-level keys a repository is allowed to set for everyone who clones
 * it. A cloned repository is untrusted, so it cannot choose a networked AI
 * provider, enable fallback, select a model, or change other user policy.
 */
const PROJECT_ALLOWED_KEYS: ReadonlySet<keyof GoodGhConfig> = new Set<keyof GoodGhConfig>([
  "commit_style",
]);

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function readUserConfig(): Partial<GoodGhConfig> {
  return sanitizeConfig(readJsonFile(getConfigPath())).config;
}

export interface ProjectConfig {
  path: string;
  config: Partial<GoodGhConfig>;
  problems: ConfigProblem[];
}

function readProjectConfig(path: string): ProjectConfig {
  const { config, problems } = sanitizeConfig(readJsonFile(path));
  for (const key of Object.keys(config) as Array<keyof GoodGhConfig>) {
    if (!PROJECT_ALLOWED_KEYS.has(key)) {
      delete config[key];
      problems.push({ key, message: "not allowed in a project file; set it in your user config" });
    }
  }
  return { path, config, problems };
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

/** The project config in effect for `cwd`, with any problems found in it. */
export function getProjectConfig(cwd = process.cwd()): ProjectConfig | null {
  const path = findProjectConfigPath(cwd);
  return path ? readProjectConfig(path) : null;
}

/**
 * Environment overrides, named after the config keys they set:
 * GGH_AI_PROVIDER, GGH_AI_FALLBACK, GGH_CODEX_MODEL, GGH_GROK_MODEL,
 * GGH_CLAUDE_MODEL, GGH_OLLAMA_MODEL, GGH_AI_TIMEOUT_MS, GGH_COMMIT_STYLE,
 * GGH_DEFAULT_CLONE_DIR, GGH_DEFAULT_CLONE_MODE, GGH_HOSTED_AI_CONSENT.
 */
function readEnvConfig(): Partial<GoodGhConfig> {
  const env: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof GoodGhConfig>) {
    if (key === "first_run_completed") continue;
    const raw = process.env[`GGH_${key.toUpperCase()}`];
    if (raw === undefined || raw === "") continue;
    const { value, problem } = validateConfigValue(key, raw);
    if (!problem) env[key] = value;
  }
  return env as Partial<GoodGhConfig>;
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
  const user = readUserConfig();
  const project = getProjectConfig(cwd)?.config ?? {};
  const env = readEnvConfig();
  return { ...DEFAULT_CONFIG, ...user, ...project, ...env };
}

/** Same resolution, but reporting which layer won each key. */
export function getConfigWithSources(cwd = process.cwd()): ConfigSource[] {
  const user = readUserConfig();
  const project = getProjectConfig(cwd)?.config ?? {};
  const env = readEnvConfig();

  return (Object.keys(DEFAULT_CONFIG) as Array<keyof GoodGhConfig>).map((key) => {
    if (env[key] !== undefined) return { key, value: env[key], source: "env" as const };
    if (project[key] !== undefined) return { key, value: project[key], source: "project" as const };
    if (user[key] !== undefined) return { key, value: user[key], source: "user" as const };
    return { key, value: DEFAULT_CONFIG[key], source: "default" as const };
  });
}

/**
 * Writes only the keys the user has actually set. Persisting defaults would
 * make every key report as "user" in `ggh config list` and freeze a default
 * that a later release wants to change.
 */
export function saveConfig(updates: Partial<GoodGhConfig>): GoodGhConfig {
  // Only the user-level file is ever written; project and env layers are yours.
  const current = readUserConfig();
  const merged: Partial<GoodGhConfig> = { ...current };
  for (const [key, value] of Object.entries(updates) as Array<[keyof GoodGhConfig, unknown]>) {
    if (value === undefined) delete merged[key];
    else (merged as Record<string, unknown>)[key] = value;
  }

  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  return { ...DEFAULT_CONFIG, ...merged };
}
