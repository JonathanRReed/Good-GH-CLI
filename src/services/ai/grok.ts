import { execa } from "execa";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider } from "./provider.ts";
import {
  buildBranchNamePrompt,
  buildCommitPrompt,
  buildPrPrompt,
  parseJsonResponse,
  type CommitMessageResult,
  type CommitPromptInput,
  type PrContentResult,
  type PrPromptInput,
} from "./prompt.ts";

export class GrokProvider implements AIProvider {
  readonly id = "grok" as const;
  readonly displayName = "xAI Grok";
  readonly defaultModel = "grok-4.5";

  async isAvailable(): Promise<boolean> {
    try {
      const authPath = join(homedir(), ".grok", "auth.json");
      if (existsSync(authPath)) {
        return true;
      }
      const { stdout } = await execa("grok", ["models"], { reject: false });
      return !stdout.includes("not authenticated");
    } catch {
      return false;
    }
  }

  private async runPrompt(prompt: string, model = this.defaultModel): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "good-gh-grok-"));
    const promptPath = join(tmpDir, "prompt.txt");

    try {
      // Securely write prompt to file with 0o600 permissions (avoids ps aux argument sniffing)
      writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });

      const { stdout } = await execa(
        "grok",
        ["--prompt-file", promptPath, "--model", model, "--output-format", "plain"],
        {
          timeout: 60_000,
        },
      );
      return stdout.trim();
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  async generateCommit(
    input: CommitPromptInput,
    model = this.defaultModel,
  ): Promise<CommitMessageResult> {
    const prompt = buildCommitPrompt(input);
    const raw = await this.runPrompt(prompt, model);

    const parsed = parseJsonResponse<CommitMessageResult>(raw, {
      subject: raw.split("\n")[0]?.slice(0, 72) || "update files",
      body: raw.split("\n").slice(1).join("\n").trim(),
    });

    return {
      subject: parsed.subject.replace(/\.$/, "").trim(),
      body: (parsed.body || "").trim(),
    };
  }

  async generatePr(
    input: PrPromptInput,
    model = this.defaultModel,
  ): Promise<PrContentResult> {
    const prompt = buildPrPrompt(input);
    const raw = await this.runPrompt(prompt, model);

    const parsed = parseJsonResponse<PrContentResult>(raw, {
      title: raw.split("\n")[0]?.slice(0, 72) || "Update repository",
      body: raw.split("\n").slice(1).join("\n").trim(),
    });

    return {
      title: parsed.title.trim(),
      body: parsed.body.trim(),
    };
  }

  async generateBranchName(
    taskDescription: string,
    model = this.defaultModel,
  ): Promise<string> {
    const prompt = buildBranchNamePrompt(taskDescription);
    const raw = await this.runPrompt(prompt, model);
    const branch = raw
      .trim()
      .split("\n")[0]
      .replace(/[`'"]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase();
    return branch || "feat/update";
  }
}
