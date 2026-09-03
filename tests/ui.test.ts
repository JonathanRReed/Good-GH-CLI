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

  /**
   * Without a TTY these must cancel, never auto-answer. The first option of a menu
   * can be destructive (`ggh resolve` offers "accept ours" first) and a default-yes
   * confirm can publish a release or open a Pull Request.
   */
  describe("non-interactive prompts", () => {
    it("cancels searchablePicker instead of taking the first item", async () => {
      const result = await searchablePicker({
        title: "Test Picker",
        items: [
          { value: "item1", label: "Item 1" },
          { value: "item2", label: "Item 2" },
        ],
      });
      expect(result).toBeNull();
    });

    it("cancels selectMenu instead of taking the first option or the initialValue", async () => {
      const options = [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ];
      expect(await selectMenu({ message: "Select an item", options })).toBeNull();
      expect(
        await selectMenu({ message: "Select an item", options, initialValue: "beta" }),
      ).toBeNull();
    });

    it("cancels multiSelectMenu instead of returning a silently empty selection", async () => {
      const options = [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ];
      expect(await multiSelectMenu({ message: "Select items", options })).toBeNull();
      expect(
        await multiSelectMenu({ message: "Select items", options, initialValues: ["two"] }),
      ).toBeNull();
    });

    it("refuses confirmPrompt regardless of initialValue", async () => {
      expect(await confirmPrompt({ message: "Are you sure?" })).toBe(false);
      // initialValue is a UI preselection, never a non-interactive answer.
      expect(await confirmPrompt({ message: "Are you sure?", initialValue: true })).toBe(false);
    });

    it("confirms only when an explicit --yes flag is passed through", async () => {
      expect(
        await confirmPrompt({ message: "Publish?", initialValue: false, assumeYes: true }),
      ).toBe(true);
    });

    it("marks the process as failed when it cannot prompt", async () => {
      process.exitCode = 0;
      await confirmPrompt({ message: "Are you sure?", initialValue: true });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });
  });
});
