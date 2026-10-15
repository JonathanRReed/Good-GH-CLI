"""Protect owned Windows test directories before creating fixture content."""
import base64
import json
import os
from pathlib import Path
import subprocess
import time

FIXTURE_TIMEOUT = 120


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
[Console]::Out.Write('{"ownerSID":"' + $sid.Value + '","protectedDACL":true,"allowSIDs":["' + $sid.Value + '"]}')
"""
    started = time.monotonic()
    result = subprocess.run([str(executable), "-NoLogo", "-NoProfile", "-NonInteractive",
                             "-EncodedCommand", base64.b64encode(script.encode("utf-16le")).decode("ascii")],
                            input=str(root), encoding="utf-8", capture_output=True, env=environment,
                            timeout=FIXTURE_TIMEOUT, check=True)
    metadata = json.loads(result.stdout)
    metadata["elapsedSeconds"] = round(time.monotonic() - started, 3)
    return metadata

