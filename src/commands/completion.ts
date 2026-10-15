import { Option, type Command } from "commander";
import { completionCandidates } from "../services/completion.ts";
import { data, fail, header, p, pc } from "../utils/ui.ts";

const BASH = `_ggh_completions() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    [ -n "$candidate" ] && COMPREPLY+=("$candidate")
  done < <(command "\${COMP_WORDS[0]}" completion --query -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -o filenames -F _ggh_completions ggh good-gh
`;

const ZSH = `#compdef ggh good-gh
_ggh() {
  local -a candidates
  candidates=("\${(@f)$(command "\${words[1]}" completion --query -- "\${words[@]:1:$((CURRENT - 1))}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _ggh ggh good-gh
`;

const FISH = `function __fish_ggh_complete
  set -l words (commandline -opc)
  set -l executable $words[1]
  set -e words[1]
  set -l current (commandline -ct)
  if test (count $current) -eq 0
    set current ''
  end
  command $executable completion --query -- $words "$current" 2>/dev/null
end
complete -c ggh -f -a '(__fish_ggh_complete)'
complete -c good-gh -f -a '(__fish_ggh_complete)'
`;

const POWERSHELL = `# Source with: Invoke-Expression "$(ggh completion powershell | Out-String)"
Register-ArgumentCompleter -Native -CommandName ggh,good-gh -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @()
  foreach ($element in @($commandAst.CommandElements | Select-Object -Skip 1)) {
    if ($element.Extent.EndOffset -lt $cursorPosition) {
      if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $words += $element.Value }
      else { $words += $element.Extent.Text }
    }
  }
  $words += $wordToComplete
  $executable = $commandAst.CommandElements[0].Value
  & $executable completion --query -- @words 2>$null | ForEach-Object {
    $candidate = $_
    $quoted = "'" + $candidate.Replace("'", "''") + "'"
    if ($candidate -notmatch '[^a-zA-Z0-9_./:=@+-]') { $quoted = $candidate }
    [System.Management.Automation.CompletionResult]::new($quoted, $candidate, 'ParameterValue', $candidate)
  }
}
`;

export function registerCompletionCommand(program: Command): void {
  program.command("completion [shell]")
    .description("Generate completions for zsh, bash, fish, or powershell")
    .allowExcessArguments()
    .addOption(new Option("--query").hideHelp())
    .action(async (shell: string | undefined, options: { query?: boolean }, command: Command) => {
      if (options.query) {
        const candidates = await completionCandidates(program, command.args);
        if (candidates.length) data(candidates.join("\n"));
        return;
      }
      const target = (shell || (process.platform === "win32" ? "powershell" : process.env.SHELL?.split("/").pop()) || "zsh").toLowerCase();
      if (target.includes("zsh")) data(ZSH);
      else if (target.includes("bash")) data(BASH);
      else if (target.includes("fish")) data(FISH);
      else if (target.includes("powershell") || target.includes("pwsh")) data(POWERSHELL);
      else {
        header("Shell Completion");
        fail(`Unsupported shell: ${target}. Supported shells: zsh, bash, fish, powershell.`);
        p.log.message(`\nExample:\n  ${pc.cyan('eval "$(ggh completion zsh)"')}\n`);
      }
    });
}
