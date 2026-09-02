import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommitStyle } from "../utils/conventions.ts";

export type AIProvider = "codex" | "grok";
export type CloneMode = "blobless" | "shallow" | "standard";

export interface GoodGhConfig {
  ai_provider?: AIProvider;
  codex_model?: string;
  grok_model?: string;
  default_clone_dir?: string;
  default_clone_mode?: CloneMode;
  commit_style?: "auto" | CommitStyle;
  first_run_completed?: boolean;
}

const DEFAULT_CONFIG: Required<GoodGhConfig> = {
  ai_provider: "codex",
  codex_model: "gpt-5.6-luna",
  grok_model: "grok-4.5",
  default_clone_dir: ".",
  default_clone_mode: "standard",
  commit_style: "auto",
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

export function getConfig(): GoodGhConfig {
  const filePath = getConfigPath();
  if (!existsSync(filePath)) {
    return { ...DEFAULT_CONFIG, first_run_completed: false };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG, first_run_completed: false };
  }
}

export function saveConfig(updates: Partial<GoodGhConfig>): GoodGhConfig {
  const current = getConfig();
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
