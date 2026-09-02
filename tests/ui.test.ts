import { describe, expect, it } from "bun:test";
import { searchablePicker, formatError, formatSuccess, formatInfo, formatWarning } from "../src/utils/ui.ts";

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
});
