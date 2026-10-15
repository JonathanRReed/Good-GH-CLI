#!/usr/bin/env python3
"""Measure local ggh commands against synthetic repositories.

This runner uses only Python's standard library and Git. It never configures a
remote, and on POSIX it blocks GitHub and AI-provider CLIs with logged shims.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

COMMAND_TIMEOUT_SECONDS = 20
DEFAULT_SAMPLES = 5
FIXTURES = (("small", 20), ("large", 5_000), ("monorepo", 10_000))
PROVIDER_CLIENTS = ("gh", "codex", "grok", "claude", "ollama")
SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")


class MeasurementError(RuntimeError):
    def __init__(self, message: str, elapsed_ms: float | None = None):
        super().__init__(message)
        self.elapsed_ms = elapsed_ms


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=COMMAND_TIMEOUT_SECONDS, check=False)
    if result.returncode:
        raise MeasurementError(f"git {' '.join(args)} failed ({result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()


def git_environment() -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tempfile.gettempdir(),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
           "LC_ALL": "C", "LANG": "C", "TZ": "UTC"}
    if os.name == "nt":
        env["SystemRoot"] = os.environ.get("SystemRoot", r"C:\Windows")
    return env


def create_fixture(root: Path, name: str, file_count: int) -> dict[str, Any]:
    repo = root / (name + " fixture Ω")
    repo.mkdir(parents=True)
    env = git_environment()
    git(["init", "--quiet", "--initial-branch=main"], repo, env)
    git(["config", "user.name", "Benchmark Fixture"], repo, env)
    git(["config", "user.email", "benchmark@example.invalid"], repo, env)

    for index in range(file_count):
        path = repo / "packages" / f"pkg-{index % 32:02d}" / f"file-{index:05d}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"fixture={name}\nfile={index}\nvalue=baseline\n", encoding="utf-8")
    git(["add", "--all"], repo, env)
    git(["commit", "--quiet", "-m", "synthetic baseline"], repo, env)
    head = git(["rev-parse", "HEAD"], repo, env)
    git(["switch", "--quiet", "-c", "feature/benchmark"], repo, env)
    git(["config", "branch.feature/benchmark.gh-merge-base", "main"], repo, env)
    git(["config", "branch.feature/benchmark.gh-merge-base-sha", "main"], repo, env)

    tracked = [repo / "packages" / f"pkg-{index % 32:02d}" / f"file-{index:05d}.txt" for index in range(3)]
    tracked[0].write_text("fixture staged change\n", encoding="utf-8")
    git(["add", "--", str(tracked[0].relative_to(repo))], repo, env)
    tracked[1].write_text("fixture unstaged change\n", encoding="utf-8")
    (repo / "untracked benchmark Ω.txt").write_text("fixture untracked change\n", encoding="utf-8")
    return {"name": name, "path": repo, "files": file_count, "head": head, "branch": "feature/benchmark",
            "expected_status": {"staged": 1, "unstaged": 1, "untracked": 1}}


def setup_isolation(root: Path, artifact: str) -> tuple[dict[str, str], Path, Path | None]:
    profile = root / "profiles" / artifact
    home = profile / "home"
    config = profile / "config"
    cache = profile / "cache"
    data = profile / "data"
    for path in (home, config, cache, data):
        path.mkdir(parents=True, exist_ok=True)
    env: dict[str, str] = {
        "HOME": str(home), "XDG_CONFIG_HOME": str(config), "XDG_CACHE_HOME": str(cache),
        "XDG_DATA_HOME": str(data), "GH_CONFIG_DIR": str(config / "gh"),
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
        "LC_ALL": "C", "LANG": "C", "TZ": "UTC", "NO_COLOR": "1",
    }
    if os.name == "nt":
        env.update({"USERPROFILE": str(home), "APPDATA": str(profile / "roaming"),
                    "LOCALAPPDATA": str(profile / "local"),
                    "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows")})
        (profile / "roaming").mkdir(parents=True, exist_ok=True)
        (profile / "local").mkdir(parents=True, exist_ok=True)
    blocked_prefixes = ("GIT_", "GH_", "GGH_", "GITHUB_", "OPENAI_", "ANTHROPIC_",
                        "CODEX_", "CLAUDE_", "GROK_", "OLLAMA_", "XDG_")
    for key in list(os.environ):
        if key.upper() in {"GIT", "GH", "GGH", "GITHUB", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN",
                           "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
                           "all_proxy", "no_proxy"} or key.upper().startswith(blocked_prefixes):
            continue
        if key not in env:
            env[key] = os.environ[key]
    shim_dir: Path | None = None
    if os.name == "nt":
        git_path = shutil.which("git", path=os.environ.get("PATH", ""))
        if not git_path:
            raise MeasurementError("Git executable was not found.")
        git_dir = str(Path(git_path).resolve().parent)
        system32 = str(Path(env.get("SystemRoot", r"C:\Windows")) / "System32")
        env["PATH"] = os.pathsep.join((git_dir, system32))
    else:
        shim_dir = profile / "offline-shims"
        shim_dir.mkdir(parents=True, exist_ok=True)
        attempts = profile / "blocked-client-attempts.jsonl"
        for client in PROVIDER_CLIENTS:
            shim = shim_dir / client
            shim.write_text("#!/bin/sh\nprintf '%s\\n' \"" + client + " $*\" >> " + shlex.quote(str(attempts)) + "\nexit 69\n", encoding="utf-8")
            shim.chmod(0o755)
        real_path = os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep)
        git_dir = str(Path(shutil.which("git") or "/usr/bin/git").resolve().parent)
        allowed = [str(shim_dir), git_dir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        for entry in real_path:
            if entry and entry not in allowed and not any((Path(entry) / client).exists() for client in PROVIDER_CLIENTS):
                allowed.append(entry)
        env["PATH"] = os.pathsep.join(dict.fromkeys(allowed))
    return env, profile, shim_dir


def validate_output(label: str, stdout: str, expected_version: str | None,
                    fixture: dict[str, Any] | None) -> dict[str, Any]:
    if label == "--version":
        version = stdout.strip()
        if not SEMVER.fullmatch(version):
            raise MeasurementError(f"--version was not a pure semantic version: {stdout[:200]!r}")
        if expected_version and version != expected_version:
            raise MeasurementError(f"Expected version {expected_version}, received {version}.")
        return {"version": version}
    if label == "--help":
        if "Usage:" not in stdout:
            raise MeasurementError("--help output did not contain Usage:.")
        return {"usage": True}
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise MeasurementError(f"{label} did not return valid JSON: {error}") from error
    if label == "log --json -n1":
        expected_head = fixture["head"] if fixture else None
        if (not isinstance(value, list) or not value or not isinstance(value[0], dict) or
                value[0].get("hash") != expected_head):
            raise MeasurementError("log JSON did not contain a valid HEAD commit record.")
        return {"records": len(value), "head": value[0]["hash"]}
    if label == "stack list --json":
        if not isinstance(value, list) or len(value) < 2:
            raise MeasurementError("stack list JSON did not contain the fixture branch graph.")
        nodes = {node.get("branch"): node for node in value if isinstance(node, dict)}
        feature = nodes.get("feature/benchmark")
        if "main" not in nodes or not feature or feature.get("parent") != "main":
            raise MeasurementError("stack list JSON did not contain main -> feature/benchmark.")
        return {"branches": len(value), "feature_parent": feature["parent"]}
    if label == "status --json":
        repo = value.get("repository") if isinstance(value, dict) else None
        wanted = fixture["expected_status"] if fixture else {}
        if not isinstance(repo, dict) or repo.get("branch") != fixture["branch"]:
            raise MeasurementError("status JSON did not report the expected fixture branch.")
        if not isinstance(repo.get("root"), str) or Path(repo["root"]).resolve() != fixture["path"].resolve():
            raise MeasurementError("status JSON did not report the fixture repository root.")
        actual = {key: repo.get(key) for key in wanted}
        if actual != wanted:
            raise MeasurementError(f"status counts differ: expected {wanted}, received {actual}.")
        return {"branch": repo["branch"], "counts": actual}
    raise MeasurementError(f"Unknown command validation: {label}")


def invoke(binary: Path, args: list[str], cwd: Path | None, env: dict[str, str],
           expected_version: str | None, fixture: dict[str, Any] | None,
           label: str) -> tuple[float, dict[str, Any]]:
    started = time.perf_counter_ns()
    process: subprocess.Popen[str] | None = None
    try:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        process = subprocess.Popen([str(binary), *args], cwd=cwd, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=os.name != "nt", creationflags=flags)
        stdout, stderr = process.communicate(timeout=COMMAND_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        elapsed = (time.perf_counter_ns() - started) / 1_000_000
        if process is not None:
            if os.name == "nt":
                taskkill = Path(env.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
                subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.communicate()
        raise MeasurementError(f"{label} timed out after {COMMAND_TIMEOUT_SECONDS}s.", elapsed) from error
    elapsed = (time.perf_counter_ns() - started) / 1_000_000
    assert process is not None
    if process.returncode:
        raise MeasurementError(f"{label} exited {process.returncode}: {stderr.strip()[:500]}", elapsed)
    try:
        validated = validate_output(label, stdout, expected_version, fixture)
    except MeasurementError as error:
        error.elapsed_ms = elapsed
        raise
    return elapsed, validated


def summarize(samples: list[float]) -> dict[str, float | int | None]:
    if not samples:
        return {"count": 0, "p50_ms": None, "min_ms": None, "max_ms": None}
    return {"count": len(samples), "p50_ms": round(statistics.median(samples), 3),
            "min_ms": round(min(samples), 3), "max_ms": round(max(samples), 3)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path, help="Candidate absolute path")
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.samples != DEFAULT_SAMPLES:
        parser.error(f"--samples must be exactly {DEFAULT_SAMPLES} for the current benchmark protocol")
    artifacts = {"candidate": args.binary.resolve()}
    if args.baseline:
        artifacts["baseline"] = args.baseline.resolve()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", args.expected_version):
        parser.error("--expected-version must be an exact semantic version")

    result_doc: dict[str, Any] = {"schema_version": 1, "method": {
        "description": "Every command starts a fresh native CLI process. Setup stays outside timed regions. The first invocation is recorded separately from five later filesystem-warm process runs per side.",
        "cold_cache_claim": False, "samples_per_side": args.samples,
        "timeout_seconds_per_command": COMMAND_TIMEOUT_SECONDS,
        "commands": ["--version", "--help", "log --json -n1", "stack list --json", "status --json"],
        "fixtures": [{"name": name, "files": count} for name, count in FIXTURES],
        "order": "Baseline and candidate order alternates on every paired iteration.",
        "limitation": "Native artifacts may embed different runtimes or build settings; results describe these exact binaries on this host.",
    }, "runner": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve()),
                  "python_version": platform.python_version()},
        "artifacts": {}, "system": {}, "results": {}, "errors": [], "blocked_client_attempts": {}}
    args.results.parent.mkdir(parents=True, exist_ok=True)

    temp_root_obj = tempfile.TemporaryDirectory(prefix="ggh-performance-")
    temp_root = Path(temp_root_obj.name)
    try:
        for name, path in artifacts.items():
            if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
                raise MeasurementError(f"{name} binary must be an executable absolute file: {path}")
            result_doc["artifacts"][name] = {"path": str(path), "sha256": sha256(path)}
        result_doc["system"] = {
            "platform": platform.platform(), "os": platform.system(), "architecture": platform.machine(),
            "cpu_count": os.cpu_count(), "load_average": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
            "git_version": subprocess.run(["git", "--version"], text=True, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, timeout=COMMAND_TIMEOUT_SECONDS, check=True).stdout.strip(),
        }
        fixture_root = temp_root / "fixtures"
        fixture_root.mkdir()
        fixtures = [create_fixture(fixture_root, name, count) for name, count in FIXTURES]
        env_profiles = {name: setup_isolation(temp_root, name) for name in artifacts}
        for name, (_, profile, shim_dir) in env_profiles.items():
            result_doc["blocked_client_attempts"][name] = {"count": 0, "log": str(profile / "blocked-client-attempts.jsonl") if shim_dir else None}

        measurements: dict[str, dict[str, dict[str, Any]]] = {}
        for fixture in fixtures:
            for label, cli_args in (("log --json -n1", ["log", "--json", "-n1"]),
                                    ("stack list --json", ["stack", "list", "--json"]),
                                    ("status --json", ["status", "--json"])):
                measurements[f"{fixture['name']}/{label}"] = {
                    artifact: {"fresh_ms": None, "warm_ms": []} for artifact in artifacts}
        for label, cli_args in (("--version", ["--version"]), ("--help", ["--help"])):
            measurements[label] = {artifact: {"fresh_ms": None, "warm_ms": []} for artifact in artifacts}

        def sample(artifact: str, label: str, cli_args: list[str], fixture: dict[str, Any] | None, phase: str, iteration: int) -> None:
            env, _, _ = env_profiles[artifact]
            key = f"{fixture['name']}/{label}" if fixture else label
            expected = args.expected_version if artifact == "candidate" and label == "--version" else None
            target = measurements[key][artifact]
            try:
                elapsed, validated = invoke(artifacts[artifact], cli_args, fixture["path"] if fixture else None,
                                            env, expected, fixture, label)
            except (MeasurementError, subprocess.TimeoutExpired, OSError) as error:
                receipt = {"artifact": artifact, "command": label, "fixture": fixture["name"] if fixture else None,
                           "phase": phase, "iteration": iteration,
                           "elapsed_ms": getattr(error, "elapsed_ms", None), "message": str(error)}
                result_doc["errors"].append(receipt)
                target.setdefault("errors", []).append(receipt)
                return
            if phase == "fresh":
                target["fresh_ms"] = round(elapsed, 3)
                target["fresh_validation"] = validated
            else:
                target["warm_ms"].append(round(elapsed, 3))
                target["warm_validations"] = target.get("warm_validations", 0) + 1

        workloads: list[tuple[str, list[str], dict[str, Any] | None]] = [
            ("--version", ["--version"], None), ("--help", ["--help"], None)]
        for fixture in fixtures:
            workloads.extend((label, cli_args, fixture) for label, cli_args in (
                ("log --json -n1", ["log", "--json", "-n1"]),
                ("stack list --json", ["stack", "list", "--json"]),
                ("status --json", ["status", "--json"])))
        side_order = sorted(artifacts, key=lambda item: (item != "baseline", item))
        for label, cli_args, fixture in workloads:
            for artifact in side_order:
                sample(artifact, label, cli_args, fixture, "fresh", 0)
        for iteration in range(args.samples):
            order = side_order if iteration % 2 == 0 else list(reversed(side_order))
            for label, cli_args, fixture in workloads:
                for artifact in order:
                    sample(artifact, label, cli_args, fixture, "warm", iteration + 1)

        for key, by_artifact in measurements.items():
            result_doc["results"][key] = {}
            for artifact, value in by_artifact.items():
                result_doc["results"][key][artifact] = {
                    "fresh_ms": value["fresh_ms"], "fresh_validation": value.get("fresh_validation"),
                    "warm": {**summarize(value["warm_ms"]), "raw_ms": value["warm_ms"]},
                    "validated_warm_runs": value.get("warm_validations", 0),
                    "errors": value.get("errors", []), "error_count": len(value.get("errors", [])),
                }
        for name, (_, profile, shim_dir) in env_profiles.items():
            attempts = profile / "blocked-client-attempts.jsonl"
            if shim_dir and attempts.exists():
                lines = attempts.read_text(encoding="utf-8").splitlines()
                result_doc["blocked_client_attempts"][name]["count"] = len(lines)
                result_doc["blocked_client_attempts"][name]["entries"] = lines
        result_doc["fixture_file_count"] = sum(item["files"] for item in fixtures)
    except BaseException as error:
        result_doc["errors"].append({"type": type(error).__name__, "message": str(error)})
    finally:
        temp_root_obj.cleanup()
        args.results.write_text(json.dumps(result_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"results": str(args.results.resolve()), "errors": result_doc["errors"],
                      "artifact_count": len(result_doc["artifacts"]), "result_count": len(result_doc["results"])}))
    return 1 if result_doc["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
