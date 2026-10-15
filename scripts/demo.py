#!/usr/bin/env python3
"""Run a short, asserted ggh tour inside a disposable local Git repository."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


CLIENTS = ("gh", "codex", "claude", "grok", "ollama")
TIMEOUT_SECONDS = 20


def clean_output(value: str, limit: int = 6) -> str:
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value).strip()
    if not value:
        return "(no output)"
    lines = value.splitlines()
    if len(lines) > limit:
        lines = [*lines[:limit], f"... ({len(lines) - limit} more lines)"]
    return "\n".join(f"  {line}" for line in lines)


def json_output(result: subprocess.CompletedProcess[str], label: str):
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{label}: expected JSON on stdout, got {result.stdout!r}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, help="absolute path to a native ggh binary")
    parser.add_argument("--results", type=Path, help="write a JSON qualification summary")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    binary: Path | None = None
    bun: str | None = None
    if args.binary:
        if not args.binary.is_absolute():
            parser.error("--binary must be an absolute path")
        try:
            binary = args.binary.resolve(strict=True)
        except FileNotFoundError:
            parser.error(f"--binary does not exist: {args.binary}")
        if not binary.is_file():
            parser.error(f"--binary is not a file: {binary}")
        launch = [str(binary)]
    else:
        original_path = os.environ.get("PATH", "")
        bun = shutil.which("bun", path=original_path)
        if not bun:
            parser.error("source mode requires Bun on PATH; pass --binary to qualify a native executable")
        launch = [str(Path(bun).resolve()), "run", str(project_root / "bin" / "ggh.ts")]

    git = shutil.which("git", path=os.environ.get("PATH", ""))
    if not git:
        parser.error("Git is required")
    git = str(Path(git).resolve())

    env = {}
    for key in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"):
        if key in os.environ:
            env[key] = os.environ[key]
    env.update({
        "PATH": os.environ.get("PATH", ""),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "NO_COLOR": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GGH_NO_PLUGINS": "1",
        "GH_PROMPT_DISABLED": "1",
    })

    summary = {
        "mode": "native" if binary else "source",
        "platform": sys.platform,
        "binary": str(binary) if binary else None,
        "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest() if binary else None,
        "bun": bun,
        "commands": [],
    }

    with tempfile.TemporaryDirectory(prefix="ggh demo ") as temporary:
        root = Path(temporary)
        if os.name == "nt":
            from windows_fixture import secure_fixture_root
            summary["fixtureACL"] = secure_fixture_root(root)
        repo = root / "repo"
        home = root / "home"
        denied = root / "deny"
        repo.mkdir()
        home.mkdir()
        denied.mkdir()
        if os.name != "nt":
            root.chmod(0o700)
            home.chmod(0o700)
            denied.chmod(0o700)

        deny_log = root / "client-attempts.log"
        env.update({
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(home / "appdata"),
            "LOCALAPPDATA": str(home / "local"),
            "TEMP": str(root),
            "TMP": str(root),
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_CACHE_HOME": str(home / "cache"),
            "XDG_DATA_HOME": str(home / "data"),
            "GH_CONFIG_DIR": str(home / "gh"),
            "GIT_CONFIG_GLOBAL": str(home / "gitconfig"),
            "GIT_CONFIG_COUNT": "0",
            "GGH_DEMO_DENY_LOG": str(deny_log),
        })
        if os.name == "nt":
            powershell = Path(os.environ["SYSTEMROOT"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            if not powershell.is_file():
                raise AssertionError(f"Windows PowerShell is required to create executable client-deny shims: {powershell}")
            assembly = denied / "ggh-client-deny.exe"
            shim_env = {**env, "GGH_DEMO_SHIM_ASSEMBLY": str(assembly), "PSModulePath": str(powershell.parent / "Modules")}
            source = r"""
using System;
using System.IO;
public static class GghClientDeny {
  public static int Main(string[] args) {
    string name = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]);
    File.AppendAllText(Environment.GetEnvironmentVariable("GGH_DEMO_DENY_LOG"), name + Environment.NewLine);
    Console.Error.WriteLine("blocked by ggh demo: " + name);
    return 97;
  }
}
"""
            powershell_command = "Add-Type -TypeDefinition @'\n" + source + "\n'@ -OutputType ConsoleApplication -OutputAssembly $env:GGH_DEMO_SHIM_ASSEMBLY"
            compiled = subprocess.run(
                [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell_command],
                cwd=root, env=shim_env, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=120, check=False,
            )
            if compiled.returncode != 0 or not assembly.is_file():
                raise AssertionError(f"could not compile Windows client-deny shim: {compiled.stdout.strip()}")
            for name in CLIENTS:
                shutil.copy2(assembly, denied / f"{name}.exe")
        else:
            shim = (
                f"#!{sys.executable}\n"
                "import os, sys\n"
                "with open(os.environ['GGH_DEMO_DENY_LOG'], 'a', encoding='utf-8') as log:\n"
                "    log.write(os.path.basename(sys.argv[0]) + '\\n')\n"
                "print('blocked by ggh demo: ' + os.path.basename(sys.argv[0]), file=sys.stderr)\n"
                "sys.exit(97)\n"
            )
            for name in CLIENTS:
                path = denied / name
                path.write_text(shim, encoding="utf-8")
                path.chmod(0o700)

        search_path = [str(denied), str(Path(git).parent)]
        if os.name == "nt":
            search_path.insert(1, str(Path(os.environ["SYSTEMROOT"]) / "System32"))
        else:
            search_path.extend(("/usr/bin", "/bin", "/usr/sbin", "/sbin"))
        env["PATH"] = os.pathsep.join(dict.fromkeys(search_path))
        if "TMPDIR" in os.environ:
            env["TMPDIR"] = str(root)
        if "TEMP" in os.environ:
            env["TEMP"] = str(root)
        if "TMP" in os.environ:
            env["TMP"] = str(root)

        # Exercise every shim first. Clear this proof from the later run log so
        # the final zero count represents only actual tour invocations.
        expected_attempts = []
        for name in CLIENTS:
            result = subprocess.run(
                [str(denied / (name + ".exe" if os.name == "nt" else name))], cwd=repo, env=env, encoding="utf-8",
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=TIMEOUT_SECONDS, check=False,
            )
            if result.returncode != 97:
                raise AssertionError(f"client-deny shim for {name} returned {result.returncode}, expected 97")
            expected_attempts.append(name)
        actual_probes = deny_log.read_text(encoding="utf-8").splitlines() if deny_log.exists() else []
        if actual_probes != expected_attempts:
            raise AssertionError(f"client-deny positive control failed: {actual_probes!r}")
        deny_log.unlink()

        def run_git(*words: str) -> str:
            result = subprocess.run(
                [git, *words], cwd=repo, env=env, encoding="utf-8",
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=TIMEOUT_SECONDS, check=False,
            )
            if result.returncode != 0:
                raise AssertionError(
                    f"git {shlex.join(words)} exited {result.returncode}: {result.stderr.strip()}"
                )
            return result.stdout.strip()

        def ggh(*words: str, json_mode: bool = False):
            command = [*launch, *words]
            if json_mode:
                command.append("--json")
            label = shlex.join(["ggh", *words, *( ["--json"] if json_mode else [] )])
            print(f"\n$ {label}")
            started = time.monotonic()
            result = subprocess.run(
                command, cwd=repo, env=env, encoding="utf-8",
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=TIMEOUT_SECONDS, check=False,
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            print(clean_output(result.stdout + ("\n" + result.stderr if result.stderr else "")))
            if result.returncode != 0:
                raise AssertionError(f"{label} exited {result.returncode}")
            summary["commands"].append({"command": label, "exitCode": result.returncode, "elapsedMs": elapsed_ms})
            if json_mode:
                # Parse stdout only, so diagnostics on stderr cannot masquerade as JSON.
                parsed = json_output(result, label)
                return parsed
            return result.stdout

        print("ggh local tour. Commands run in a disposable repository with isolated home and Git config.")
        run_git("init", "-b", "main")
        for key, value in (
            ("user.name", "ggh demo"),
            ("user.email", "demo@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", str(repo / ".git" / "hooks")),
        ):
            run_git("config", key, value)

        (repo / "README.txt").write_text("A disposable ggh demo repository.\n", encoding="utf-8")
        ggh("ignore", "*.log", ".env", json_mode=True)
        ignores = ggh("ignore", "--list", json_mode=True)
        if not isinstance(ignores, dict) or ignores.get("patterns") != ["*.log", ".env"]:
            raise AssertionError(f"ggh ignore list differed from .gitignore: {ignores!r}")
        if (repo / ".gitignore").read_text(encoding="utf-8").splitlines() != ["*.log", ".env"]:
            raise AssertionError(".gitignore did not contain exactly the requested patterns")

        commit_output = ggh("commit", "--all", "--message", "feat: add local demo file", "--yes", json_mode=True)
        if not isinstance(commit_output, dict) or commit_output.get("status") != "succeeded" or commit_output.get("action") != "commit":
            raise AssertionError(f"explicit-message commit output was unexpected: {commit_output!r}")
        head_after_commit = run_git("rev-parse", "HEAD")
        if run_git("log", "-1", "--format=%s") != "feat: add local demo file":
            raise AssertionError("ggh commit did not create the requested commit")
        if run_git("status", "--porcelain"):
            raise AssertionError("worktree should be clean after the explicit-message commit")

        log = ggh("log", "-n", "3", json_mode=True)
        if not isinstance(log, list) or len(log) != 1 or log[0].get("hash") != head_after_commit or log[0].get("subject") != "feat: add local demo file":
            raise AssertionError(f"ggh log JSON did not describe HEAD: {log!r}")

        ggh("alias", "lg", "log", json_mode=True)
        aliases = ggh("alias", json_mode=True)
        if not isinstance(aliases, dict) or aliases.get("lg") != "log":
            raise AssertionError(f"alias listing did not include lg -> log: {aliases!r}")
        alias_log = ggh("lg", "-n", "3", json_mode=True)
        if alias_log != log:
            raise AssertionError(f"alias invocation did not behave like ggh log: {alias_log!r}")

        hook_install = ggh("hook", "install", "pre-commit", "--yes", json_mode=True)
        if not isinstance(hook_install, dict) or hook_install.get("action") != "install" or hook_install.get("name") != "pre-commit":
            raise AssertionError(f"hook install result was unexpected: {hook_install!r}")
        hook_path = repo / ".git" / "hooks" / "pre-commit"
        hook_listing = ggh("hook", "list", json_mode=True)
        if not any(item.get("name") == "pre-commit" and item.get("installedByGgh") is True for item in hook_listing):
            raise AssertionError(f"hook list did not report the installed hook: {hook_listing!r}")
        hook_text = hook_path.read_text(encoding="utf-8")
        if "exec ggh 'hook' 'check' \"$@\"" not in hook_text:
            raise AssertionError("installed pre-commit hook did not call ggh hook check")
        if os.name != "nt" and not (hook_path.stat().st_mode & 0o111):
            raise AssertionError("installed pre-commit hook is not executable")
        hook_remove = ggh("hook", "remove", "pre-commit", "--yes", json_mode=True)
        if not isinstance(hook_remove, dict) or hook_remove.get("action") != "remove" or hook_path.exists():
            raise AssertionError(f"hook remove did not remove the installed hook: {hook_remove!r}")

        stack_next = ggh("stack", "next", "demo/child", json_mode=True)
        if not isinstance(stack_next, dict) or any(stack_next.get(key) != value for key, value in {
            "branch": "demo/child", "parent": "main", "created": True,
        }.items()):
            raise AssertionError(f"stack next result was unexpected: {stack_next!r}")
        if run_git("branch", "--show-current") != "demo/child" or run_git("rev-parse", "HEAD") != head_after_commit:
            raise AssertionError("stack next did not create the child branch at the existing HEAD")
        stack = ggh("stack", "list", json_mode=True)
        child = next((node for node in stack if node.get("branch") == "demo/child"), None)
        if child is None or child.get("parent") != "main" or child.get("ahead") != 0 or child.get("behind") != 0:
            raise AssertionError(f"stack list did not show demo/child on main: {stack!r}")
        if run_git("config", "--get", "branch.demo/child.gh-merge-base") != "main":
            raise AssertionError("stack parent was not recorded in local Git config")

        (repo / "README.txt").write_text("A disposable ggh demo repository.\nLocal change to stash.\n", encoding="utf-8")
        stash_push = ggh("stash", "push", "--message", "demo local change", json_mode=True)
        if not isinstance(stash_push, dict) or stash_push.get("action") != "push" or stash_push.get("message") != "demo local change" or stash_push.get("files") != 1:
            raise AssertionError(f"stash push result was unexpected: {stash_push!r}")
        stashes = ggh("stash", "list", json_mode=True)
        if not isinstance(stashes, list) or len(stashes) != 1 or stashes[0].get("message") != "On demo/child: demo local change":
            raise AssertionError(f"stash list did not show the exact local change: {stashes!r}")
        if (repo / "README.txt").read_text(encoding="utf-8") != "A disposable ggh demo repository.\n" or run_git("status", "--porcelain"):
            raise AssertionError("stash push did not restore a clean worktree")
        if run_git("rev-parse", "HEAD") != head_after_commit:
            raise AssertionError("local commands unexpectedly changed HEAD")

        attempts = deny_log.read_text(encoding="utf-8").splitlines() if deny_log.exists() else []
        if attempts:
            raise AssertionError(f"blocked GitHub/provider clients were attempted: {attempts!r}")

        summary.update({"passed": True, "head": head_after_commit, "stashCount": len(stashes), "clientAttempts": attempts})

    if args.results:
        result_path = args.results.expanduser().resolve()
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"\nResults: {result_path}")
    print(f"\nPassed {len(summary['commands'])} local CLI commands. Client attempts: 0.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, subprocess.TimeoutExpired) as error:
        print(f"demo failed: {error}", file=sys.stderr)
        raise SystemExit(1)
