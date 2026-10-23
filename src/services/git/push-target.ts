import { run } from "../../utils/exec.ts";

/** Read only branch routing keys, never credential or URL configuration. */
export async function branchSettings(cwd: string): Promise<Map<string, string>> {
  const result = await run("git", ["config", "--null", "--get-regexp", "^(branch\\..*\\.(remote|merge|push[Rr]emote|gh-merge-base)|remote\\.push[Dd]efault|push\\.default)$"], { cwd, reject: false });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr || "Cannot read Git branch routing.");
  return new Map(result.stdout.split("\0").filter(Boolean).map(record => {
    const separator = record.indexOf("\n");
    return [record.slice(0, separator), record.slice(separator + 1)];
  }));
}

export function pushTarget(branch: string, remotes: string[], settings: Map<string, string>, explicit: { remote?: string; branch?: string; setUpstream?: boolean } = {}) {
  const remote = explicit.remote || settings.get(`branch.${branch}.pushremote`) || settings.get("remote.pushdefault") || settings.get(`branch.${branch}.remote`) || (remotes.includes("origin") ? "origin" : remotes[0]);
  const upstream = settings.get(`branch.${branch}.merge`);
  // Preserve intentional `push.default=upstream` mapping for unqualified pushes.
  // Explicit branch selection always publishes that branch's own name.
  const destination = !explicit.remote && !explicit.branch && !explicit.setUpstream && settings.get("push.default") === "upstream" && remote === settings.get(`branch.${branch}.remote`) && upstream?.startsWith("refs/heads/") ? upstream.slice(11) : branch;
  return remote ? { remote, branch: destination } : null;
}
