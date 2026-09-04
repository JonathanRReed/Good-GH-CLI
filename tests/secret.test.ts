import { describe, expect, it } from "bun:test";
import { buildSecretSetRequest } from "../src/commands/secret.ts";

describe("secret transport", () => {
  it("sends the value through stdin instead of process arguments", () => {
    const request = buildSecretSetRequest("DEPLOY_TOKEN", "super-secret-value");

    expect(request).toEqual({
      args: ["secret", "set", "DEPLOY_TOKEN"],
      input: "super-secret-value",
    });
    expect(request.args).not.toContain("super-secret-value");
  });
});
