import { expect, spyOn, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { confirmPrompt, multiSelectMenu, readHiddenLine, searchablePicker, selectMenu } from "../src/utils/prompts.ts";
import { resetFlags } from "../src/services/runtime.ts";

const payload = "\x1b]52;c;" + "x".repeat(100) + "\x07";

test("interactive prompts sanitize frames and completion without changing returned values", async () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const rawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const rawStates: boolean[] = [];
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: (raw: boolean) => { rawStates.push(raw); return process.stdin; } });
  const chunks: string[] = [];
  const writer = spyOn(process.stderr, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  resetFlags();
  try {
    const original = { id: "original", text: payload };
    const item = { value: original, label: `label${payload}`, hint: `hint${payload}` };
    const cases = [
      { start: () => searchablePicker({ title: `title${payload}`, items: [item] }), cancel: false, expected: original },
      { start: () => searchablePicker({ title: `title${payload}`, items: [item] }), cancel: true, expected: null },
      { start: () => selectMenu({ message: `title${payload}`, options: [item] }), cancel: false, expected: original },
      { start: () => selectMenu({ message: `title${payload}`, options: [item] }), cancel: true, expected: null },
      { start: () => multiSelectMenu({ message: `title${payload}`, options: [item], initialValues: [original] }), cancel: false, expected: [original] },
      { start: () => confirmPrompt({ message: `title${payload}` }), cancel: true, expected: false },
    ];
    for (const scenario of cases) {
      chunks.length = 0;
      const result = scenario.start();
      process.stdin.emit("keypress", "", { name: scenario.cancel ? "escape" : "return" });
      expect(await result).toEqual(scenario.expected);
      const output = chunks.join("");
      expect(output).not.toContain("\x1b]52");
      expect(output).not.toContain("x".repeat(100));
      expect(output).toContain("title");
      if (!scenario.cancel && scenario.expected === original) expect(output).toContain("hint");
      // eslint-disable-next-line no-control-regex
      expect(output).toMatch(/\x1b\[\d+A\r\x1b\[J/);
      expect(process.stdin.listenerCount("keypress")).toBe(0);
    }
    expect(rawStates).toEqual(Array.from({ length: 6 }, () => [true, false]).flat());
  } finally {
    writer.mockRestore();
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (rawMode) Object.defineProperty(process.stdin, "setRawMode", rawMode); else Reflect.deleteProperty(process.stdin, "setRawMode");
    resetFlags();
  }
});

test("hidden prompts sanitize message and validation error without exposing the secret", async () => {
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, done) { rendered += String(chunk); done(); } });
  const pending = readHiddenLine({ input, output, message: `message${payload}`, validate: (value) => value === "first-secret" ? `retry${payload}` : undefined });
  input.write("first-secret\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.write("second-secret\n");
  expect(await pending).toBe("second-secret");
  input.end();
  expect(rendered).toContain("message");
  expect(rendered).toContain("retry");
  expect(rendered).not.toContain("\x1b]52");
  expect(rendered).not.toContain("secret");
});
