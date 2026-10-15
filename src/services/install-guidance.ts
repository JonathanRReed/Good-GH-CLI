const releases = "https://github.com/JonathanRReed/Good-GH-CLI/releases";

export function getInstallationGuidance(platform: string, arch: string, version: string) {
  const releaseUrl = `${releases}/tag/v${version}`;
  const downloadBase = `${releases}/download/v${version}`;
  const nativeAsset = (platform === "linux" || platform === "darwin") && (arch === "x64" || arch === "arm64")
    ? `ggh-${platform}-${arch}`
    : platform === "win32" && arch === "x64" ? "ggh-windows-x64.exe" : null;
  const asset = nativeAsset && platform === "darwin" ? `Good-GH-CLI-${version}-universal.dmg` : nativeAsset;
  const git = platform === "darwin"
    ? { command: "xcode-select --install", url: "https://git-scm.com/install/mac" }
    : platform === "win32"
      ? { command: "winget install --id Git.Git -e --source winget", url: "https://git-scm.com/install/windows" }
      : { command: platform === "linux" ? "Debian/Ubuntu: sudo apt-get install git; Fedora: sudo dnf install git" : null, url: "https://git-scm.com/install/" };
  const gh = platform === "darwin"
    ? { command: "brew install gh", url: "https://github.com/cli/cli/blob/trunk/docs/install_macos.md" }
    : platform === "win32"
      ? { command: "winget install --id GitHub.cli", url: "https://github.com/cli/cli/blob/trunk/docs/install_windows.md" }
      : { command: null, url: "https://github.com/cli/cli/blob/trunk/docs/install_linux.md" };
  const downloadCommands: string[] = [];
  const installCommands: string[] = [];
  let pathCommand: string | null = null;
  if (asset && platform === "win32") {
    downloadCommands.push(
      `Invoke-WebRequest '${downloadBase}/${asset}' -OutFile '${asset}'`,
      `Invoke-WebRequest '${downloadBase}/${asset}.sha256' -OutFile '${asset}.sha256'`,
      `$expected = (Get-Content '${asset}.sha256' -Raw).Trim().Split()[0]`,
      `if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash '${asset}' -Algorithm SHA256).Hash -ne $expected) { throw 'SHA-256 mismatch' }`,
    );
    installCommands.push('$bin = Join-Path $env:USERPROFILE ".local/bin"',
      'New-Item -ItemType Directory -Force $bin | Out-Null',
      `Copy-Item '${asset}' (Join-Path $bin 'ggh.exe')`);
    pathCommand = '$env:Path = "$(Join-Path $env:USERPROFILE ".local/bin");$env:Path"';
  } else if (asset) {
    downloadCommands.push(`curl -fLO "${downloadBase}/${asset}"`, `curl -fLO "${downloadBase}/${asset}.sha256"`,
      `${platform === "darwin" ? "shasum -a 256" : "sha256sum"} -c "${asset}.sha256"`);
    if (platform === "darwin") {
      installCommands.push(`xcrun stapler validate "${asset}"`,
        `spctl --assess --type open --context context:primary-signature "${asset}"`,
        'mkdir -p "$PWD/ggh-mounted"',
        `hdiutil attach -readonly -nobrowse -mountpoint "$PWD/ggh-mounted" "${asset}"`,
        'GGH_INSTALL_PREFIX="$HOME/.local" bash "$PWD/ggh-mounted/Install ggh.command"',
        'hdiutil detach "$PWD/ggh-mounted"');
    } else {
      installCommands.push('mkdir -p "$HOME/.local/bin"', `install -m 755 "${asset}" "$HOME/.local/bin/ggh"`);
    }
    pathCommand = 'export PATH="$HOME/.local/bin:$PATH"';
  }
  return {
    platform, arch, version, releaseUrl, asset, nativeAsset,
    supported: asset !== null,
    note: asset ? "Check the versioned release for asset availability before downloading. Commands are instructions only." : "No native artifact is published for this platform and architecture. See source installation instructions.",
    downloadUrl: asset ? `${downloadBase}/${asset}` : null,
    checksumUrl: asset ? `${downloadBase}/${asset}.sha256` : null,
    downloadCommands, installCommands, pathCommand,
    dependencies: { git, gh },
    nextChecks: ["git --version", "gh --version", "ggh --version", "ggh config doctor"],
    helpUrl: "https://github.com/JonathanRReed/Good-GH-CLI/blob/main/docs/INSTALL.md",
  };
}
