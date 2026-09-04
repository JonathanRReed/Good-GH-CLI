/** Parse quoted CLI arguments without expanding shell syntax or environment values. */
export function parseCommandArguments(command: string): string[] {
  if (!command.trim() || /[\r\n\0]/.test(command)) {
    throw new Error("Command must be a nonempty single line.");
  }
  const args: string[] = [];
  let value = "";
  let quote: string | null = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      // Within double quotes, a backslash before an ordinary character is literal.
      if (quote === '"' && !['$', '`', '"', "\\"].includes(char)) value += "\\";
      value += char; escaped = false; continue;
    }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) args.push(value);
      value = ""; started = false;
    } else { value += char; started = true; }
  }
  if (quote || escaped) throw new Error("Command contains an unfinished quote or escape.");
  if (started) args.push(value);
  return args;
}

/** A generated POSIX hook passes these bytes as one argument, never as shell code. */
export function quoteShellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Command arguments cannot contain NUL.");
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
