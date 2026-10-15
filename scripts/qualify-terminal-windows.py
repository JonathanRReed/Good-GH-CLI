#!/usr/bin/env python3
"""Qualify a compiled ggh.exe in Windows ConPTY. Test host: pywinpty==2.0.15."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time

DEPENDENCY = "2.0.15"
TIMEOUT = 15
COMMIT_ARGS = ["commit", "--no-ai", "--yes", "--no-verify"]


def taskkill():
    return str(Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def run(args, cwd, env):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True,
                          encoding="utf-8", errors="replace", timeout=TIMEOUT, check=True).stdout


def secure_fixture_root(root):
    """Protect only our new empty fixture, before creating any children."""
    executable = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    environment = {k: v for k, v in os.environ.items() if k.upper() in
                   {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"}}
    environment["PSModulePath"] = str(executable.parent / "Modules")
    script = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [Console]::In.ReadToEnd()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($root, $acl)
$actual = [IO.Directory]::GetAccessControl($root)
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value) { throw 'Fixture ACL verification failed' }
[Console]::Out.Write((@{ ownerSID=$sid.Value; protectedDACL=$actual.AreAccessRulesProtected; allowSIDs=@($rules | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress))
"""
    started = time.monotonic()
    result = subprocess.run([str(executable), "-NoLogo", "-NoProfile", "-NonInteractive",
                             "-EncodedCommand", base64.b64encode(script.encode("utf-16le")).decode("ascii")],
                            input=str(root), encoding="utf-8", capture_output=True, env=environment,
                            timeout=TIMEOUT, check=True)
    metadata = json.loads(result.stdout)
    metadata["elapsedSeconds"] = round(time.monotonic() - started, 3)
    return metadata


class Console:
    def __init__(self, fixture, binary, width=100, direct=False):
        from winpty import PtyProcess
        command = [str(binary), *COMMIT_ARGS] if direct else [os.environ["COMSPEC"], "/D", "/Q", "/K"]
        self.proc = PtyProcess.spawn(command, cwd=str(fixture.repo), env=fixture.env,
                                     dimensions=(30, width), backend="0")
        self.chunks = queue.Queue()
        self.output = ""
        self.stages = []
        self.offset = 0
        threading.Thread(target=self.read, daemon=True).start()
        try:
            if not direct:
                self.send("@echo off\r")
                self.send("echo GGH_READY\r")
                self.expect("\r\nGGH_READY\r\n")
                probe = "import os,sys;print('GGH_TTY',*[os.isatty(i) for i in range(3)]);print('GGH_PYTHON',sys.version);print('GGH_PROBE_DONE')"
                self.send(subprocess.list2cmdline([sys.executable, "-c", probe]) + "\r")
                self.expect("\r\nGGH_PROBE_DONE\r\n")
                self.send(subprocess.list2cmdline([str(binary), *COMMIT_ARGS]) + "\r")
            self.expect("Select commit type:")
        except Exception as error:
            self.drain()
            error.console_stages = self.stages
            error.console_output = self.output[-24000:]
            error.console_alive = self.proc.isalive()
            error.console_exit_code = None if error.console_alive else self.proc.exitstatus
            self.close()
            raise

    def drain(self):
        while True:
            try:
                self.output = (self.output + self.chunks.get_nowait())[-48000:]
            except queue.Empty:
                return

    def read(self):
        try:
            while True:
                chunk = self.proc.read(4096)
                if chunk:
                    self.chunks.put(chunk)
        except Exception as error:
            self.chunks.put("\n[ConPTY reader ended: " + type(error).__name__ + "]\n")

    def send(self, text):
        self.proc.write(text)

    def expect(self, text):
        started = time.monotonic()
        stage = {"waitingFor": text, "timeoutSeconds": TIMEOUT}
        self.stages.append(stage)
        deadline = started + TIMEOUT
        while time.monotonic() < deadline:
            clean = ANSI.sub("", self.output)
            index = clean.find(text, self.offset)
            if index >= 0:
                self.offset = index + len(text)
                stage.update(elapsedSeconds=round(time.monotonic() - started, 3), status="matched")
                return
            try:
                self.output = (self.output + self.chunks.get(timeout=0.1))[-48000:]
            except queue.Empty:
                pass
        stage.update(elapsedSeconds=round(time.monotonic() - started, 3), status="timed_out")
        raise AssertionError("Timed out waiting for " + repr(text))

    def shell_usable(self, exit_code=0):
        # /Q suppresses command echo, so this marker must come from cmd execution.
        self.send("echo GGH_EXIT_%errorlevel%\r")
        self.expect("\r\nGGH_EXIT_" + str(exit_code) + "\r\n")
        self.send("echo GGH_SHELL_USABLE\r")
        self.expect("\r\nGGH_SHELL_USABLE\r\n")

    def close(self):
        if self.proc.isalive():
            subprocess.run([taskkill(), "/PID", str(self.proc.pid), "/T", "/F"],
                           capture_output=True, timeout=TIMEOUT)
        try:
            self.proc.close(force=True)
        except Exception:
            pass


class Fixture:
    def __init__(self, root):
        self.acl = secure_fixture_root(root)
        self.repo = root / "repo"
        self.repo.mkdir()
        home = root / "home"
        home.mkdir()
        # Only host essentials cross into the fixture. Tokens, Git overrides,
        # proxies, provider configuration and inherited config do not.
        allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP"}
        self.env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        self.env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "appdata"),
                        LOCALAPPDATA=str(home / "local"), XDG_CONFIG_HOME=str(home / "config"),
                        XDG_CACHE_HOME=str(home / "cache"), XDG_DATA_HOME=str(home / "data"),
                        GH_CONFIG_DIR=str(home / "gh"), GIT_CONFIG_NOSYSTEM="1",
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0", TERM="xterm-256color",
                        PYWINPTY_BACKEND="0", NO_COLOR="1")
        self.git("init", "--quiet", "-b", "main")
        for key, value in {"user.name": "Terminal Fixture", "user.email": "fixture@example.invalid",
                           "core.hooksPath": str(root / "no-hooks"), "commit.gpgsign": "false",
                           "tag.gpgsign": "false", "core.autocrlf": "false"}.items():
            self.git("config", key, value)
        (self.repo / "synthetic.txt").write_text("baseline\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture baseline")
        self.git("switch", "--quiet", "-c", "terminal")
        (self.repo / "synthetic.txt").write_text("baseline\nterminal qualification\n", encoding="utf-8")
        self.git("add", ".")

    def git(self, *args):
        return run(["git", *args], self.repo, self.env)

    def unchanged(self):
        assert self.git("rev-list", "--count", "HEAD").strip() == "1", "Unexpected commit"
        assert self.git("diff", "--cached", "--name-only").strip() == "synthetic.txt"


def qualify(binary, name, fixture):
    console = None
    receipt = {"name": name, "status": "failed", "fixtureACL": fixture.acl}
    started = time.monotonic()
    try:
        if name == "closed_output_pipe":
            with tempfile.TemporaryFile() as stderr:
                child = subprocess.Popen([str(binary), "--help"], cwd=fixture.repo, env=fixture.env,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr)
                child.stdout.close()
                try:
                    receipt["exitCode"] = child.wait(timeout=TIMEOUT)
                    assert receipt["exitCode"] == 0, "Closed-output command must exit 0"
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=TIMEOUT)
                    stderr.seek(0, os.SEEK_END)
                    stderr.seek(max(0, stderr.tell() - 24000))
                    receipt["stderr"] = stderr.read().decode("utf-8", errors="replace")
            receipt["status"] = "passed"
            return receipt
        direct = name == "windows_forced_termination"
        console = Console(fixture, binary, width=32 if name == "resize" else 100, direct=direct)
        if direct:
            # Windows TerminateProcess is abrupt. This proves bounded termination,
            # not POSIX SIGTERM handlers or terminal restoration after a signal.
            receipt["termination"] = "Windows taskkill /F, no SIGTERM cleanup claim"
            result = subprocess.run([taskkill(), "/PID", str(console.proc.pid), "/T", "/F"],
                                    capture_output=True, timeout=TIMEOUT)
            assert result.returncode == 0, "taskkill failed"
            deadline = time.monotonic() + TIMEOUT
            while console.proc.isalive() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert not console.proc.isalive(), "Process survived termination"
            fixture.unchanged()
        else:
            console.send("\r")
            console.expect("Enter scope")
            if name == "ctrl_c":
                console.send("partial\x03")
                console.expect("Commit cancelled")
                console.shell_usable(exit_code=130)
                receipt["exitCode"] = 130
                fixture.unchanged()
            else:
                description = "Unicode café 東京 🦊"
                body = "Synthetic queued body"
                if name == "queued_answers":
                    console.send("terminal\r" + description + "\r" + body + "\r")
                else:
                    console.send("terminal\r")
                    console.expect("Enter short description")
                    if name == "word_delete":
                        description = "keep replacement"
                        console.send("keep unwanted\x17replacement\r")
                    elif name == "bracketed_paste":
                        description = "pasted café 東京"
                        console.send("\x1b[200~" + description + "\x1b[201~\r")
                    elif name == "resize":
                        description = "narrow café 東京 after resize"
                        console.send("narrow café 東京 ")
                        console.proc.setwinsize(30, 72)
                        console.send("after resize\r")
                    else:
                        console.send(description + "\r")
                    console.expect("Enter commit body")
                    console.send(body + "\r")
                # Queue the sentinel only after the CLI has completed; otherwise
                # a broken input reader could consume it as a wizard answer.
                console.expect("Commit created successfully!")
                console.shell_usable()
                assert fixture.git("rev-list", "--count", "HEAD").strip() == "2"
                actual = fixture.git("log", "-1", "--format=%B").strip()
                expected = "feat(terminal): " + description + "\n\n" + body
                assert actual == expected, "Commit mismatch: " + repr(actual)
                receipt["commitMessage"] = actual
        receipt["status"] = "passed"
    except Exception as error:
        receipt["error"] = str(error)
        if hasattr(error, "console_output"):
            receipt["stages"] = error.console_stages
            receipt["output"] = error.console_output
            receipt["consoleAlive"] = error.console_alive
            receipt["consoleExitCode"] = error.console_exit_code
    finally:
        receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
        if console is not None:
            receipt["stages"] = console.stages
            receipt["output"] = console.output[-24000:]
            console.close()
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--results", required=True, type=Path)
    args = parser.parse_args()
    result = {"platform": sys.platform, "backend": "ConPTY", "cases": []}
    if sys.platform != "win32":
        result.update(status="unsupported", error="Run this script on Windows with pywinpty==2.0.15 and compiled ggh.exe.")
    else:
        try:
            assert args.binary.is_absolute() and args.binary.is_file(), "--binary must be an existing absolute path"
            assert importlib.metadata.version("pywinpty") == DEPENDENCY, "Install test dependency: python -m pip install pywinpty==2.0.15"
            result["binarySHA256"] = hashlib.sha256(args.binary.read_bytes()).hexdigest()
            for name in ["unicode", "queued_answers", "word_delete", "bracketed_paste", "resize",
                         "ctrl_c", "windows_forced_termination", "closed_output_pipe"]:
                with tempfile.TemporaryDirectory(prefix="ggh-conpty-") as root:
                    result["cases"].append(qualify(args.binary, name, Fixture(Path(root))))
            result["status"] = "passed" if all(c["status"] == "passed" for c in result["cases"]) else "failed"
        except Exception as error:
            result.update(status="failed", error=str(error))
    args.results.parent.mkdir(parents=True, exist_ok=True)
    args.results.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "results": str(args.results)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
