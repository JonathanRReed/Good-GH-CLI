import { join } from "node:path";
import { fixtureDirectory, recorded, type ReplayResponse } from "./replay.ts";

const head = "0b4979114fa2e9c00bb30285ceab79f171209913";
const stackApi = ["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10", "repos/JonathanRReed/Good-GH-CLI/stacks?pull_request=17"];

/** Good-GH-CLI PR #17, captured on 29 October 2026. Native and ggh read the same recorded responses. */
export const briefCase = {
  question: "Where am I: branch, HEAD, drift, cleanliness, branch PR, CI, unresolved threads, linked issues and stack?",
  nativeCommands: [
    "git status --porcelain=v2 --branch",
    "gh pr view --json number,url,state,isDraft,headRefOid,baseRefName,reviewDecision,mergeable,closingIssuesReferences",
    "gh pr checks 17 --json name,bucket",
    "gh api graphql -f query='query{repository(owner:\"JonathanRReed\",name:\"Good-GH-CLI\"){pullRequest(number:17){reviewThreads(first:100){nodes{isResolved}}}}}'",
    "gh api -H 'X-GitHub-Api-Version: 2026-03-10' 'repos/JonathanRReed/Good-GH-CLI/stacks?pull_request=17'",
  ],
  nativeFixtures: ["porcelain", "pr-json", "checks-json", "threads-native", "stacks"].map(name => `good-gh-brief-${name}`),
  command: ["agent", "brief", "--agent"],
  expected: [
    { label: "branch", pattern: "feat/universe-2026" },
    { label: "full HEAD", pattern: head },
    { label: "tracking branch", pattern: "origin/feat/universe-2026" },
    { label: "zero drift, clean checkout", pattern: '# branch\\.ab \\+0 -0\\n\\{|"ahead":0,"behind":0,(?:"[A-Za-z]+":(?:\\d+|null),)*"staged":0,"unstaged":0,"untracked":0,"conflicts":0' },
    { label: "PR number and state", pattern: '"number":17,[^}]*"(?:prState|state)":"OPEN"' },
    { label: "PR head SHA", pattern: `"headRefOid":"${head}"|"headSha":"${head}"` },
    { label: "mergeable", pattern: '"mergeable":"MERGEABLE"' },
    { label: "pending check", pattern: '"bucket":"pending"|"pending":1' },
    { label: "no failing check", pattern: '"failing":\\[\\]|(?<![\\s\\S])(?![\\s\\S]*"bucket":"(?:fail|cancel)")(?=[\\s\\S]*"bucket":"pass")' },
    { label: "two unresolved threads", pattern: '"nodes":\\[\\{"isResolved":false\\},\\{"isResolved":false\\}\\]|"unresolved":2' },
    { label: "no linked issues", pattern: '"closingIssuesReferences":\\[\\]|"linkedIssues":\\{"state":"available","items":\\[\\]\\}' },
    { label: "not stacked", pattern: '\\[\\]$|"stack":\\{"state":"none"\\}' },
  ],
};

export function briefResponses(): ReplayResponse[] {
  return [
    { command: "git", prefix: ["rev-parse", "--show-toplevel"], stdout: fixtureDirectory + "\n" },
    { command: "git", prefix: ["status", "--porcelain=v2", "--branch", "-z", "-uall"], fixture: "good-gh-brief-porcelain-z" },
    { command: "git", prefix: ["rev-parse", "--absolute-git-dir"], stdout: join(fixtureDirectory, ".recorded-git") + "\n" },
    // The captured HEAD was pushed, so no commit is missing from the remote-tracking refs.
    { command: "git", prefix: ["rev-list", "--count", "--max-count=1000", "HEAD", "--not", "--remotes"], stdout: "0\n" },
    { command: "git", prefix: ["remote"], stdout: "origin\n" },
    { command: "git", prefix: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], stdout: "refs/remotes/origin/main\n" },
    // PR #17's captured head was one commit ahead of main (95fe6b3).
    { command: "git", prefix: ["rev-list", "--count", "--max-count=1000", "refs/remotes/origin/main..HEAD"], stdout: "1\n" },
    { command: "git", prefix: ["rev-parse", "--path-format=absolute", "--git-common-dir"], stdout: join(fixtureDirectory, ".recorded-git") + "\n" },
    { command: "gh", prefix: ["pr", "view", "--json"], fixture: "good-gh-brief-pr-json" },
    { command: "gh", prefix: ["pr", "checks", "17", "--json", "name,bucket"], fixture: "good-gh-brief-checks-json" },
    { command: "gh", prefix: ["repo", "view", "--json", "nameWithOwner,url"], fixture: "good-gh-brief-repo-view" },
    { command: "gh", prefix: ["api", "graphql"], fixture: "good-gh-brief-threads-full" },
    { command: "gh", prefix: stackApi, fixture: "good-gh-brief-stacks" },
  ];
}

export function briefNativeOutput(): string {
  return briefCase.nativeFixtures.map(recorded).join("");
}
