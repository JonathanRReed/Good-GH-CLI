import { expect, test } from "bun:test";
import { responseValidators } from "../src/services/github/response.ts";

test("CI and review parsing preserve their existing malformed-response diagnostics", () => {
  const ci = responseValidators({ label: "GitHub" });
  const review = responseValidators({ label: "review thread", source: " from GitHub", object: "response" });
  expect(() => ci.object([])).toThrow("Invalid GitHub object.");
  expect(() => ci.string(null)).toThrow("Invalid GitHub string.");
  expect(() => ci.array({})).toThrow("Invalid GitHub array.");
  expect(() => review.object([])).toThrow("Invalid review thread response from GitHub.");
  expect(() => review.string(null)).toThrow("Invalid review thread string from GitHub.");
  expect(() => review.boolean(1)).toThrow("Invalid review thread boolean from GitHub.");
});

test("CI IDs stay non-negative while review coordinates accept null or signed safe integers", () => {
  const ci = responseValidators({ label: "GitHub" });
  const review = responseValidators({ label: "review thread", source: " from GitHub" });
  expect(ci.integer(0)).toBe(0);
  expect(review.nullableNumber(null)).toBeNull();
  expect(review.nullableNumber(-1)).toBe(-1);
  for (const value of [-1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => ci.integer(value)).toThrow("Invalid GitHub integer.");
  }
  for (const value of [1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => review.nullableNumber(value)).toThrow("Invalid review thread number from GitHub.");
  }
});
