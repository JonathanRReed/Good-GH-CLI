#!/usr/bin/env node
/**
 * npm launcher. `bin/ggh.ts` needs Bun; this file runs under whatever Node
 * npm installed us with, then hands off to Bun so `npm i -g good-gh-cli` and
 * `npx good-gh-cli` work as long as Bun is on PATH. Under Bun itself the
 * bundle is imported in-process, so `bun add -g` pays no extra spawn.
 */
"use strict";
const { accessSync, constants, existsSync, statSync } = require("node:fs");
const { delimiter, join, resolve } = require("node:path");

const dist = join(__dirname, "..", "dist", "ggh.js");
const source = join(__dirname, "ggh.ts");
const entry = existsSync(dist) ? dist : source;

if (typeof Bun !== "undefined") {
  import(entry).catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
} else {
  const { spawnSync } = require("node:child_process");
  const pathKey = Object.keys(process.env).find((key) =>
    process.platform === "win32" ? key.toLowerCase() === "path" : key === "PATH",
  );
  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const bun = (process.env[pathKey] || "").split(delimiter).filter(Boolean)
    .map((directory) => resolve(directory, bunName))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const probe = bun && spawnSync(bun, ["--version"], { stdio: "ignore", shell: false });
  if (!probe || probe.error || probe.status !== 0) {
    console.error(
      [
        "ggh runs on Bun, which was not found on your PATH.",
        "",
        "  Install it:",
        "    macOS/Linux:  curl -fsSL https://bun.sh/install | bash",
        "    Windows:      powershell -c \"irm bun.sh/install.ps1 | iex\"",
        "  or download a standalone binary that needs neither Bun nor Node:",
        "  https://github.com/JonathanRReed/Good-GH-CLI/releases",
      ].join("\n"),
    );
    process.exit(127);
  }
  const child = spawnSync(bun, ["--no-env-file", `--config=${join(__dirname, "bunfig.toml")}`, entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: false,
  });
  if (child.signal) {
    process.kill(process.pid, child.signal);
  }
  process.exit(child.status === null ? 1 : child.status);
}
