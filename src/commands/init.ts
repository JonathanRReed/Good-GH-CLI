import type { Command } from "commander";
import { data, fail } from "../utils/ui.ts";

export function shellInit(shell: string, name = "g"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ["ggh", "good_gh"].includes(name)) throw new Error("Shell command name must be an identifier other than ggh.");
  switch (shell) {
    case "bash":
    case "zsh": return `${name}() {
  local destination
  destination=$(command ggh go --print --shell -- "$@") || return $?
  [ -n "$destination" ] || return 1
  builtin cd -- "$destination"
}
`;
    case "fish": return `function ${name}
  set -l destination (command ggh go --print --shell -- $argv | string collect)
  set -l result $pipestatus[1]
  if test "$result" -ne 0
    return $result
  end
  if test -z "$destination"
    return 1
  end
  builtin cd -- "$destination"
end
`;
    case "pwsh": return `function ${name} {
  $destination = @(& ggh go --print --shell -- @args)
  if ($LASTEXITCODE -ne 0) { return }
  $path = $destination -join "\`n"
  if ([string]::IsNullOrEmpty($path)) { return }
  Set-Location -LiteralPath $path
}
`;
    default: throw new Error("Supported shells: zsh, bash, fish, pwsh.");
  }
}

export function registerInitCommand(program: Command): void {
  program.command("init <shell>").description("Print a shell function to jump to projects")
    .option("--cmd <name>", "Shell function name", "g")
    .action((shell: string, options: { cmd: string }) => {
      try { data(shellInit(shell, options.cmd)); }
      catch (error) { fail(error instanceof Error ? error.message : String(error), { code: "invalid_arguments" }); }
    });
}
