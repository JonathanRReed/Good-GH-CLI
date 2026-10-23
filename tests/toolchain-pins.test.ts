import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bunVersion = "1.4.4";
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
};

describe("Bun toolchain pins", () => {
  test("pins the development runtime to the qualified Bun version", () => {
    const path = join(root, ".bun-version");
    expect(existsSync(path) ? readFileSync(path, "utf8").trim() : "").toBe(bunVersion);
  });

  test("uses the development Bun version in every CI and release setup step", () => {
    const directory = join(root, ".github", "workflows");
    let checked = 0;
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = Bun.YAML.parse(readFileSync(join(directory, file), "utf8")) as Workflow;
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue;
          const requested = step.with?.["bun-version"];
          const resolved = requested === "${{ env.BUN_VERSION }}" ? workflow.env?.BUN_VERSION : requested;
          expect({ file, resolved }).toEqual({ file, resolved: bunVersion });
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
