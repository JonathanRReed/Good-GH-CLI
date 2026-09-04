# Packaging `ggh` for distributions

This note is for distro maintainers (and the curious). `ggh` is built to be
easy to carry: two runtime dependencies, no telemetry, no auto-update, XDG
conformant, and every installable artifact generated from the real command
tree at build time.

## Shapes

| Shape | Artifact | Runtime requirements |
| --- | --- | --- |
| Standalone | Native executable with Bun embedded | Git; gh for GitHub operations |
| Lean | Minified JS bundle and shell wrapper | Bun 1.4+, Git; gh for GitHub operations |
| npm tarball | Node launcher, bundle, source, package metadata | Node 22+, Bun 1.4+, Git; gh for GitHub operations |

The release workflow produces five standalone binaries (Linux x64/arm64,
macOS x64/arm64, Windows x64), an npm tarball, completions, a man page, and
SHA-256 files. macOS binaries are ad-hoc signed before hashing; that is not a
Developer ID signature or notarization. A Developer-ID-signed universal DMG
is a separate local packaging operation requiring the maintainer's signing
identity and, for notarization, Keychain profile.

### Release gates

Pull requests run the same artifact build/install/smoke pipeline without
publishing. Manual releases resolve `refs/tags/<tag>` once, verify its package
version, and pass that immutable commit SHA to every build. Bun is pinned to
1.4.0. Native jobs download and test the exact artifacts that will be uploaded,
including checksums, a real commit, and an installed pre-commit hook. POSIX
artifacts additionally run `scripts/audit-regressions.py`.

npm publication is explicitly opt-in: set the repository variable
`PUBLISH_NPM=true` and configure a valid `NPM_TOKEN`. Missing credentials then
fail the job rather than quietly succeeding. With publication disabled, release
notes state that no npm version was published and document tarball installation.
The publish job uses the already-tested tarball, then checks the exact registry
version and intended `beta`/`latest` dist-tag. Do not infer registry publication
from a GitHub asset release alone.

`bun run release <version>` verifies the tree, bumps the package/changelog,
regenerates the versioned man page, rebuilds, commits, and creates a **local**
tag. It does not push. Review the commit before pushing the tag.

## Build

Build dependencies: Bun 1.4.0, Git, and the dependencies pinned in `bun.lock`.
Use `bun install --frozen-lockfile`; the two runtime dependencies are commander
and picocolors. CI also installs the packed package under Node 22.

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
  with process/network tracing appropriate to the configured external tools.
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
  needs recovery can run with `GGH_NO_PLUGINS=1`; this skips plugin execution
  while leaving management commands available.

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
