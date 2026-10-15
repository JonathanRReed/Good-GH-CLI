import { run } from "../utils/exec.ts";

export const MIN_GIT_VERSION = "2.31.0";
export const GIT_UPGRADE_URL = "https://git-scm.com/downloads";

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function parseGitVersion(output: string): [number, number, number] | undefined {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?=$|[.\s-])/m.exec(output.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch].every(Number.isSafeInteger) ? [major, minor, patch] : undefined;
}

export function isSupportedGitVersion(output: string): boolean {
  const version = parseGitVersion(output);
  return version !== undefined && (version[0] > 2 || version[0] === 2 && version[1] >= 31);
}

let gitSupport: Promise<void> | undefined;

export function assertSupportedGit(): Promise<void> {
  gitSupport ??= (async () => {
    let output: string;
    try {
      output = (await run("git", ["--version"], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 })).stdout.trim();
    } catch {
      throw new CapabilityError(`Git ${MIN_GIT_VERSION} or newer is required. Could not run git --version. Install or repair Git: ${GIT_UPGRADE_URL}`);
    }
    if (!isSupportedGitVersion(output)) {
      throw new CapabilityError(`Git ${MIN_GIT_VERSION} or newer is required for managed workflows. Found ${parseGitVersion(output) ? output : "an unrecognized Git version"}. Upgrade Git: ${GIT_UPGRADE_URL}`);
    }
  })();
  return gitSupport;
}
