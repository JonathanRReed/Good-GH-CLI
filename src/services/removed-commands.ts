/** Migration hints only. Removed commands never load their former implementation. */
const movedToGh = new Map([
  ["label", "label"], ["labels", "label"],
  ["secret", "secret"], ["secrets", "secret"],
  ["variable", "variable"], ["variables", "variable"],
  ["gist", "gist"], ["gists", "gist"],
  ["search", "search"], ["browse", "browse"],
  ["workflow", "workflow"], ["workflows", "workflow"],
  ["release", "release"], ["rel", "release"],
  ["changelog", "api --method POST repos/{owner}/{repo}/releases/generate-notes -f tag_name=<tag>"],
  ["team", "gist list"], ["triage", "issue list"],
]);

export function removedCommandMessage(name: string): string | undefined {
  if (name === "draft") return "ggh draft removed in 0.6; use `ggh stash list --named` or `ggh stash restore <name>`. GitHub CLI has no local stash equivalent.";
  const equivalent = movedToGh.get(name);
  if (!equivalent) return undefined;
  const detail = name === "team" ? " Stack snapshot sharing is retired."
    : name === "triage" ? " AI grouping is retired; use `ggh notifications` for the inbox."
      : name === "changelog" ? " This generates release notes; maintain CHANGELOG.md by hand."
        : name === "secret" || name === "secrets" ? " Use the masked `ggh gh secret set NAME` prompt or pipe the value on stdin."
          : "";
  return `ggh ${name} removed in 0.6; use \`ggh gh ${equivalent}\`.${detail}`;
}
