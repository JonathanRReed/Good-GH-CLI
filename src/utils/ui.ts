import * as p from "@clack/prompts";
import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import pc from "picocolors";
import type { AIProvider } from "../services/ai/index.ts";

export { p, pc };

export async function promptInput(options: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | null> {
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${pc.cyan("◆")}  ${options.message}\n`);
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
        process.stdout.write(`${pc.yellow("└")}  ${pc.yellow(err)}\n`);
        rl.close();
        return promptInput(options);
      }
    }
    process.stdout.write(`${pc.dim("└")}\n`);
    return result;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export interface PickerItem<T = string> {
  value: T;
  label: string;
  hint?: string;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
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
  if (!process.stdin.isTTY) {
    // Non-interactive fallback
    return options.items[0]?.value ?? null;
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
      const cols = Math.max((process.stdout.columns || 80) - 2, 40);
      const filtered = getFilteredItems();

      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }

      // Calculate visible window
      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(pageSize / 2), Math.max(0, filtered.length - pageSize)),
      );
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
        for (let i = 0; i < visible.length; i++) {
          const item = visible[i];
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
      if (linesDrawn > 0) {
        process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
      }
      process.stdout.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function cleanup(): void {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    async function onKeypress(str: string, key: readline.Key): Promise<void> {
      if (isSearching) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        process.stdout.write(`${pc.red("✖")}  ${options.title}: Cancelled.\n\n`);
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
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        process.stdout.write(`${pc.green("✔")}  ${options.title}: ${pc.cyan(chosen.label)}\n\n`);
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

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export interface SelectMenuOption<T> {
  value: T;
  label: string;
  hint?: string;
}

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

  if (!process.stdin.isTTY) {
    if (options.initialValue !== undefined) {
      const match = items.find((o) => o.value === options.initialValue);
      if (match) return match.value;
    }
    return items[0]?.value ?? null;
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
  process.stdout.write("\x1b[?25l");

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.write("\x1b[?25h");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = Math.max((process.stdout.columns || 80) - 2, 40);

      if (selectedIndex >= items.length) {
        selectedIndex = Math.max(0, items.length - 1);
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }

      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(pageSize / 2), Math.max(0, items.length - pageSize)),
      );
      const visible = items.slice(start, start + pageSize);

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";

      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
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

      if (linesDrawn > 0) {
        process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
      }
      process.stdout.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(_str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        process.stdout.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled.")}\n\n`);
        resolve(null);
        return;
      }

      if (key.name === "return") {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        const chosen = items[selectedIndex];
        process.stdout.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${pc.cyan(chosen.label)}\n\n`);
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

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export interface MultiSelectMenuOption<T> {
  value: T;
  label: string;
  hint?: string;
}

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

  if (!process.stdin.isTTY) {
    return options.initialValues ?? [];
  }

  const selectedSet = new Set<T>(options.initialValues ?? []);
  let selectedIndex = 0;
  const pageSize = options.pageSize || Math.min(items.length, 7);
  let linesDrawn = 0;
  let validationError: string | null = null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.write("\x1b[?25h");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = Math.max((process.stdout.columns || 80) - 2, 40);

      if (selectedIndex >= items.length) {
        selectedIndex = Math.max(0, items.length - 1);
      } else if (selectedIndex < 0) {
        selectedIndex = 0;
      }

      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(pageSize / 2), Math.max(0, items.length - pageSize)),
      );
      const visible = items.slice(start, start + pageSize);

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";

      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
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

      if (linesDrawn > 0) {
        process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
      }
      process.stdout.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        process.stdout.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled.")}\n\n`);
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
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        const chosen = items.filter((it) => selectedSet.has(it.value)).map((it) => it.value);
        process.stdout.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${pc.cyan(`${chosen.length} selected`)}\n\n`);
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

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export async function confirmPrompt(options: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return options.initialValue ?? false;
  }

  let value = options.initialValue ?? true;
  let linesDrawn = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  return new Promise((resolve) => {
    function cleanup(): void {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.write("\x1b[?25h");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    }

    function render(): void {
      const cols = Math.max((process.stdout.columns || 80) - 2, 40);

      const yesLabel = value ? pc.bold(pc.cyan("● Yes")) : pc.dim("○ Yes");
      const noLabel = !value ? pc.bold(pc.cyan("● No")) : pc.dim("○ No");

      let out = "";
      out += truncateLine(`${pc.cyan("◆")}  ${pc.bold(options.message)}`, cols) + "\n";
      out += truncateLine(`${pc.cyan("│")}  ${yesLabel}   ${noLabel}`, cols) + "\n";
      out += truncateLine(
        `${pc.dim("└")}  ${pc.dim("←/→ or y/n: toggle • Enter: confirm • Esc: cancel (No)")}`,
        cols,
      ) + "\n";

      if (linesDrawn > 0) {
        process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
      }
      process.stdout.write(out);
      linesDrawn = out.split("\n").length - 1;
    }

    function onKeypress(str: string, key: readline.Key): void {
      if (!key) return;

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        process.stdout.write(`${pc.red("✖")}  ${options.message} ${pc.dim("· Cancelled (No).")}\n\n`);
        resolve(false);
        return;
      }

      if (key.name === "return") {
        cleanup();
        if (linesDrawn > 0) {
          process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[J`);
        }
        const answer = value ? pc.green("Yes") : pc.dim("No");
        process.stdout.write(`${pc.green("✔")}  ${options.message} ${pc.dim("·")} ${answer}\n\n`);
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

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export function header(title: string): void {
  p.intro(pc.bgCyan(pc.black(` good-gh `)) + " " + pc.bold(title));
}

export function footer(message?: string): void {
  p.outro(message ? pc.green(`✔ ${message}`) : pc.dim("Done."));
}

export function formatError(message: string): string {
  return pc.red(`✖ ${message}`);
}

export function formatSuccess(message: string): string {
  return pc.green(`✔ ${message}`);
}

export function formatInfo(message: string): string {
  return pc.cyan(`ℹ ${message}`);
}

export function formatWarning(message: string): string {
  return pc.yellow(`▲ ${message}`);
}

export async function promptFirstRunProvider(_available: AIProvider[]): Promise<"codex" | "grok"> {
  p.note(
    "Good GH CLI detected your local AI logins (Codex / Grok).\nNo API keys or credit cards required!",
    "First-Time Setup",
  );

  const options = [
    {
      value: "codex" as const,
      label: "Codex (Luna / ChatGPT)",
      hint: "Fast & high-quality using gpt-5.6-luna (Recommended)",
    },
    {
      value: "grok" as const,
      label: "xAI Grok",
      hint: "Using your local grok CLI session",
    },
  ];

  const selection = await selectMenu<"codex" | "grok">({
    message: "Choose your primary AI commit provider:",
    options,
    initialValue: "codex",
  });

  if (selection === null) {
    p.cancel("Setup cancelled. Defaulting to Codex (Luna).");
    return "codex";
  }

  return selection;
}
