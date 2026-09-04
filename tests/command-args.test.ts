import { describe, expect, it } from "bun:test";
import { parseCommandArguments, quoteShellArgument } from "../src/utils/command-args.ts";

describe("literal generated-hook arguments", () => {
  it("keeps quoted whitespace and empty arguments", () => {
    expect(parseCommandArguments('git commit -m "two words" \'\'')).toEqual(["git", "commit", "-m", "two words", ""]);
  });
  it("keeps Windows path separators inside double quotes", () => {
    expect(parseCommandArguments(String.raw`git -C "C:\work\project" status`)).toEqual(["git", "-C", "C:\\work\\project", "status"]);
  });
  it("treats substitutions and metacharacters as literal argument text", () => {
    expect(parseCommandArguments('git show "$HOME;$(whoami)"')).toEqual(["git", "show", "$HOME;$(whoami)"]);
    expect(quoteShellArgument("it's $HOME;`whoami`")).toBe("'it'\"'\"'s $HOME;`whoami`'");
  });
  for (const bad of ["", "git 'unfinished", "git \\", "git\nstatus", "git\0status"]) {
    it(`rejects malformed command ${JSON.stringify(bad)}`, () => expect(() => parseCommandArguments(bad)).toThrow());
  }
});
