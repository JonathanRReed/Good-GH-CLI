import type { Command } from "commander";
import { data, fail, header, p, pc } from "../utils/ui.ts";

interface CommandSpec {
  name: string;
  aliases: string[];
  description: string;
  options: string[];
  subcommands: Array<{ name: string; aliases: string[]; description: string }>;
}

/**
 * Reads the real command tree. Completions were three hand-written scripts that
 * drifted every time a command was added; generating them means they cannot.
 */
function describeProgram(program: Command): CommandSpec[] {
  return program.commands
    .filter((c) => c.name() !== "help")
    .map((c) => ({
      name: c.name(),
      aliases: c.aliases(),
      description: (c.description() || "").split("\n")[0],
      options: c.options
        .filter((o) => !o.hidden)
        .flatMap((o) => [o.short, o.long].filter((f): f is string => Boolean(f))),
      subcommands: c.commands
        .filter((s) => s.name() !== "help")
        .map((s) => ({
          name: s.name(),
          aliases: s.aliases(),
          description: (s.description() || "").split("\n")[0],
        })),
    }));
}

/** zsh and bash both break on an unescaped quote inside a description. */
function esc(text: string): string {
  return text.replace(/'/g, "").replace(/\\/g, "");
}

function generateZsh(specs: CommandSpec[]): string {
  const entries = specs
    .flatMap((c) => [
      `    '${c.name}:${esc(c.description)}'`,
      ...c.aliases.map((a) => `    '${a}:Alias for ${c.name}'`),
    ])
    .join("\n");

  const cases = specs
    .filter((c) => c.subcommands.length > 0 || c.options.length > 0)
    .map((c) => {
      const names = [c.name, ...c.aliases].join("|");
      const subs = c.subcommands
        .flatMap((s) => [s.name, ...s.aliases])
        .join(" ");
      const opts = c.options.map((o) => `'${o}'`).join(" ");
      const lines = [`      ${names})`];
      if (subs) lines.push(`        _values 'subcommand' ${subs}`);
      if (opts) lines.push(`        _values 'option' ${opts}`);
      lines.push("        ;;");
      return lines.join("\n");
    })
    .join("\n");

  return `#compdef ggh good-gh

_ggh() {
  local -a commands
  commands=(
${entries}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'ggh command' commands
  else
    case $words[2] in
${cases}
    esac
  fi
}

_ggh
`;
}

function generateBash(specs: CommandSpec[]): string {
  const names = specs.flatMap((c) => [c.name, ...c.aliases]).join(" ");
  const cases = specs
    .filter((c) => c.subcommands.length > 0 || c.options.length > 0)
    .map((c) => {
      const match = [c.name, ...c.aliases].join("|");
      const words = [
        ...c.subcommands.flatMap((s) => [s.name, ...s.aliases]),
        ...c.options,
      ].join(" ");
      return `    ${match})\n      COMPREPLY=( $(compgen -W "${words}" -- "$cur") )\n      return 0\n      ;;`;
    })
    .join("\n");

  return `_ggh_completions() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[1]}"
  commands="${names}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "$prev" in
${cases}
  esac
}

complete -F _ggh_completions ggh good-gh
`;
}

function generateFish(specs: CommandSpec[]): string {
  const lines: string[] = [
    "function __fish_ggh_branches",
    "  git branch --format='%(refname:short)' 2>/dev/null",
    "end",
    "",
  ];

  for (const c of specs) {
    lines.push(
      `complete -c ggh -f -n '__fish_use_subcommand' -a '${c.name}' -d '${esc(c.description)}'`,
    );
    for (const alias of c.aliases) {
      lines.push(
        `complete -c ggh -f -n '__fish_use_subcommand' -a '${alias}' -d 'Alias for ${c.name}'`,
      );
    }
  }

  lines.push("");
  for (const c of specs) {
    const seen = [c.name, ...c.aliases].join(" ");
    for (const sub of c.subcommands) {
      lines.push(
        `complete -c ggh -f -n '__fish_seen_subcommand_from ${seen}' -a '${sub.name}' -d '${esc(sub.description)}'`,
      );
    }
  }

  lines.push(
    "",
    "complete -c ggh -n '__fish_seen_subcommand_from switch sw checkout' -a '(__fish_ggh_branches)'",
  );
  return lines.join("\n") + "\n";
}

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion [shell]")
    .description("Generate a shell tab-completion script for zsh, bash, or fish")
    .action((shell?: string) => {
      const specs = describeProgram(program);
      const target = (shell || process.env.SHELL?.split("/").pop() || "zsh").toLowerCase();

      if (target.includes("zsh")) {
        data(generateZsh(specs));
      } else if (target.includes("bash")) {
        data(generateBash(specs));
      } else if (target.includes("fish")) {
        data(generateFish(specs));
      } else {
        header("Shell Completion");
        fail(`Unsupported shell: ${target}. Supported shells: zsh, bash, fish.`);
        p.log.message(`\nExample:\n  ${pc.cyan('eval "$(ggh completion zsh)"')}\n`);
      }
    });
}
