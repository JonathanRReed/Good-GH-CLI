# Packaging `ggh` for distributions

This note is for distro maintainers (and the curious). `ggh` is built to be
easy to carry: two runtime dependencies, no telemetry, no auto-update, XDG
conformant, and every installable artifact generated from the real command
tree at build time.

## Shapes

| Shape | Artifact | Runtime requirements |
| --- | --- | --- |
| Standalone | Native executable with Bun embedded | Git 2.31+; gh for GitHub operations |
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
publishing. Tagged builds create a draft GitHub release; publish it only after
adding and checking the separate signed/notarized macOS DMG. Manual releases resolve `refs/tags/<tag>` once, verify its package
version, and pass that immutable commit SHA to every build. Bun is pinned to
1.4.0. Native jobs download and test the exact artifacts that will be uploaded,
including checksums, PATH discovery, a real commit, and an installed pre-commit
hook. Native checks install the prior published beta, upgrade to the candidate,
roll back, restore the candidate, and uninstall it. Fixture installation and
profile paths contain spaces and Unicode. These simulated profile paths do not
establish behavior under a different operating-system account. The workflow
retains a per-platform JSON installation receipt. POSIX artifacts additionally run `scripts/audit-regressions.py`.

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

## Release command cuts

The repository ships through `scripts/release.ts`, the Makefile, and
`.github/workflows/release.yml`. None invokes `ggh release` or `ggh changelog`.
The script promotes a manually maintained Unreleased section; CI uses native
`gh release` and `scripts/release-notes.cjs`. Version 0.6 removes both CLI wrappers.

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

## Bundle budget for v0.6

Phase 4A measured `dist/ggh.js` at 791,604 bytes before cuts, 739,130 after cuts,
and 649,337 after packing the agent reference and sharing CI/review response
validators. Measurements use `bun run build`, with Bun 1.4.4-canary.1 on macOS
arm64. CI remains pinned to Bun 1.4.0; the headroom covers toolchain variation.
The CI limit is **714,271 bytes**, the final measurement plus 10%, rounded up.

The 600,000-byte limit predates the v0.6 additions. Removing another 49,337 bytes
would require a larger rewrite or cuts to retained features. Keep the single-file
lean bundle and standalone executable. A split-build experiment after command
cuts produced a 539,408-byte entry but 766,082 bytes across 13 files, larger than
the 739,130-byte unsplit build. That changes packaging and passes an entry-only
budget without reducing the full download.

Reproduce the attribution with:

```bash
bun build bin/ggh.ts --target=bun --outdir=/tmp/ggh-size --minify --metafile=/tmp/ggh-size.json
```

Bun's `outputs["./ggh.js"].inputs[*].bytesInOutput` attributes the following
current bytes to v0.6 subsystems. These are their full retained implementations,
not a claim that every byte was added in v0.6. Groups do not overlap and exclude
shared transport, UI, and publication code.

| Subsystem | Minified attributed bytes |
| --- | ---: |
| Projects, bulk sync, tidy/lost, go and shell init | 106,821 |
| Agent contract and skill pack | 41,746 |
| Clone and repository discovery | 11,653 |
| Review workspaces and ledger | 11,651 |
| CI failure evidence | 8,005 |
| Review threads | 7,801 |
| Exact-scope commit service | 2,392 |

The largest individual modules are Commander `command.js` at 27,809 bytes,
stack commands at 25,720, publication at 20,840, commit at 17,957, agent contract
at 17,424, and issues at 16,920. The readable agent reference originally embedded
104,168 bytes. Its generated gzip/base64 module now contributes 14,390 bytes and
expands only during skill installation. `bun run skill:reference --check` compares
the unpacked content with the generated Markdown; compression output need not be
identical across platforms. Regenerate both with `bun run skill:reference`.

## Repository runtime configuration

Native builds disable Bun's automatic dotenv and bunfig loading. Installed Node
and lean launchers pass `--no-env-file` and an installed empty Bun configuration.
A repository cannot enable AI, redirect user configuration, or run a Bun preload
through those files. Explicit caller environment settings remain supported.

Use the installed `ggh` command. Direct `bun script` invocations load Bun runtime
configuration before launcher code starts unless the caller supplies the same
flags. That is a development invocation, rather than the installed bootstrap.
The artifact and package smoke checks include hostile dotenv/preload fixtures.

Set `GGH_CONFIG_DIR=/path/to/ggh-config` to isolate ggh config, aliases, plugins,
and project metadata without changing `XDG_CONFIG_HOME` or hiding gh authentication.
The override names the directory itself, with no `good-gh` suffix added.

## Runtime behaviour packagers should know

- **No network at runtime** except to github.com (via the `gh` CLI it shells
  out to) and, for AI features only, to whichever AI CLI the user configured.
  There is no telemetry, no update check, no phone-home of any kind — verify
  with process/network tracing appropriate to the configured external tools.
- **Graceful without its friends.** No `git` → clear error. No `gh` →
  `ggh status` says so with install instructions. No AI CLI → AI features
  explain themselves and every value has a `-m`/`--no-ai`/manual fallback.
- **XDG conformant.** Config, aliases, and plugins live under
  `$GGH_CONFIG_DIR` when set, otherwise `$XDG_CONFIG_HOME/good-gh`
  (default `~/.config/good-gh`); cache under
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
