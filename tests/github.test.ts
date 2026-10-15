import { describe, expect, it } from "bun:test";
import { normalizeCloneUrl, trimRepositorySuffix, parseRepoFlag } from "../src/services/github.ts";

describe("github service", () => {
  it("normalizes owner/repo shorthand to HTTPS and SSH URLs", () => {
    expect(normalizeCloneUrl("facebook/react", "https")).toBe("https://github.com/facebook/react.git");
    expect(normalizeCloneUrl("facebook/react", "ssh")).toBe("git@github.com:facebook/react.git");
  });

  it("leaves full git and https URLs untouched", () => {
    const httpsUrl = "https://github.com/pingdotgg/t3code.git";
    const sshUrl = "git@github.com:pingdotgg/t3code.git";
    expect(normalizeCloneUrl(httpsUrl)).toBe(httpsUrl);
    expect(normalizeCloneUrl(sshUrl)).toBe(sshUrl);
  });

  it("parses owner/repo from various git remote URL shapes (T3 Code pattern)", async () => {
    const { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } = await import("../src/services/github.ts");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:pingdotgg/t3code.git")).toBe("pingdotgg/t3code");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/facebook/react.git")).toBe("facebook/react");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://git@github.com/vercel/next.js.git")).toBe("vercel/next.js");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://git@github.com:22/vercel/next.js.git")).toBe("vercel/next.js");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("http://github.com/facebook/react.git")).toBe("facebook/react");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git://github.com/torvalds/linux")).toBe("torvalds/linux");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/torvalds/linux")).toBe("torvalds/linux");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("invalid-url")).toBe(null);
  });

  it("handles edge cases in normalizeCloneUrl (trailing slash, existing .git, empty)", () => {
    expect(normalizeCloneUrl("facebook/react/", "https")).toBe("https://github.com/facebook/react.git");
    expect(normalizeCloneUrl("facebook/react.git", "https")).toBe("https://github.com/facebook/react.git");
    expect(normalizeCloneUrl("  facebook/react.git  ", "ssh")).toBe("git@github.com:facebook/react.git");
    expect(normalizeCloneUrl("facebook/react/", "ssh")).toBe("git@github.com:facebook/react.git");
    expect(normalizeCloneUrl("")).toBe("");
    expect(normalizeCloneUrl("   ")).toBe("");
  });

  it("trims repository suffixes in one pass for long untrusted input", () => {
    const prefix = `owner/${"repo".repeat(10_000)}`;
    expect(trimRepositorySuffix(`${prefix}.git${"/".repeat(10_000)}`)).toBe(prefix);
    expect(parseRepoFlag(`github.com/owner/repo.git${"/".repeat(100_000)}`)?.nameWithOwner).toBe("owner/repo");
    expect(() => parseRepoFlag(`owner/${"/".repeat(30_000)}x`)).toThrow();
  });

  it("returns no repository matches for an empty or whitespace query", async () => {
    const { searchRepositories } = await import("../src/services/github.ts");
    expect(await searchRepositories("")).toEqual([]);
    expect(await searchRepositories("   ")).toEqual([]);
  });
});
