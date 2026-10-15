import * as readline from "node:readline/promises";

/**
 * Owns complete lines and partial text consumed by one readline interface.
 * Each read opens and closes its interface, while typeahead survives between
 * text prompts without leaving a line reader attached to stdin.
 */
export class BufferedLineInput {
  private readonly pendingLines: string[] = [];
  private pendingText = "";

  constructor(private readonly input: NodeJS.ReadableStream) {}

  readLine(
    output: NodeJS.WritableStream,
    prompt = "",
    prefix = "",
  ): Promise<string | null> {
    const pendingLine = this.pendingLines.shift();
    if (pendingLine !== undefined) {
      output.write(prefix);
      output.write(prompt);
      return Promise.resolve(pendingLine);
    }

    const rl = readline.createInterface({
      input: this.input,
      output,
      terminal: true,
    });
    rl.setPrompt(prompt);
    const pendingText = this.pendingText;
    this.pendingText = "";

    let receivedFirstLine = false;
    return new Promise<string | null>((resolve) => {
      rl.on("line", (line) => {
        if (!receivedFirstLine) {
          receivedFirstLine = true;
          resolve(line);
          return;
        }
        this.pendingLines.push(line);
      });

      rl.on("close", () => {
        if (!receivedFirstLine) resolve(null);
      });

      rl.on("SIGINT", () => {
        rl.close();
        if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT", "SIGINT");
      });

      output.write(prefix);
      rl.prompt();
      if (pendingText) rl.write(pendingText);
    }).finally(() => {
      if (receivedFirstLine && rl.line) this.pendingText = rl.line;
      rl.close();
      this.input.pause();
    });
  }
}
