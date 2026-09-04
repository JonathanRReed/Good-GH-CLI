import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { Writable } from "node:stream";
import pc from "picocolors";
import { isNonInteractive } from "../services/runtime.ts";
import { hideCursorTracked, log, showCursorTracked, stripAnsi } from "./output.ts";

/**
 * Interactive prompts. Everything reads from stdin and writes to stderr, so
 * stdout stays reserved for data. Every prompt fails loudly (exit 1) without
 * a TTY instead of guessing — see nonInteractiveNotice.
 */

const p = { log };

/**
 * A prompt cannot be answered without a TTY. Auto-answering is never safe here:
 * the first option of a menu may be destructive (`ggh resolve` -> "accept ours")
 * and a default-yes confirm may publish a release or open a Pull Request. So we
 * cancel loudly and point at the explicit, scriptable alternative.
 */
function nonInteractiveNotice(what: string): void {
  // The command could not do its job, so scripts must see a failure.
  process.exitCode = 1;
  p.log.warn(pc.yellow(`Cannot prompt for "${what}": no interactive terminal.`));
  p.log.info(
    pc.dim("Re-run in a terminal, or pass explicit flags (for example -m, -a, -y, --no-ai)."),
  );
}

export async function promptInput(options: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  if (isNonInteractive()) {
    nonInteractiveNotice(options.message);
    return null;
  }

  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    process.stderr.write(`\n${pc.cyan("◆")}  ${options.message}\n`);
    const defaultVal = options.initialValue || options.defaultValue;
    const hint = defaultVal
      ? pc.dim(` [default: ${defaultVal}]`)
      : options.placeholder
        ? pc.dim(` (${options.placeholder})`)
        : "";
    const promptStr = `${pc.dim("│")}  ${pc.cyan("›")} ${hint ? hint + " " : ""}`;
    const answer = await rl.question(promptStr);
    const result = answer.trim() || defaultVal || "";
    if (options.validate) {
      const err = options.validate(result);
      if (err) {
        process.stderr.write(`${pc.yellow("└")}  ${pc.yellow(err)}\n`);
        rl.close();
        return promptInput(options);
      }
    }
    process.stderr.write(`${pc.dim("└")}\n`);
    return result;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export async function readHiddenLine(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  message: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readlinePromises.createInterface({
    input: options.input,
    output: mutedOutput,
    terminal: true,
  });

  try {
    while (true) {
      options.output.write(`\n${pc.cyan("◆")}  ${options.message}\n`);
      options.output.write(`${pc.dim("│")}  ${pc.cyan("›")} `);
      const answer = await rl.question("");
      const result = answer.trim();
      const error = options.validate?.(result);
      if (error) {
        options.output.write(`\n${pc.yellow("└")}  ${pc.yellow(error)}\n`);
        continue;
      }
      options.output.write(`\n${pc.dim("└")}\n`);
      return result;
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export async function promptSecretInput(options: {
  message: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  if (isNonInteractive()) {
    nonInteractiveNotice(options.message);
    return null;
  }
  return readHiddenLine({
    input: process.stdin,
    output: process.stderr,
    message: options.message,
    validate: options.validate,
  });
}

export interface PickerItem<T = string> {
  value: T;
  label: string;
  hint?: string;
}

/** Width available for prompt frames. Pure derivation, single place. */
export function terminalColumns(): number {
  return Math.max((process.stderr.columns || process.stdout.columns || 80) - 2, 40);
}

/**
 * Visible slice window for a navigable list: clamps the cursor into range
 * and centers the page on it. Pure — covered by tests/prompts.test.ts.
 */
export function visibleWindow(
  selectedIndex: number,
  total: number,
  pageSize: number,
): { start: number; index: number } {
  const index = total === 0 ? 0 : Math.min(Math.max(selectedIndex, 0), total - 1);
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), Math.max(0, total - pageSize)));
  return { start, index };
}

/** Erases a previously drawn prompt frame. */
export function eraseFrame(linesDrawn: number): void {
  if (linesDrawn > 0) process.stderr.write(`\x1b[${linesDrawn}A\r\x1b[J`);
}

function truncateLine(str: string, maxWidth: number): string {
  if (maxWidth <= 3) return "...";
  const plain = stripAnsi(str);
  if (plain.length <= maxWidth) return str;
  return plain.slice(0, maxWidth - 3) + "...\x1b[0m";
}

export async function searchablePicker<T = string>(options: {
  title: string;
  items: PickerItem<T>[];
  pageSize?: number;
  initialQuery?: string;
  onSearchGitHub?: (query: string) => Promise<PickerItem<T>[]>;
}): Promise<T | null> {
  if (isNonInteractive()) {
    nonInteractiveNotice(options.title);
    return null;
  }

  const pageSize = options.pageSize || 7;
  let query = options.initialQuery || "";
  let selectedIndex = 0;
  let linesDrawn = 0;
  const extraItems: PickerItem<T>[] = [];
  let isSearching = false;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    function getFilteredItems(): (PickerItem<T> & { isSearchAction?: boolean })[] {
      const q = query.trim().toLowerCase();
      const all = [...options.items, ...extraItems];

      let filtered: (PickerItem<T> & { isSearchAction?: boolean })[];
      if (!q) {
        filtered = all;
      } else {
        filtered = all.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            (item.hint && item.hint.toLowerCase().includes(q)),
        );

        // If query looks like an exact owner/repo or URL, offer it as direct clone option
        if (q.includes("/") || q.startsWith("http")) {
          filtered = [
            {
              value: query.trim() as unknown as T,
              label: `🔗 Clone "${query.trim()}" directly`,
              hint: "Custom repository / URL",
            },
            ...filtered,
          ];
        }

        // Add option to search GitHub online if callback provided
        if (options.onSearchGitHub) {
          filtered.push({
            value: `__search_github__:${query.trim()}` as unknown as T,
            label: `🔍 Search all GitHub for "${query.trim()}"...`,
            hint: "Query GitHub Search API",
            isSearchAction: true,
          });
        }
      }

      return filtered;
    }

    function render(): void {
      const cols = terminalColumns();
      const filtered = getFilteredItems();

      const window = visibleWindow(selectedIndex, filtered.length, pageSize);
      selectedIndex = window.index;
      const start = window.start;
      const visible = filtered.slice(start, start + pageSize);

      let out = "";
      out += truncateLine(`${pc.bgCyan(pc.black(" good-gh "))} ${pc.bold(options.title)}`, cols) + "\n";
      out += truncateLine(`${pc.cyan("│")}  ${pc.bold("Filter:")} ${query}${pc.inverse(" ")}`, cols) + "\n";
      out += `${pc.dim("│")}\n`;

      if (isSearching) {
        out += truncateLine(`${pc.cyan("│")}  ${pc.yellow("◷ Searching GitHub...")}`, cols) + "\n";
      } else if (filtered.length === 0) {
        out += truncateLine(`${pc.cyan("│")}  ${pc.dim("No matching repositories found.")}`, cols) + "\n";
      } else {
        for (const [i, item] of visible.entries()) {
          const actualIndex = start + i;
          const isSelected = actualIndex === selectedIndex;

          const bullet = isSelected ? pc.cyan("● ") : pc.dim("○ ");
          const label = isSelected ? pc.bold(pc.cyan(item.label)) : item.label;
          const hint = item.hint ? pc.dim(` (${item.hint})`) : "";
          const line = `${pc.cyan("│")}  ${bullet}${label}${hint}`;
          out += truncateLine(line, cols) + "\n";
        }
      }

      if (filtered.length > pageSize) {
        const remaining = filtered.length - (start + visible.length);
        const moreText = remaining > 0 ? `+${remaining} more below` : "at end";
        out += truncateLine(`${pc.dim("│")}  ${pc.dim(`[${start + 1}-${start + visible.length} of ${filtered.length} • ${moreText}]`)}`, cols) + "\n";
      }

      out += truncateLine(`${pc.dim("└")}  ${pc.dim("↑/↓: navigate • Type: filter • Enter: select • Esc: cancel")}`, cols) + "\n";

      // Erase previous frame cleanly
      eraseFrame(linesDrawn);
      process.stderr.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function cleanup(): void {
      process.stdin.removeListener("keypress", guardedKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    async function onKeypress(str: string, key: readline.Key): Promise<void> {
      try {
        await handleKeypress(str, key);
      } catch {
        // An unexpected error must never leave the terminal in raw mode with a hidden cursor
        cleanup();
        resolve(null);
      }
    }

    async function handleKeypress(str: string, key: readline.Key): Promise<void> {
      if (isSearching) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        eraseFrame(linesDrawn);
        process.stderr.write(`${pc.red("✖")}  ${options.title}: Cancelled.\n\n`);
        resolve(null);
        return;
      }

      const filtered = getFilteredItems();

      if (key.name === "return") {
        if (filtered.length === 0) return;
        const chosen = filtered[selectedIndex];
        if (!chosen) return;

        if (chosen.isSearchAction && options.onSearchGitHub) {
          // Perform online GitHub search
          isSearching = true;
          render();
          try {
            const results = await options.onSearchGitHub(query.trim());
            for (const r of results) {
              if (!extraItems.some((e) => e.value === r.value)) {
                extraItems.push(r);
              }
            }
          } catch {
            // Ignore search error
          } finally {
            isSearching = false;
            selectedIndex = 0;
            render();
          }
          return;
        }

        cleanup();
        eraseFrame(linesDrawn);
        process.stderr.write(`${pc.green("✔")}  ${options.title}: ${pc.cyan(chosen.label)}\n\n`);
        resolve(chosen.value);
        return;
      }

      if (key.name === "up") {
        if (filtered.length > 0) {
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : filtered.length - 1;
        }
        render();
        return;
      }

      if (key.name === "down") {
        if (filtered.length > 0) {
          selectedIndex = selectedIndex < filtered.length - 1 ? selectedIndex + 1 : 0;
        }
        render();
        return;
      }

      if (key.name === "backspace") {
        if (query.length > 0) {
          query = query.slice(0, -1);
          selectedIndex = 0;
          render();
        }
        return;
      }

      // Ignore other control keys
      if (key.ctrl || key.meta) return;

      // Printable character
      if (str && str.length === 1 && str >= " ") {
        query += str;
        selectedIndex = 0;
        render();
      }
    }

    // An unexpected error inside a keypress handler must never leave the
    // terminal in raw mode with a hidden cursor.
    function guardedKeypress(str: string, key: readline.Key): void {
      try {
        onKeypress(str, key);
      } catch {
        cleanup();
        // `null` is falsy for every picker contract (including boolean confirms)
        resolve(null as never);
      }
    }

    process.stdin.on("keypress", guardedKeypress);
    render();
  });
}

export interface MenuOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/** @deprecated Use MenuOption instead. */
export type SelectMenuOption<T> = MenuOption<T>;

export async function selectMenu<T>(options: {
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  initialValue?: T;
  pageSize?: number;
}): Promise<T | null> {
  const items = options.options;
  if (!items || items.length === 0) {
    return null;
  }

  if (isNonInteractive()) {
    nonInteractiveNotice(options.message);
    return null;
  }

  let selectedIndex = 0;
  if (options.initialValue !== undefined) {
    const idx = items.findIndex((o) => o.value === options.initialValue);
    if (idx >= 0) selectedIndex = idx;
  }

  const pageSize = options.pageSize || Math.min(items.length, 7);
  let linesDrawn = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursorTracked();

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", guardedKeypress);
      showCursorTracked();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = terminalColumns();

      const window = visibleWindow(selectedIndex, items.length, pageSize);
      selectedIndex = window.index;
      const start = window.start;
      const visible = items.slice(start, start + pageSize);

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";

      for (const [i, item] of visible.entries()) {
        const actualIndex = start + i;
        const isSelected = actualIndex === selectedIndex;

        const bullet = isSelected ? pc.cyan("● ") : pc.dim("○ ");
        const label = isSelected ? pc.bold(pc.cyan(item.label)) : item.label;
        const hint = item.hint ? pc.dim(` (${item.hint})`) : "";
        const line = `${pc.cyan("│")}  ${bullet}${label}${hint}`;
        out += truncateLine(line, cols) + "\n";
      }

      if (items.length > pageSize) {
        const remaining = items.length - (start + visible.length);
        const moreText = remaining > 0 ? `+${remaining} more below` : "at end";
        out += truncateLine(`${pc.dim("│")}  ${pc.dim(`[${start + 1}-${start + visible.length} of ${items.length} • ${moreText}]`)}`, cols) + "\n";
      }

      out += truncateLine(`${pc.dim("└")}  ${pc.dim("↑/↓: navigate • Enter: select • Esc: cancel")}`, cols) + "\n";

      eraseFrame(linesDrawn);
      process.stderr.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(_str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        eraseFrame(linesDrawn);
        process.stderr.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled.")}\n\n`);
        resolve(null);
        return;
      }

      if (key.name === "return") {
        cleanup();
        eraseFrame(linesDrawn);
        const chosen = items[selectedIndex];
        // Unreachable: empty lists return before the keypress loop starts.
        // Resolving null (cancel) instead of throwing keeps the terminal sane.
        if (!chosen) {
          resolve(null);
          return;
        }
        process.stderr.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${pc.cyan(chosen.label)}\n\n`);
        resolve(chosen.value);
        return;
      }

      if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
        render();
        return;
      }

      if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
        selectedIndex = selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
        render();
        return;
      }

      if (key.name === "pageup") {
        selectedIndex = Math.max(0, selectedIndex - pageSize);
        render();
        return;
      }

      if (key.name === "pagedown") {
        selectedIndex = Math.min(items.length - 1, selectedIndex + pageSize);
        render();
        return;
      }

      if (key.name === "home") {
        selectedIndex = 0;
        render();
        return;
      }

      if (key.name === "end") {
        selectedIndex = items.length - 1;
        render();
        return;
      }
    }

    // An unexpected error inside a keypress handler must never leave the
    // terminal in raw mode with a hidden cursor.
    function guardedKeypress(str: string, key: readline.Key): void {
      try {
        onKeypress(str, key);
      } catch {
        cleanup();
        // `null` is falsy for every picker contract (including boolean confirms)
        resolve(null as never);
      }
    }

    process.stdin.on("keypress", guardedKeypress);
    render();
  });
}

/** @deprecated Use MenuOption instead. */
export type MultiSelectMenuOption<T> = MenuOption<T>;

export async function multiSelectMenu<T>(options: {
  message: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  initialValues?: T[];
  pageSize?: number;
  required?: boolean;
}): Promise<T[] | null> {
  const items = options.options;
  if (!items || items.length === 0) {
    return [];
  }

  if (isNonInteractive()) {
    nonInteractiveNotice(options.message);
    return null;
  }

  const selectedSet = new Set<T>(options.initialValues ?? []);
  let selectedIndex = 0;
  const pageSize = options.pageSize || Math.min(items.length, 7);
  let linesDrawn = 0;
  let validationError: string | null = null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursorTracked();

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", guardedKeypress);
      showCursorTracked();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = terminalColumns();

      const window = visibleWindow(selectedIndex, items.length, pageSize);
      selectedIndex = window.index;
      const start = window.start;
      const visible = items.slice(start, start + pageSize);

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";

      for (const [i, item] of visible.entries()) {
        const actualIndex = start + i;
        const isFocused = actualIndex === selectedIndex;
        const isChecked = selectedSet.has(item.value);

        const pointer = isFocused ? pc.cyan("› ") : "  ";
        const box = isChecked ? pc.green("◼ ") : pc.dim("◻ ");
        const label = isFocused ? pc.bold(pc.cyan(item.label)) : item.label;
        const hint = item.hint ? pc.dim(` (${item.hint})`) : "";
        const line = `${pc.cyan("│")} ${pointer}${box}${label}${hint}`;
        out += truncateLine(line, cols) + "\n";
      }

      if (items.length > pageSize) {
        const remaining = items.length - (start + visible.length);
        const moreText = remaining > 0 ? `+${remaining} more below` : "at end";
        out += truncateLine(`${pc.dim("│")}  ${pc.dim(`[${start + 1}-${start + visible.length} of ${items.length} • ${moreText}]`)}`, cols) + "\n";
      }

      if (validationError) {
        out += truncateLine(`${pc.yellow("│")}  ${pc.yellow(`▲ ${validationError}`)}`, cols) + "\n";
      }

      out += truncateLine(
        `${pc.dim("└")}  ${pc.dim("↑/↓: navigate • Space: toggle • 'a': toggle all • Enter: confirm • Esc: cancel")}`,
        cols,
      ) + "\n";

      eraseFrame(linesDrawn);
      process.stderr.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        eraseFrame(linesDrawn);
        process.stderr.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled.")}\n\n`);
        resolve(null);
        return;
      }

      if (key.name === "return") {
        if (options.required && selectedSet.size === 0) {
          validationError = "Please select at least one item.";
          render();
          return;
        }

        cleanup();
        eraseFrame(linesDrawn);
        const chosen = items.filter((it) => selectedSet.has(it.value)).map((it) => it.value);
        process.stderr.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${pc.cyan(`${chosen.length} selected`)}\n\n`);
        resolve(chosen);
        return;
      }

      if (key.name === "space") {
        validationError = null;
        const currentItem = items[selectedIndex];
        if (currentItem) {
          if (selectedSet.has(currentItem.value)) {
            selectedSet.delete(currentItem.value);
          } else {
            selectedSet.add(currentItem.value);
          }
        }
        render();
        return;
      }

      if (str === "a" || str === "A") {
        validationError = null;
        if (selectedSet.size === items.length) {
          selectedSet.clear();
        } else {
          for (const item of items) {
            selectedSet.add(item.value);
          }
        }
        render();
        return;
      }

      if (key.name === "up" || (key.name === "k" && !key.ctrl && !key.meta)) {
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
        render();
        return;
      }

      if (key.name === "down" || (key.name === "j" && !key.ctrl && !key.meta)) {
        selectedIndex = selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
        render();
        return;
      }

      if (key.name === "pageup") {
        selectedIndex = Math.max(0, selectedIndex - pageSize);
        render();
        return;
      }

      if (key.name === "pagedown") {
        selectedIndex = Math.min(items.length - 1, selectedIndex + pageSize);
        render();
        return;
      }

      if (key.name === "home") {
        selectedIndex = 0;
        render();
        return;
      }

      if (key.name === "end") {
        selectedIndex = items.length - 1;
        render();
        return;
      }
    }

    // An unexpected error inside a keypress handler must never leave the
    // terminal in raw mode with a hidden cursor.
    function guardedKeypress(str: string, key: readline.Key): void {
      try {
        onKeypress(str, key);
      } catch {
        cleanup();
        // `null` is falsy for every picker contract (including boolean confirms)
        resolve(null as never);
      }
    }

    process.stdin.on("keypress", guardedKeypress);
    render();
  });
}

export async function confirmPrompt(options: {
  message: string;
  initialValue?: boolean;
  /** Set by an explicit `--yes` flag. The only way to confirm without a TTY. */
  assumeYes?: boolean;
}): Promise<boolean> {
  if (options.assumeYes) {
    p.log.info(`${options.message} ${pc.dim("· yes (--yes)")}`);
    return true;
  }

  if (isNonInteractive()) {
    nonInteractiveNotice(options.message);
    return false;
  }

  let value = options.initialValue ?? true;
  let linesDrawn = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  hideCursorTracked();

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", guardedKeypress);
      showCursorTracked();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = terminalColumns();

      const yesLabel = value ? pc.bold(pc.cyan("● Yes")) : pc.dim("○ Yes");
      const noLabel = !value ? pc.bold(pc.cyan("● No")) : pc.dim("○ No");

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";
      out += truncateLine(`${pc.cyan("│")}  ${yesLabel}   ${noLabel}`, cols) + "\n";
      out += truncateLine(
        `${pc.dim("└")}  ${pc.dim("←/→ or y/n: toggle • Enter: confirm • Esc: cancel (No)")}`,
        cols,
      ) + "\n";

      eraseFrame(linesDrawn);
      process.stderr.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        eraseFrame(linesDrawn);
        process.stderr.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled (No).")}\n\n`);
        resolve(false);
        return;
      }

      if (key.name === "return") {
        cleanup();
        eraseFrame(linesDrawn);
        const answer = value ? pc.green("Yes") : pc.dim("No");
        process.stderr.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${answer}\n\n`);
        resolve(value);
        return;
      }

      if (str === "y" || str === "Y") {
        value = true;
        render();
        return;
      }

      if (str === "n" || str === "N") {
        value = false;
        render();
        return;
      }

      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down" ||
        key.name === "tab"
      ) {
        value = !value;
        render();
        return;
      }
    }

    // An unexpected error inside a keypress handler must never leave the
    // terminal in raw mode with a hidden cursor.
    function guardedKeypress(str: string, key: readline.Key): void {
      try {
        onKeypress(str, key);
      } catch {
        cleanup();
        // `null` is falsy for every picker contract (including boolean confirms)
        resolve(null as never);
      }
    }

    process.stdin.on("keypress", guardedKeypress);
    render();
  });
}
