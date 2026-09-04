#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

/** Extract the requested release section, then a nonempty Unreleased section. */
function selectReleaseNotes(changelog, version) {
  if (typeof changelog !== "string" || typeof version !== "string" || !version.trim()) {
    throw new Error("Changelog text and release version are required.");
  }
  const sections = new Map();
  let section;
  for (const line of changelog.split(/\r?\n/)) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      section = heading[1].split(/\s/)[0].replace(/^\[|\]$/g, "").replace(/^v/, "");
      if (!sections.has(section)) sections.set(section, []);
    } else if (section) {
      sections.get(section).push(line);
    }
  }
  for (const key of [version.trim().replace(/^v/, ""), "Unreleased"]) {
    const notes = (sections.get(key) || []).join("\n").trim();
    if (notes) return notes + "\n";
  }
  throw new Error(`No release notes for ${version} or Unreleased; refusing to publish empty notes.`);
}

module.exports = { selectReleaseNotes };
if (require.main === module) {
  try {
    const [file, version] = process.argv.slice(2);
    if (!file || !version) throw new Error("Usage: node scripts/release-notes.cjs CHANGELOG.md VERSION");
    process.stdout.write(selectReleaseNotes(fs.readFileSync(file, "utf8"), version));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
