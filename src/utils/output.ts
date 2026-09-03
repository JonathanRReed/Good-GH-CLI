import pc from "picocolors";
import { getFlags } from "../services/runtime.ts";

/**
 * All human-facing chrome goes to stderr so that stdout carries only data:
 * `ggh log > out.txt` must capture commits, not banners, and `ggh pr --json | jq`
 * must receive nothing but JSON. Errors go to stderr too, so redirecting stdout
 * never silences them.
 */
function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The one channel that writes to stdout. Everything else is chrome. */
export function data(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Emits a value as JSON on stdout and nothing else. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function chromeSuppressed(): boolean {
  const flags = getFlags();
  return flags.json || flags.quiet;
}

const BAR = () => pc.dim("│");

export const log = {
  message(text = ""): void {
    if (chromeSuppressed()) return;
    for (const line of String(text).split("\n")) {
      writeErr(`${BAR()}  ${line}`);
    }
  },
  info(text: string): void {
    if (chromeSuppressed()) return;
    writeErr(`${pc.cyan("●")}  ${text}`);
  },
  step(text: string): void {
    if (chromeSuppressed()) return;
    writeErr(`${pc.green("◇")}  ${text}`);
  },
  success(text: string): void {
    if (chromeSuppressed()) return;
    writeErr(`${pc.green("✔")}  ${text}`);
  },
  warn(text: string): void {
    if (chromeSuppressed()) return;
    writeErr(`${pc.yellow("▲")}  ${text}`);
  },
  /** Errors are never suppressed: --quiet still has to tell you what went wrong. */
  error(text: string): void {
    writeErr(`${pc.red("✖")}  ${text}`);
  },
};

export function intro(title: string): void {
  if (chromeSuppressed()) return;
  writeErr("");
  writeErr(`${pc.dim("┌")}   ${title}`);
  writeErr(BAR());
}

export function outro(text = ""): void {
  if (chromeSuppressed()) return;
  writeErr(BAR());
  writeErr(`${pc.dim("└")}  ${text}`);
  writeErr("");
}

export function cancel(text = ""): void {
  if (chromeSuppressed()) return;
  writeErr(`${pc.red("✖")}  ${text}`);
  writeErr("");
}

/** A boxed aside, used for proposed commit messages and PR bodies. */
export function note(body: string, title = ""): void {
  if (chromeSuppressed()) return;
  const lines = body.split("\n");
  const width = Math.max(
    title.length + 2,
    ...lines.map((l) => stripAnsi(l).length),
    24,
  );
  writeErr(`${pc.dim("◇")}  ${pc.bold(title)} ${pc.dim("─".repeat(Math.max(width - title.length, 2)))}╮`);
  for (const line of lines) {
    const pad = " ".repeat(Math.max(width - stripAnsi(line).length, 0));
    writeErr(`${BAR()}  ${line}${pad}  ${BAR()}`);
  }
  writeErr(`${pc.dim("├" + "─".repeat(width + 4))}╯`);
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

let cursorHidden = false;

function hideCursor(): void {
  if (cursorHidden) return;
  process.stderr.write("\x1b[?25l");
  cursorHidden = true;
}

function showCursor(): void {
  if (!cursorHidden) return;
  process.stderr.write("\x1b[?25h");
  cursorHidden = false;
}

const FRAMES = ["◒", "◐", "◓", "◑"];

export interface Spinner {
  start(message?: string): void;
  message(message: string): void;
  stop(message?: string): void;
}

/**
 * Progress indicator on stderr. Animates only on an interactive terminal —
 * a spinner in a CI log is just noise, so there it prints one line per state.
 */
export function spinner(): Spinner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let current = "";
  let active = false;

  const animate = process.stderr.isTTY === true && !chromeSuppressed();

  function clearLine(): void {
    if (animate) process.stderr.write("\r\x1b[K");
  }

  function render(): void {
    clearLine();
    process.stderr.write(`${pc.cyan(FRAMES[frame % FRAMES.length])}  ${current}`);
    frame++;
  }

  return {
    start(message = ""): void {
      current = message;
      active = true;
      if (chromeSuppressed()) return;
      if (!animate) {
        writeErr(`${pc.cyan("◒")}  ${current}`);
        return;
      }
      hideCursor();
      render();
      timer = setInterval(render, 90);
    },
    message(message: string): void {
      current = message;
      if (!active || chromeSuppressed()) return;
      if (!animate) writeErr(`${pc.cyan("◒")}  ${current}`);
    },
    stop(message?: string): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (active && animate) {
        clearLine();
        showCursor();
      }
      active = false;
      if (chromeSuppressed()) return;
      const final = message ?? current;
      if (final) writeErr(`${pc.green("◇")}  ${final}`);
    },
  };
}

export const hideCursorTracked = hideCursor;
export const showCursorTracked = showCursor;

/** Restores terminal state after an interrupt or crash. */
export function restoreTerminal(): void {
  try {
    showCursor();
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Terminal already gone
  }
}

/**
 * Renders a unified diff with colour. Diffs are output, not chrome, so this goes
 * to stdout — `ggh pr 42` piped into a pager or a file should get the patch.
 */
export function renderDiff(rawDiff: string): void {
  if (!rawDiff.trim()) return;

  const lines = rawDiff.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return pc.bold(pc.dim(line));
    if (line.startsWith("+")) return pc.green(line);
    if (line.startsWith("-")) return pc.red(line);
    if (line.startsWith("@@")) return pc.cyan(line);
    if (line.startsWith("diff --git") || line.startsWith("index ")) return pc.bold(pc.dim(line));
    return line;
  });

  data(`\n${lines.join("\n")}\n`);
}
