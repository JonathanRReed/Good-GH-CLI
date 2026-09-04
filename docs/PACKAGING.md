# Packaging `ggh` for distributions

This note is for distro maintainers (and the curious). `ggh` is built to be
easy to carry: two runtime dependencies, no telemetry, no auto-update, XDG
conformant, and every installable artifact generated from the real command
tree at build time.

## Shapes

| Shape | Artifact | Size | Runtime deps |
| --- | --- | --- | --- |
| Standalone (`make install`) | `bun build --compile` binary | ~64 MB (Bun runtime inside) | `git` (+ `gh` for GitHub commands) |
| Lean (`make install-lean`) | 340 KB JS bundle + sh wrapper | ~340 KB | `bun`, `git` (+ `gh`) |

Upstream releases ship five standalone binaries (linux x64/arm64, darwin
x64/arm64, windows x64) with sha256 sums, plus `ggh.1`, bash/zsh/fish
completions, the npm tarball, and a Developer-ID-signed universal macOS DMG.

## Build

Build dependency: Bun >= 1.1 (`bun install` fetches exactly two runtime
dependencies — `commander`, `picocolors` — pinned in `bun.lock`).

```bash
make check      # typecheck + lint + full test suite + man freshness
make install DESTDIR="$pkgdir" PREFIX=/usr
```

`make` targets: `build`, `build-lean`, `man`, `completions`,
`install`, `install-lean`, `uninstall`, `check`, `clean`. All install paths
honour `PREFIX` (default `/usr/local`) and `DESTDIR`. Completions land in
the standard `bash-completion`, `zsh/site-functions`, and fish
`vendor_completions.d` directories; the man page in `man1`; the license in
`share/licenses/good-gh-cli`.

On macOS, `bun run package:macos` builds a universal arm64/x86_64 binary,
signs the binary and DMG with Developer ID, mounts the image, exercises its
installer into a temporary prefix, and writes a SHA-256 file. Set
`GGH_NOTARY_PROFILE` to a valid `notarytool` Keychain profile to submit, staple,
and Gatekeeper-check the same artifact. The Makefile uses ad-hoc signing only
for local developer builds.

## Runtime behaviour packagers should know

- **No network at runtime** except to github.com (via the `gh` CLI it shells
  out to) and, for AI features only, to whichever AI CLI the user configured.
  There is no telemetry, no update check, no phone-home of any kind — verify
  with `grep -rn "fetch(" src/services/`.
- **Graceful without its friends.** No `git` → clear error. No `gh` →
  `ggh status` says so with install instructions. No AI CLI → AI features
  explain themselves and every value has a `-m`/`--no-ai`/manual fallback.
- **XDG conformant.** Config, aliases, and plugins live under
  `$XDG_CONFIG_HOME/good-gh` (default `~/.config/good-gh`); cache under
  `$XDG_CACHE_HOME`. A repo-local `.ggh.json` may set only commit style.
- **Exit codes are a contract.** Zero on success, non-zero on failure;
  `--json` output stays parseable; prompts never guess without a TTY.
- **Plugins run with full process privileges** (they are imported TS/JS).
  This is documented in `ggh plugin --help` and the man page. A distro that
  wants a locked-down build can patch out `loadPlugins`, but upstream will
  not — it is the extension story.

## Example: Arch PKGBUILD sketch (standalone shape)

```pkgbuild
pkgname=good-gh-cli
pkgver=0.4.0
pkgrel=1
arch=('x86_64' 'aarch64')
depends=('git')
optdepends=('github-cli: GitHub commands (pr, issue, run, ...)')
makedepends=('bun')
source=("$pkgname-$pkgver.tar.gz::https://github.com/JonathanRReed/Good-GH-CLI/archive/v$pkgver.tar.gz")
sha256sums=('SKIP')

build() {
  cd "Good-GH-CLI-$pkgver"
  bun install --frozen-lockfile
  make build man
}

check() {
  cd "Good-GH-CLI-$pkgver"
  make check
}

package() {
  cd "Good-GH-CLI-$pkgver"
  make install DESTDIR="$pkgdir" PREFIX=/usr
}
```

For the lean shape, depend on `bun` instead and use `make install-lean`.
