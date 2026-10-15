import { afterEach, expect, spyOn, test } from "bun:test";
import { data, emitJson, log, note, spinner } from "../src/utils/output.ts";
import { resetFlags } from "../src/services/runtime.ts";

const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  resetFlags();
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else Reflect.deleteProperty(process.stdout, "isTTY");
});

function capture(stream: NodeJS.WriteStream, action: () => void): string {
  const chunks: string[] = [];
  const writer = spyOn(stream, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  try { action(); } finally { writer.mockRestore(); }
  return chunks.join("");
}

const commands = [
  "\x1b]52;c;dGVzdA==\x07", "\x1b[2J", "\x1bPpayload\x1b\\",
  "\x9d52;c;dGVzdA==\x9c", "\x1b]unterminated", "\x1bPunterminated", "\x1b[123",
];

test("managed text removes terminal commands and preserves readable content", () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  for (const command of commands) {
    const text = `雪\ttext${command}`;
    const stdout = capture(process.stdout, () => data(text));
    expect(stdout).toBe("雪\ttext\n");
    const stderr = capture(process.stderr, () => log.error(text));
    expect(stderr).toContain("雪\ttext\n");
    expect(stderr).not.toContain(command);
  }
  expect(capture(process.stdout, () => data("a\rb\bc\x07\nc"))).toBe("abc\nc\n");
  expect(capture(process.stdout, () => data("\x1b[31mred\x1b[0m"))).toBe("\x1b[31mred\x1b[0m\n");
});

test("notes sanitize payloads before sizing the box", () => {
  const plain = capture(process.stderr, () => note("body", "title"));
  const malicious = capture(process.stderr, () => note("body\x1b]52;c;" + "x".repeat(100) + "\x07", "title\x1b[2J"));
  expect(malicious).toBe(plain);
});

test("spinner messages are sanitized while JSON retains original values", () => {
  const payload = "hello\x1b]52;c;secret\x07";
  const progress = spinner();
  const output = capture(process.stderr, () => { progress.start(payload); progress.message(payload); progress.stop(payload); });
  expect(output).not.toContain("\x1b]52");
  const json = capture(process.stdout, () => emitJson({ text: payload }));
  expect(JSON.parse(json)).toEqual({ text: payload });
});

test("piped data preserves original text bytes", () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  const payload = "雪\ttext\r\n" + commands.join("");
  expect(capture(process.stdout, () => data(payload))).toBe(`${payload}\n`);
});
