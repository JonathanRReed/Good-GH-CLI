#!/usr/bin/env bun
/**
 * Cuts a release: verify, bump, changelog, commit and local tag. The tag is what actually
 * triggers publishing, so everything before the push is reversible.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function run(command: string, args: string[]): string {
  const proc = Bun.spawnSync([command, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${proc.stderr.toString() || stdout}`);
  }
  return stdout.trim();
}

function fail(message: string): never {
  console.error(`\x1b[31m✖\x1b[0m  ${message}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail("Usage: bun run release <version>   (e.g. 0.2.0)");
}

if (run("git", ["status", "--porcelain"]).length > 0) {
  fail("Working tree is dirty. Commit or stash first.");
}

const branch = run("git", ["branch", "--show-current"]);
if (branch !== "main") {
  fail(`Releases are cut from main, not ${branch}.`);
}

const existingTags = run("git", ["tag", "-l", `v${version}`]);
if (existingTags) fail(`Tag v${version} already exists.`);

console.error(`Verifying before releasing v${version}...`);
for (const script of ["typecheck", "lint"]) {
  run("bun", ["run", script]);
}
run("bun", ["test", "--timeout", "30000"]);
run("bun", ["run", "build"]);
console.error("  checks passed");

// Bump package.json without reformatting the rest of the file.
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
console.error(`  package.json ${previous} -> ${version}`);

// Promote the Unreleased section, or write a fresh entry with ggh itself.
const changelogPath = join(root, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const current = readFileSync(changelogPath, "utf-8");
  const today = new Date().toISOString().slice(0, 10);
  if (current.includes("## Unreleased")) {
    writeFileSync(changelogPath, current.replace("## Unreleased", `## ${version} — ${today}`), "utf-8");
    console.error("  CHANGELOG.md: Unreleased -> " + version);
  } else {
    console.error("  CHANGELOG.md has no Unreleased section; add the entry by hand or run `ggh changelog`.");
  }
}

// Generated version-bearing artifacts must be updated before the tag is cut.
run("bun", ["run", "man"]);
run("bun", ["run", "man", "--check"]);
run("bun", ["run", "build"]);
run("git", ["add", "package.json", "CHANGELOG.md", "man/ggh.1"]);
run("git", ["commit", "-m", `chore(release): v${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);

console.error(`\nCommitted and tagged v${version}. Nothing is published yet.`);
console.error("Push when you are ready:\n");
console.error(`  git push origin main --follow-tags\n`);
