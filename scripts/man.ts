#!/usr/bin/env bun
/**
 * Generates man/ggh.1 from the real command tree, the same way completions
 * are generated: a hand-written man page drifts the week after it is written.
 *
 *   bun run man          # regenerate man/ggh.1
 *   bun run man --check  # fail if man/ggh.1 is stale (used by CI)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { createProgram, HELP_GROUPS } from "../src/index.ts";
import packageJson from "../package.json";

const root = join(import.meta.dir, "..");
const outPath = join(root, "man", "ggh.1");

/** Escape for troff source: backslashes, plus a \& guard for lines starting with ' or . */
function esc(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .split("\n")
    .map((line) => (/^[.']/.test(line) ? `\\&${line}` : line))
    .join("\n");
}

function commandBlock(c: Command): string {
  const names = [c.name(), ...c.aliases()].join(", ");
  let out = `.TP\n\\fB${esc(names)}\\fR\n${esc(c.description().split("\n")[0] ?? "")}\n`;
  const subs = c.commands.filter((s) => s.name() !== "help");
  for (const s of subs) {
    const subNames = [s.name(), ...s.aliases()].join(", ");
    out += `.RS\n.TP\n\\fB${esc(subNames)}\\fR\n${esc(s.description().split("\n")[0] ?? "")}\n.RE\n`;
  }
  return out;
}

async function generate(): Promise<string> {
  const program = await createProgram();
  const commands = program.commands.filter((c) => c.name() !== "help");
  const groups = new Map<string, typeof commands>();
  const order: string[] = [];
  for (const c of commands) {
    const group = HELP_GROUPS[c.name()] ?? "Other commands";
    if (!groups.has(group)) {
      groups.set(group, []);
      order.push(group);
    }
    groups.get(group)!.push(c);
  }

  const L: string[] = [];
  L.push(`.TH ggh 1 "" "ggh ${packageJson.version}"`);
  L.push(`.SH NAME`);
  L.push(`ggh \\- Git and GitHub in one CLI`);
  L.push(`.SH SYNOPSIS`);
  L.push(`.B ggh`);
  L.push(`[\\fIoptions\\fR] \\fIcommand\\fR [\\fIargs\\fR...]`);
  L.push(`.SH DESCRIPTION`);
  L.push(
    `${esc(program.description())}. Anything \\fBggh\\fR does not recognise goes straight to \\fBgit\\fR, so \\fBggh add .\\fR, \\fBggh push\\fR, and \\fBggh rebase \\-i\\fR behave exactly as \\fBgit\\fR does.`,
  );
  L.push(`.SH COMMANDS`);
  for (const group of order) {
    L.push(`.SS "${esc(group)}"`);
    for (const c of groups.get(group)!) {
      L.push(commandBlock(c).trimEnd());
    }
  }
  L.push(`.SH GLOBAL OPTIONS`);
  L.push(`Every command follows the same rules.`);
  L.push(`.TP`);
  L.push(`\\fB--json\\fR`);
  L.push(`Machine-readable output on stdout, nothing else.`);
  L.push(`.TP`);
  L.push(`\\fB--dry\\-run\\fR`);
  L.push(`Describe what would happen; change nothing.`);
  L.push(`.TP`);
  L.push(`\\fB\\-y\\fR, \\fB--yes\\fR`);
  L.push(`Answer every confirmation with yes.`);
  L.push(`.TP`);
  L.push(`\\fB\\-q\\fR, \\fB--quiet\\fR`);
  L.push(`Suppress progress; errors still print.`);
  L.push(`.TP`);
  L.push(`\\fB--no\\-input\\fR`);
  L.push(`Never prompt; fail with instructions instead.`);
  L.push(`.TP`);
  L.push(`\\fB\\-R\\fR, \\fB--repo\\fR \\fIowner/name\\fR`);
  L.push(`Act on another repository from anywhere (GitHub commands).`);
  L.push(`.RS`);
  L.push(`.PP`);
  L.push(`stdout is data. stderr is everything else. When \\fBggh\\fR needs an answer and there is no terminal, it cancels and exits non-zero rather than guessing.`);
  L.push(`.RE`);
  L.push(`.SH ENVIRONMENT`);
  L.push(`.TP`);
  L.push(`\\fBGH_HOST\\fR`);
  L.push(`Target a GitHub Enterprise host instead of github.com.`);
  L.push(`.TP`);
  L.push(`\\fBGGH_*\\fR`);
  L.push(`Per-key overrides (\\fBGGH_AI_PROVIDER\\fR, \\fBGGH_CODEX_MODEL\\fR, \\fBGGH_AI_TIMEOUT_MS\\fR, ...). Flags beat environment, environment beats config files.`);
  L.push(`.TP`);
  L.push(`\\fBXDG_CONFIG_HOME\\fR, \\fBXDG_CACHE_HOME\\fR`);
  L.push(`Respected for config, plugins, aliases, and cache.`);
  L.push(`.TP`);
  L.push(`\\fBGGH_DEBUG\\fR`);
  L.push(`Print git-forwarding and alias-expansion decisions to stderr.`);
  L.push(`.SH FILES`);
  L.push(`.TP`);
  L.push(`\\fI~/.config/ggh/config.json\\fR`);
  L.push(`User configuration (see \\fBggh config\\fR).`);
  L.push(`.TP`);
  L.push(`\\fI~/.config/ggh/aliases.json\\fR, \\fI~/.config/ggh/plugins/\\fR`);
  L.push(`Aliases and community plugins. Plugins run with full process privileges; install only from sources you trust.`);
  L.push(`.TP`);
  L.push(`\\fI.ggh.json\\fR (repository root)`);
  L.push(`Per-project configuration, safe to commit.`);
  L.push(`.SH EXAMPLES`);
  L.push(`.TP`);
  L.push(`Inspect a pull request as data:`);
  L.push(esc(`ggh pr --json | jq -r '.[] | "\\(.number) \\(.title)"'`));
  L.push(`.TP`);
  L.push(`Commit with an AI message, then open a PR:`);
  L.push(`ggh commit --push --pr`);
  L.push(`.TP`);
  L.push(`Preview anything destructive first:`);
  L.push(`ggh discard --all --dry\\-run`);
  L.push(`.SH EXIT STATUS`);
  L.push(`Zero on success, non-zero on failure. \\fBggh\\fR is usable as a gate in scripts and CI: failures set the exit code, and \\fB--json\\fR output stays parseable.`);
  L.push(`.SH "SEE ALSO"`);
  L.push(`\\fBgit\\fR(1), \\fBgh\\fR(1)`);
  L.push(`Full guide and configuration reference: the README shipped with the source.`);
  return L.join("\n") + "\n";
}

const check = process.argv.includes("--check");
const text = await generate();
if (check) {
  const { readFileSync } = await import("node:fs");
  let current = "";
  try {
    current = readFileSync(outPath, "utf-8");
  } catch {
    // missing counts as stale
  }
  if (current !== text) {
    console.error("man/ggh.1 is stale. Regenerate with `bun run man`.");
    process.exit(1);
  }
  console.error("man/ggh.1 is fresh.");
} else {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "man"), { recursive: true });
  writeFileSync(outPath, text);
  console.error(`wrote ${outPath}`);
}
