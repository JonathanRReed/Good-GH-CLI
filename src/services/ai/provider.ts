import type {
  CommitMessageResult,
  CommitPromptInput,
  PrContentResult,
  PrPromptInput,
} from "./prompt.ts";

export interface AIProvider {
  readonly id: "codex" | "grok";
  readonly displayName: string;
  readonly defaultModel: string;
  isAvailable(): Promise<boolean>;
  generateCommit(input: CommitPromptInput, model?: string): Promise<CommitMessageResult>;
  generatePr(input: PrPromptInput, model?: string): Promise<PrContentResult>;
  generateBranchName(taskDescription: string, model?: string): Promise<string>;
}
