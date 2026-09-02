import { describe, expect, it } from "bun:test";
import {
  searchablePicker,
  selectMenu,
  multiSelectMenu,
  confirmPrompt,
  formatError,
  formatSuccess,
  formatInfo,
  formatWarning,
} from "../src/utils/ui.ts";

describe("ui utilities", () => {
  it("formats messages with icons", () => {
    expect(formatError("bad")).toContain("bad");
    expect(formatSuccess("good")).toContain("good");
    expect(formatInfo("info")).toContain("info");
    expect(formatWarning("warn")).toContain("warn");
  });

  it("handles non-interactive fallback for searchablePicker", async () => {
    const result = await searchablePicker({
      title: "Test Picker",
      items: [
        { value: "item1", label: "Item 1" },
        { value: "item2", label: "Item 2" },
      ],
    });

    expect(result).toBe("item1");
  });

  it("handles non-interactive fallback for selectMenu", async () => {
    const defaultResult = await selectMenu({
      message: "Select an item",
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
    });
    expect(defaultResult).toBe("alpha");

    const initialResult = await selectMenu({
      message: "Select with initialValue",
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      initialValue: "beta",
    });
    expect(initialResult).toBe("beta");
  });

  it("handles non-interactive fallback for multiSelectMenu", async () => {
    const emptyResult = await multiSelectMenu({
      message: "Select items",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
    });
    expect(emptyResult).toEqual([]);

    const initialResult = await multiSelectMenu({
      message: "Select items with initialValues",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      initialValues: ["two"],
    });
    expect(initialResult).toEqual(["two"]);
  });

  it("handles non-interactive fallback for confirmPrompt", async () => {
    const defaultResult = await confirmPrompt({
      message: "Are you sure?",
    });
    expect(defaultResult).toBe(false);

    const trueResult = await confirmPrompt({
      message: "Are you sure?",
      initialValue: true,
    });
    expect(trueResult).toBe(true);
  });
});
