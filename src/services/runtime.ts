/**
 * Process-wide flags that cut across every command. Commander writes them here
 * once, before the action runs, so deep helpers (output, prompts, the gh service)
 * can honour them without threading options through every signature.
 */
export interface RuntimeFlags {
  /** Emit machine-readable JSON on stdout and suppress all chrome. */
  json: boolean;
  /** Explicit --no-ai or a supplied commit message denies provider invocation. */
  aiDisabled: boolean;
  /** Suppress chrome, but not errors. */
  quiet: boolean;
  /** Never prompt; fail with instructions instead. */
  noInput: boolean;
  /** Describe what would happen without changing anything. */
  dryRun: boolean;
  /** Operate on `owner/name` instead of the repository in the working directory. */
  repo?: string;
}

const defaults: RuntimeFlags = {
  json: false,
  aiDisabled: false,
  quiet: false,
  noInput: false,
  dryRun: false,
  repo: undefined,
};

let flags: RuntimeFlags = { ...defaults };

export function getFlags(): RuntimeFlags {
  return flags;
}

export function setFlags(partial: Partial<RuntimeFlags>): void {
  flags = { ...flags, ...partial };
}

export function resetFlags(): void {
  flags = { ...defaults };
}

/**
 * True when the process must not prompt: an explicit --no-input, a --json run
 * whose stdout is being parsed, or simply no terminal attached.
 */
export function isNonInteractive(): boolean {
  return flags.noInput || flags.json || !process.stdin.isTTY;
}
