# Install Good GH

Standalone binaries need Git 2.31 or newer and do not need Bun or Node. GitHub operations also need GitHub CLI. AI is optional and disabled by default. An explicit commit message needs no provider CLI.

Choose a published version on [Releases](https://github.com/JonathanRReed/Good-GH-CLI/releases). These examples remain pinned to 0.5.0-beta.2. The current source candidate is 0.6.0-beta.1; this preparation does not publish its downloads. Source availability does not prove that its assets have been published. If a download returns 404, inspect the versioned release before continuing. Never execute a file whose checksum check failed. Run each command only after the previous command succeeds.

## macOS

Prefer the signed, notarized universal DMG for Apple Silicon and Intel. Bare macOS binaries have ad-hoc signatures and are not notarized. Check the release notes for the separate DMG upload. Keep Gatekeeper checks enabled. The commands below validate the notarization ticket before mounting.

Run in a new download directory. The install prefix belongs to your user.

```bash
curl -fLO "https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/Good-GH-CLI-0.5.0-beta.2-universal.dmg"
curl -fLO "https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/Good-GH-CLI-0.5.0-beta.2-universal.dmg.sha256"
shasum -a 256 -c "Good-GH-CLI-0.5.0-beta.2-universal.dmg.sha256"
xcrun stapler validate "Good-GH-CLI-0.5.0-beta.2-universal.dmg"
spctl --assess --type open --context context:primary-signature "Good-GH-CLI-0.5.0-beta.2-universal.dmg"
mkdir -p "$PWD/ggh-mounted"
hdiutil attach -readonly -nobrowse -mountpoint "$PWD/ggh-mounted" "Good-GH-CLI-0.5.0-beta.2-universal.dmg"
GGH_INSTALL_PREFIX="$HOME/.local" bash "$PWD/ggh-mounted/Install ggh.command"
hdiutil detach "$PWD/ggh-mounted"
export PATH="$HOME/.local/bin:$PATH"
git --version
gh --version
ggh --version
ggh config doctor
```

The PATH command affects this shell. To keep it, add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file, such as `~/.zshrc` or `~/.bashrc`, then open a new terminal. Check `command -v ggh` if another installation takes precedence.

If Git is missing, run `xcode-select --install`. See the [Git installation instructions](https://git-scm.com/install/mac).

If `gh` is missing, run `brew install gh`. See the [official GitHub CLI installation instructions](https://github.com/cli/cli/blob/trunk/docs/install_macos.md). The `brew` command requires Homebrew; the official instructions also offer precompiled binaries. Reopen your terminal after installing dependencies.

## Linux

This example uses x64. For ARM64, use `ggh-linux-arm64` in the download, checksum, and install commands. Other architectures have no native artifact.

Run in a new download directory. The install prefix belongs to your user.

```bash
curl -fLO "https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/ggh-linux-x64"
curl -fLO "https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/ggh-linux-x64.sha256"
sha256sum -c "ggh-linux-x64.sha256"
mkdir -p "$HOME/.local/bin"
install -m 755 "ggh-linux-x64" "$HOME/.local/bin/ggh"
export PATH="$HOME/.local/bin:$PATH"
git --version
gh --version
ggh --version
ggh config doctor
```

The PATH command affects this shell. To keep it, add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file, such as `~/.zshrc` or `~/.bashrc`, then open a new terminal. Check `command -v ggh` if another installation takes precedence.

If Git is missing, use `sudo apt-get install git` on Debian/Ubuntu or `sudo dnf install git` on Fedora. See the [Git installation instructions](https://git-scm.com/install/).

If `gh` is missing, see the [official GitHub CLI installation instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). Follow the instructions for your distribution, including its repository setup; do not assume `gh` is already available in your configured repositories. Reopen your terminal after installing dependencies.

## Windows PowerShell

The native Windows artifact is x64. There is no Windows ARM64 artifact.

Run in a new download directory. The install prefix belongs to your user.

```powershell
Invoke-WebRequest 'https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/ggh-windows-x64.exe' -OutFile 'ggh-windows-x64.exe'
Invoke-WebRequest 'https://github.com/JonathanRReed/Good-GH-CLI/releases/download/v0.5.0-beta.2/ggh-windows-x64.exe.sha256' -OutFile 'ggh-windows-x64.exe.sha256'
$expected = (Get-Content 'ggh-windows-x64.exe.sha256' -Raw).Trim().Split()[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash 'ggh-windows-x64.exe' -Algorithm SHA256).Hash -ne $expected) { throw 'SHA-256 mismatch' }
$bin = Join-Path $env:USERPROFILE ".local/bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item 'ggh-windows-x64.exe' (Join-Path $bin 'ggh.exe')
$env:Path = "$(Join-Path $env:USERPROFILE ".local/bin");$env:Path"
git --version
gh --version
ggh --version
ggh config doctor
```

The PATH command affects this PowerShell session. To persist this directory for your user, preserve the existing user PATH with the .NET setter, then open a new terminal:

```powershell
$bin = Join-Path $env:USERPROFILE ".local/bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $bin) {
  [Environment]::SetEnvironmentVariable("Path", "$bin;$userPath", "User")
}
Get-Command ggh
```

If Git is missing, run `winget install --id Git.Git -e --source winget`. See the [Git installation instructions](https://git-scm.com/install/windows).

If `gh` is missing, run `winget install --id GitHub.cli`. See the [official GitHub CLI installation instructions](https://github.com/cli/cli/blob/trunk/docs/install_windows.md). Reopen your terminal after installing dependencies.

## Check and repair

Run `ggh config doctor` for local Git, GitHub CLI, and optional provider checks. Its JSON output includes version-pinned download, checksum, install, PATH, and dependency guidance. Doctor never downloads software, edits PATH, signs in, or calls a provider model. `--fix` only repairs supported configuration issues.

Use `ggh status` to check GitHub authentication separately. Run `gh auth login` yourself if you want GitHub access. No AI provider is required while AI is disabled.

## Verification limits

The release workflow builds five native binary targets: Linux x64 and ARM64, macOS x64 and ARM64, and Windows x64. Its native artifact smoke script checks SHA-256 before execution, installs into an isolated prefix with spaces and Unicode characters, and tests PATH resolution and available upgrade/rollback stages. The profile directory is simulated. These checks do not prove installation for a fresh OS account or every machine configuration. Inspect the release receipts for the exact artifact and platform. macOS DMG signing, notarization, and installer checks are separate packaging evidence.
