import { recordCommandIssue } from "../services/runtime.ts";
/** Parses a positive safe whole number used as a GitHub issue or PR identity. */
export function parsePositiveSafeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    recordCommandIssue({ status: "failed", code: "invalid_arguments", message: "Expected a positive safe whole number." });
    return null;
  }
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  recordCommandIssue({ status: "failed", code: "invalid_arguments", message: "Expected a positive safe whole number." });
  return null;
}
