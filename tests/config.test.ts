import { describe, expect, it } from "bun:test";
import { getConfig, saveConfig, getConfigPath } from "../src/services/config.ts";

describe("config service", () => {
  it("provides config path in .config/good-gh", () => {
    const path = getConfigPath();
    expect(path).toContain(".config/good-gh/config.json");
  });

  it("reads and updates configuration values", () => {
    const initial = getConfig();
    expect(initial).toBeDefined();

    saveConfig({ codex_model: "gpt-5.6-luna-test" });
    const updated = getConfig();
    expect(updated.codex_model).toBe("gpt-5.6-luna-test");

    // Restore default
    saveConfig({ codex_model: "gpt-5.6-luna" });
    expect(getConfig().codex_model).toBe("gpt-5.6-luna");
  });
});
