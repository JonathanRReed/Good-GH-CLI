function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse GitHub response fields while retaining each domain's diagnostics. */
export function responseValidators(options: { label: string; source?: string; object?: string }) {
  const invalid = (kind: string) => new Error(`Invalid ${options.label} ${kind}${options.source ?? ""}.`);
  return {
    object(value: unknown): Record<string, unknown> {
      if (!isObject(value)) throw invalid(options.object ?? "object");
      return value;
    },
    array(value: unknown): unknown[] {
      if (!Array.isArray(value)) throw invalid("array");
      return value;
    },
    string(value: unknown): string {
      if (typeof value !== "string") throw invalid("string");
      return value;
    },
    boolean(value: unknown): boolean {
      if (typeof value !== "boolean") throw invalid("boolean");
      return value;
    },
    integer(value: unknown): number {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid("integer");
      return value;
    },
    nullableNumber(value: unknown): number | null {
      if (value === null) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid("number");
      return value;
    },
  };
}
