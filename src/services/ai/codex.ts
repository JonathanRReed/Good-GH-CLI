import { run } from "../../utils/exec.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

export class CodexProvider implements AIProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex (Luna / ChatGPT)";
  readonly defaultModel = "gpt-5.6-luna";

  async isAvailable(): Promise<boolean> {
    try {
      // Check auth file first
      const authPath = join(homedir(), ".codex", "auth.json");
      if (existsSync(authPath)) {
        return true;
      }
      const result = await run("codex", ["login", "status"], { reject: false });
      const combined = `${result.stdout} ${result.stderr}`.toLowerCase();
      return combined.includes("logged in");
    } catch {
      return false;
    }
  }

  private async runPrompt(prompt: string, model = this.defaultModel): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "good-gh-codex-"));
    const outputPath = join(tmpDir, "output.txt");

    try {
      await run(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "-o",
          outputPath,
          "-",
        ],
        {
          input: prompt,
          timeoutMs: 60_000,
        },
      );

      const content = readFileSync(outputPath, "utf-8").trim();
      return content;
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
