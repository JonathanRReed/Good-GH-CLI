import { describe, expect, it } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { eraseFrame, readHiddenLine, terminalColumns, visibleWindow } from "../src/utils/prompts.ts";

/**
 * The three interactive pickers (searchablePicker, selectMenu,
 * multiSelectMenu) share this windowing math. It is pure, so it is tested
 * here — the TTY rendering around it cannot run headless.
 */
describe("visibleWindow", () => {
  it("shows the first page when the cursor is at the top", () => {
    expect(visibleWindow(0, 20, 7)).toEqual({ start: 0, index: 0 });
    expect(visibleWindow(2, 20, 7)).toEqual({ start: 0, index: 2 });
  });

  it("centers the page on the cursor in the middle", () => {
    expect(visibleWindow(10, 20, 7)).toEqual({ start: 7, index: 10 });
  });

  it("pins to the last page at the bottom", () => {
    expect(visibleWindow(19, 20, 7)).toEqual({ start: 13, index: 19 });
    expect(visibleWindow(999, 20, 7)).toEqual({ start: 13, index: 19 });
  });

  it("clamps a negative cursor to zero", () => {
    expect(visibleWindow(-3, 20, 7)).toEqual({ start: 0, index: 0 });
  });

  it("handles lists shorter than the page", () => {
    expect(visibleWindow(0, 3, 7)).toEqual({ start: 0, index: 0 });
    expect(visibleWindow(2, 3, 7)).toEqual({ start: 0, index: 2 });
    expect(visibleWindow(9, 3, 7)).toEqual({ start: 0, index: 2 });
  });

  it("handles an empty list without NaN", () => {
    const { start, index } = visibleWindow(0, 0, 7);
    expect(start).toBe(0);
    expect(index).toBe(0);
    expect(Number.isNaN(start + index)).toBe(false);
  });

  it("keeps the window inside the list for every cursor position", () => {
    for (let total = 1; total < 30; total++) {
      for (let cursor = -2; cursor < total + 2; cursor++) {
        const { start, index } = visibleWindow(cursor, total, 7);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(total);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start + 7).toBeGreaterThan(index);
        expect(start).toBeLessThanOrEqual(index);
      }
    }
  });
});

describe("terminalColumns", () => {
  it("returns a sane width", () => {
    const cols = terminalColumns();
    expect(Number.isInteger(cols)).toBe(true);
    expect(cols).toBeGreaterThanOrEqual(40);
  });
});

describe("eraseFrame", () => {
  it("is a no-op for zero lines (nothing to erase)", () => {
    expect(() => eraseFrame(0)).not.toThrow();
  });
});

describe("readHiddenLine", () => {
  it("returns the typed secret without echoing it", async () => {
    const input = new PassThrough();
    let rendered = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        rendered += chunk.toString();
        callback();
      },
    });

    setTimeout(() => input.end("correct-horse-battery-staple\n"), 0);
    const answer = await readHiddenLine({
      input,
      output,
      message: "Secret value:",
    });

    expect(answer).toBe("correct-horse-battery-staple");
    expect(rendered).toContain("Secret value:");
    expect(rendered).not.toContain("correct-horse-battery-staple");
  });
});
