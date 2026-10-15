import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { PassThrough, Writable } from "node:stream";
import { BufferedLineInput } from "../src/utils/line-input.ts";

describe("BufferedLineInput", () => {
  it("keeps complete typeahead lines for the next question and releases stdin", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lineInput = new BufferedLineInput(input);
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    input.write("alpha\rbravo\r");

    const first = await lineInput.readLine(output, "First: ", "Header one\n");
    expect(first).toBe("alpha");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);

    const secondRead = lineInput.readLine(output, "Second: ", "Header two\n");
    const second = await Promise.race([
      secondRead,
      Bun.sleep(50).then(() => "timed out" as const),
    ]);
    if (second === "timed out") input.destroy();
    expect(second).toBe("bravo");
    expect(stripVTControlCharacters(rendered).replace(/\r/g, "")).toContain("Header one\nFirst: ");
    expect(stripVTControlCharacters(rendered).replace(/\r/g, "")).toContain("Header two\nSecond: ");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);

    input.destroy();
    output.destroy();
  });

  it("takes ownership before displaying the prompt", async () => {
    const input = new PassThrough();
    let ownedWhenHeaderWasWritten = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (chunk.toString().includes("Header: ")) {
          ownedWhenHeaderWasWritten = input.listenerCount("keypress") > 0;
        }
        callback();
      },
    });
    const lineInput = new BufferedLineInput(input);

    const pending = lineInput.readLine(output, "Prompt: ", "Header: ");
    expect(ownedWhenHeaderWasWritten).toBe(true);
    input.write("answer\r");
    const answer = await Promise.race([
      pending,
      Bun.sleep(50).then(() => "timed out" as const),
    ]);

    expect(answer).toBe("answer");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);
    input.destroy();
    output.destroy();
  });

  it("returns null on EOF and leaves no reader attached", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lineInput = new BufferedLineInput(input);

    const pending = lineInput.readLine(output);
    input.end();

    expect(await pending).toBeNull();
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);
    output.destroy();
  });

  it("returns null on Ctrl-C and releases the input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lineInput = new BufferedLineInput(input);

    const pending = lineInput.readLine(output);
    input.write("\u0003");
    const answer = await Promise.race([
      pending,
      Bun.sleep(50).then(() => "timed out" as const),
    ]);

    expect(answer).toBeNull();
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);
    input.destroy();
    output.destroy();
  });

  it("carries a partially typed next answer into the next question", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lineInput = new BufferedLineInput(input);
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    input.write("alpha\rbr");

    expect(await lineInput.readLine(output, "First: ")).toBe("alpha");
    const secondRead = lineInput.readLine(output, "Second: ");
    input.write("avo\r");
    const second = await Promise.race([
      secondRead,
      Bun.sleep(50).then(() => "timed out" as const),
    ]);

    expect(second).toBe("bravo");
    expect(stripVTControlCharacters(rendered).replace(/\r/g, "")).toContain("Second: ");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.readableFlowing).toBe(false);
    input.destroy();
    output.destroy();
  });
});
