# ggh packaging (for distro maintainers and the Makefile-impaired)
#
# Two supported shapes:
#   1. Standalone (default `make install`): `bun build --compile` produces one
#      ~64 MB binary with the Bun runtime inside. Runtime deps: git (+ gh for
#      the GitHub commands). No Node, no Bun, no network, no telemetry.
#   2. Lean (`make install-lean`): the 340 KB dist bundle + bin/ggh.cjs
#      launcher, running on the distro's own bun package. Same behaviour,
#      200x smaller.
#
# In both shapes completions and the man page are generated from the real
# command tree at build time, so they cannot drift from the binary.

PREFIX ?= /usr/local
DESTDIR ?=
BINDIR = $(DESTDIR)$(PREFIX)/bin
MANDIR = $(DESTDIR)$(PREFIX)/share/man/man1
BASHDIR = $(DESTDIR)$(PREFIX)/share/bash-completion/completions
ZSHDIR = $(DESTDIR)$(PREFIX)/share/zsh/site-functions
FISHDIR = $(DESTDIR)$(PREFIX)/share/fish/vendor_completions.d
LICDIR = $(DESTDIR)$(PREFIX)/share/licenses/good-gh-cli

BUILD = build/ggh
DIST = dist/ggh.js

.PHONY: all build build-lean man completions install install-lean uninstall check clean

all: build

# Standalone binary (no Bun needed at runtime).
build: $(BUILD)

$(BUILD): bin/ggh.ts $(wildcard src/*.ts src/*/*.ts)
	mkdir -p build
	bun build bin/ggh.ts --compile --minify --outfile $(BUILD)
# macOS kills unsigned local binaries on exec (exit 137); ad-hoc sign so the
# just-built binary can generate completions below. No-op anywhere else.
	if [ "$$(uname)" = "Darwin" ]; then codesign --force --sign - $(BUILD); fi

# 340 KB bundle that runs on the distro bun package.
build-lean:
	bun run build

man/ggh.1: scripts/man.ts $(wildcard src/*.ts src/*/*.ts)
	bun run man

man: man/ggh.1

completions: $(BUILD)
	mkdir -p build/completions
	./$(BUILD) completion bash > build/completions/ggh.bash
	./$(BUILD) completion zsh > build/completions/_ggh
	./$(BUILD) completion fish > build/completions/ggh.fish

completions-lean: build-lean
	mkdir -p build/completions
	bun $(DIST) completion bash > build/completions/ggh.bash
	bun $(DIST) completion zsh > build/completions/_ggh
	bun $(DIST) completion fish > build/completions/ggh.fish

install: build man completions
	mkdir -p $(BINDIR)
	install -m755 $(BUILD) $(BINDIR)/ggh
	mkdir -p $(MANDIR)
	install -m644 man/ggh.1 $(MANDIR)/ggh.1
	mkdir -p $(BASHDIR) $(ZSHDIR) $(FISHDIR)
	install -m644 build/completions/ggh.bash $(BASHDIR)/ggh
	install -m644 build/completions/_ggh $(ZSHDIR)/_ggh
	install -m644 build/completions/ggh.fish $(FISHDIR)/ggh.fish
	mkdir -p $(LICDIR)
	install -m644 LICENSE $(LICDIR)/LICENSE

install-lean: build-lean man completions-lean
# The npm launcher (bin/ggh.cjs) assumes npm's directory layout, so the
# lean install uses a two-line wrapper: bun + the self-contained bundle.
	mkdir -p $(DESTDIR)$(PREFIX)/share/good-gh-cli
	install -m644 $(DIST) $(DESTDIR)$(PREFIX)/share/good-gh-cli/ggh.js
	printf '#!/bin/sh\nexec bun $(PREFIX)/share/good-gh-cli/ggh.js "$$@"\n' > build/ggh-shim
	mkdir -p $(BINDIR)
	install -m755 build/ggh-shim $(BINDIR)/ggh
	mkdir -p $(MANDIR)
	install -m644 man/ggh.1 $(MANDIR)/ggh.1
	mkdir -p $(BASHDIR) $(ZSHDIR) $(FISHDIR)
	install -m644 build/completions/ggh.bash $(BASHDIR)/ggh
	install -m644 build/completions/_ggh $(ZSHDIR)/_ggh
	install -m644 build/completions/ggh.fish $(FISHDIR)/ggh.fish
	mkdir -p $(LICDIR)
	install -m644 LICENSE $(LICDIR)/LICENSE

uninstall:
	rm -f $(BINDIR)/ggh $(MANDIR)/ggh.1
	rm -f $(BASHDIR)/ggh $(ZSHDIR)/_ggh $(FISHDIR)/ggh.fish
	rm -rf $(DESTDIR)$(PREFIX)/share/good-gh-cli $(LICDIR)

check:
	bun run typecheck
	bun run lint
	bun test --timeout 30000
	bun run man --check

clean:
	rm -rf build dist
