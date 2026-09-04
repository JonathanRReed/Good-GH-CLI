#!/usr/bin/env bun
/** Build, Developer-ID sign, and verify a universal macOS CLI DMG. */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };
const version = pkg.version;
const identity = process.env.GGH_SIGN_IDENTITY || "Developer ID Application: Jonathan Reed (AJ9VWBRNZN)";
const notaryProfile = process.env.GGH_NOTARY_PROFILE;
const allowDirty = process.argv.includes("--allow-dirty");
const buildRoot = join(root, "build", "macos-dmg");
const payload = join(buildRoot, `Good GH ${version}`);
const outputDir = join(root, "release");
const dmg = join(outputDir, `Good-GH-CLI-${version}-universal.dmg`);

function run(command: string, args: string[], options: { quiet?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const proc = Bun.spawnSync([command, ...args], {
    cwd: root,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${stderr || stdout}`);
  }
  if (!options.quiet && stderr.trim()) process.stderr.write(stderr);
  return stdout.trim();
}

if (process.platform !== "darwin") throw new Error("macOS packaging must run on macOS.");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
if (!allowDirty && run("git", ["status", "--porcelain"])) {
  throw new Error("Refusing to package a dirty working tree. Commit the release source first.");
}
if (!run("security", ["find-identity", "-v", "-p", "codesigning"]).includes(identity)) {
  throw new Error(`Signing identity is unavailable: ${identity}`);
}

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(join(payload, "bin"), { recursive: true });
mkdirSync(join(payload, "share", "man", "man1"), { recursive: true });
mkdirSync(join(payload, "share", "completions"), { recursive: true });
mkdirSync(outputDir, { recursive: true });

const arm = join(buildRoot, "ggh-arm64");
const intel = join(buildRoot, "ggh-x64");
const binary = join(payload, "bin", "ggh");
run("bun", ["build", "bin/ggh.ts", "--compile", "--minify", "--target=bun-darwin-arm64", `--outfile=${arm}`]);
run("bun", ["build", "bin/ggh.ts", "--compile", "--minify", "--target=bun-darwin-x64", `--outfile=${intel}`]);
run("lipo", ["-create", arm, intel, "-output", binary]);
chmodSync(binary, 0o755);

run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, binary]);
run("codesign", ["--verify", "--strict", "--verbose=2", binary]);
const architectures = run("lipo", ["-archs", binary]);
if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
  throw new Error(`Universal binary is missing an architecture: ${architectures}`);
}
if (run(binary, ["--version"], { quiet: true }) !== version) {
  throw new Error("Packaged binary version does not match package.json.");
}
run(binary, ["--help"], { quiet: true });

cpSync(join(root, "man", "ggh.1"), join(payload, "share", "man", "man1", "ggh.1"));
for (const shell of ["bash", "zsh", "fish"] as const) {
  const name = shell === "bash" ? "ggh.bash" : shell === "zsh" ? "_ggh" : "ggh.fish";
  writeFileSync(join(payload, "share", "completions", name), run(binary, ["completion", shell], { quiet: true }) + "\n");
}
cpSync(join(root, "LICENSE"), join(payload, "LICENSE"));

const installer = `#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PREFIX="\${GGH_INSTALL_PREFIX:-/usr/local}"
if [[ ! -d "$PREFIX" ]]; then
  mkdir -p "$PREFIX" 2>/dev/null || sudo mkdir -p "$PREFIX"
fi
SUDO=()
if [[ ! -w "$PREFIX" ]]; then SUDO=(sudo); fi
"\${SUDO[@]}" mkdir -p "$PREFIX/bin" "$PREFIX/share/man/man1" "$PREFIX/share/bash-completion/completions" "$PREFIX/share/zsh/site-functions" "$PREFIX/share/fish/vendor_completions.d"
"\${SUDO[@]}" install -m 755 "$ROOT/bin/ggh" "$PREFIX/bin/ggh"
"\${SUDO[@]}" install -m 644 "$ROOT/share/man/man1/ggh.1" "$PREFIX/share/man/man1/ggh.1"
"\${SUDO[@]}" install -m 644 "$ROOT/share/completions/ggh.bash" "$PREFIX/share/bash-completion/completions/ggh"
"\${SUDO[@]}" install -m 644 "$ROOT/share/completions/_ggh" "$PREFIX/share/zsh/site-functions/_ggh"
"\${SUDO[@]}" install -m 644 "$ROOT/share/completions/ggh.fish" "$PREFIX/share/fish/vendor_completions.d/ggh.fish"
echo "Installed ggh ${version} to $PREFIX/bin/ggh"
"$PREFIX/bin/ggh" --version
`;
const installPath = join(payload, "Install ggh.command");
writeFileSync(installPath, installer);
chmodSync(installPath, 0o755);

writeFileSync(
  join(payload, "README.txt"),
  `Good GH CLI ${version}\n\nDouble-click "Install ggh.command", or run ./bin/ggh directly.\n\nRequirements: git. GitHub features also require the gh CLI. AI is optional and hosted AI requires explicit consent. ggh collects no telemetry and performs no automatic update checks.\n`,
);

if (existsSync(dmg)) rmSync(dmg);
const imageTempDir = mkdtempSync(join(tmpdir(), "good-gh-dmg-"));
const temporaryDmg = join(imageTempDir, basename(dmg));
try {
  run("diskutil", [
    "image",
    "create",
    "from",
    "--volumeName",
    `Good GH ${version}`,
    "--format",
    "UDZO",
    payload,
    temporaryDmg,
  ]);
  renameSync(temporaryDmg, dmg);
} finally {
  rmSync(imageTempDir, { recursive: true, force: true });
}
run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
run("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
run("hdiutil", ["verify", dmg]);

const mount = join(buildRoot, "mounted");
const installSmoke = join(buildRoot, "installed");
mkdirSync(mount, { recursive: true });
try {
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
  const mountedBinary = join(mount, "bin", "ggh");
  run("codesign", ["--verify", "--strict", "--verbose=2", mountedBinary]);
  if (run(mountedBinary, ["--version"], { quiet: true }) !== version) {
    throw new Error("Mounted DMG binary failed its version smoke test.");
  }
  run("bash", [join(mount, "Install ggh.command")], {
    quiet: true,
    env: { GGH_INSTALL_PREFIX: installSmoke },
  });
  if (run(join(installSmoke, "bin", "ggh"), ["--version"], { quiet: true }) !== version) {
    throw new Error("DMG installer smoke test failed.");
  }
} finally {
  run("hdiutil", ["detach", mount], { quiet: true });
}

if (notaryProfile) {
  run("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfile]);
  run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
}

const checksum = run("shasum", ["-a", "256", dmg]);
const sha256 = checksum.split(/\s+/)[0];
if (!sha256) throw new Error("Could not parse the DMG checksum.");
writeFileSync(`${dmg}.sha256`, `${sha256}  ${basename(dmg)}\n`);
console.log(JSON.stringify({
  artifact: dmg,
  file: basename(dmg),
  version,
  architectures: architectures.split(/\s+/).sort(),
  identity,
  notarized: Boolean(notaryProfile),
  sha256,
}, null, 2));
