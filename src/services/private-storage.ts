import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Windows modes do not restrict access. Audit DACLs before reading stored data.
// Machine administrators and SYSTEM can take ownership and are outside isolation.
// Paths travel over stdin, never through PowerShell source or command arguments.
const WINDOWS_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:failure = 'inspection_failed'
function Reject([string]$code) { $script:failure = $code; throw 'Private storage rejected.' }
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $root = [IO.Path]::GetFullPath([string]$request.path)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $owners = @($sid.Value, $identity.Owner.Value)
  $privileged = @($sid.Value, $identity.Owner.Value, 'S-1-5-18', 'S-1-5-32-544')
  $readers = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  try { $privileged += ([Security.Principal.NTAccount]::new('NT SERVICE\TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
  function Check-Ancestors([string]$path) {
    $item = [IO.DirectoryInfo]::new($path)
    while ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Reject 'reparse_point' }
      $acl = Get-Acl -LiteralPath $item.FullName
      $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
      if ($null -eq $descriptor.DiscretionaryAcl) { Reject 'null_ancestor_dacl' }
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($privileged -notcontains $owner) { Reject 'unsafe_ancestor_owner' }
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        $danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
        if ($privileged -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $danger) -ne 0) { Reject 'replaceable_ancestor' }
      }
      $item = $item.Parent
    }
  }
  if (-not [IO.Directory]::Exists($root)) {
    if (-not $request.create) { [Console]::Out.Write('{"ok":true,"absent":true}'); exit 0 }
    $ancestor = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($root))
    while ($null -ne $ancestor -and -not $ancestor.Exists) { $ancestor = $ancestor.Parent }
    if ($null -eq $ancestor) { Reject 'missing_ancestor' }
    Check-Ancestors $ancestor.FullName
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    [void][IO.Directory]::CreateDirectory($root, $security)
  }
  Check-Ancestors ([IO.Path]::GetDirectoryName($root))
  $queue = [Collections.Generic.Stack[string]]::new()
  $queue.Push($root)
  $count = 0
  while ($queue.Count -gt 0) {
    $path = $queue.Pop()
    $count++
    if ($count -gt 50000) { Reject 'audit_limit' }
    $attributes = [IO.File]::GetAttributes($path)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Device) -ne 0) { Reject 'unsafe_type' }
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owners -notcontains $owner) { Reject 'foreign_owner' }
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
    if ($null -eq $descriptor.DiscretionaryAcl) { Reject 'null_dacl' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $readers -notcontains $rule.IdentityReference.Value) { Reject 'shared_access' }
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($path)) { $queue.Push($child) }
    }
  }
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write((@{ok=$false; reason=$script:failure; exception=$_.Exception.GetType().Name} | ConvertTo-Json -Compress))
  exit 1
}
`;

export class PrivateStorageError extends Error {
  constructor(message: string) { super(message); this.name = "PrivateStorageError"; }
}

const audited = new Map<string, string>();
function identity(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PrivateStorageError("Unsafe private storage directory type.");
    return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Unix callers retain their mode checks. Windows audits a whole owned tree once. */
export function assertWindowsPrivateDirectory(path: string, create = true, refresh = false): void {
  if (process.platform !== "win32") return;
  const root = resolve(path);
  const current = identity(root);
  for (const [checked, expected] of audited) {
    if (identity(checked) !== expected) { audited.delete(checked); continue; }
    const child = relative(checked, root);
    const contained = child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
    if (!contained) continue;
    if (refresh) { audited.delete(checked); continue; }
    if (!current && create) mkdirSync(root, { recursive: true });
    return;
  }
  if (!current && !create) return;
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL, "utf16le").toString("base64")], {
    input: JSON.stringify({ path: root, create }), encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
  });
  let accepted = false;
  let reason = "inspection_failed";
  try {
    const value: unknown = JSON.parse(result.stdout || "");
    if (typeof value === "object" && value !== null) {
      accepted = "ok" in value && value.ok === true;
      if ("reason" in value && typeof value.reason === "string" && /^[a-z_]{1,64}$/.test(value.reason)) reason = value.reason;
      if ("exception" in value && typeof value.exception === "string" && /^[A-Za-z]{1,64}$/.test(value.exception)) reason += `/${value.exception}`;
    }
  } catch { /* Invalid helper output fails closed. */ }
  if (result.error || result.status !== 0 || !accepted) throw new PrivateStorageError(`Private storage has unsafe or unverifiable Windows permissions (${reason}): ${root}. Restrict access to your account or move this directory aside before retrying.`);
  const verified = identity(root);
  if (verified) audited.set(root, verified);
}

/** Content-bearing temporary files inherit a private root on every platform. */
export function privateTemporaryDirectory(prefix: string): string {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error("Invalid private temporary directory prefix.");
  const root = join(tmpdir(), "good-gh-private");
  assertWindowsPrivateDirectory(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Unsafe private temporary directory.");
  return mkdtempSync(join(root, prefix));
}
