# Requires an elevated hosted Windows runner. Uses only synthetic content.
[CmdletBinding()]
param([string]$ProjectRoot = (Split-Path $PSScriptRoot), [Parameter(Mandatory)][string]$ResultsFile)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Windows and PowerShell 7 are required.' }
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Account qualification is restricted to a hosted Windows CI runner.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The runner must be elevated.' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class PrivacyProbe {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(SafeAccessTokenHandle token, bool disable, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returned);
  public static void EnableRestore() {
    SafeAccessTokenHandle token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    using (token) {
      Luid luid;
      if (!LookupPrivilegeValue(null, "SeRestorePrivilege", out luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var state = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new Win32Exception(error);
    }
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool LogonUser(string name, string domain, string password, int type, int provider, out SafeAccessTokenHandle token);
  public static SafeAccessTokenHandle Login(string name, string password) {
    SafeAccessTokenHandle token;
    if (!LogonUser(name, ".", password, 2, 0, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return token;
  }
  public static bool Control(SafeAccessTokenHandle token, string path) {
    return WindowsIdentity.RunImpersonated(token, () => File.ReadAllText(path) == "public-control");
  }
  public static bool Denied(SafeAccessTokenHandle token, string path, string action) {
    return WindowsIdentity.RunImpersonated(token, () => {
      try {
        switch(action) {
          case "read": using (var f = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {} break;
          case "write": using (var f = File.Open(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {} break;
          case "delete-file": File.Delete(path); break;
          case "create": using (var f = File.Open(Path.Combine(path, "unauthorized-child"), FileMode.CreateNew, FileAccess.Write)) {} break;
          case "rename": Directory.Move(path, path + "-unauthorized"); break;
          case "delete-directory": Directory.Delete(path, true); break;
          default: throw new ArgumentException("Unknown probe");
        }
        return false;
      } catch (UnauthorizedAccessException) { return true; }
    });
  }
}
'@
$userName = 'gghq' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$password = 'Ggh!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)) + '9a'
$created = $false
$token = $null
$work = Join-Path $env:SystemDrive ('ggh-privacy-' + [Guid]::NewGuid().ToString('N'))
$receipt = [ordered]@{ platform = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString(); bun = (& bun --version); sourceSha = (& git -C $ProjectRoot rev-parse HEAD); startedAt = [DateTime]::UtcNow.ToString('o'); checks = @(); passed = $false }
function Record([string]$name, [bool]$passed) {
  $script:receipt.checks += [pscustomobject]@{ name = $name; passed = $passed }
  if (-not $passed) { throw "Qualification failed: $name" }
}
function Set-Private([string]$path) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity.User); $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $path -AclObject $acl
}
function Fixture([string]$path, [string]$mode = '') {
  $output = & bun (Join-Path $ProjectRoot 'scripts/windows-storage-fixture.ts') $path $mode
  if ($LASTEXITCODE -ne 0) { throw 'Storage fixture failed.' }
  return ($output | ConvertFrom-Json)
}
try {
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  $user = New-LocalUser -Name $userName -Password $secure -AccountNeverExpires -Description 'Temporary synthetic CLI privacy qualification'
  $created = $true
  $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  if (-not (Get-LocalGroupMember -SID $usersSid | Where-Object { $_.SID -eq $user.SID })) { Add-LocalGroupMember -SID $usersSid -Member $user }
  $otherSid = $user.SID
  [PrivacyProbe]::EnableRestore()
  $token = [PrivacyProbe]::Login($userName, $password)
  $password = $null; $secure = $null
  [void][IO.Directory]::CreateDirectory($work)
  Set-Private $work
  $acl = Get-Acl -LiteralPath $work
  # The second user can read the control and create siblings, but cannot replace private roots.
  $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Write
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($otherSid, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $work -AclObject $acl
  $control = Join-Path $work 'public-control.txt'
  [IO.File]::WriteAllText($control, 'public-control')
  $controlAcl = Get-Acl -LiteralPath $control
  $controlAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($otherSid, 'Read', 'Allow'))
  Set-Acl -LiteralPath $control -AclObject $controlAcl
  Record 'second-user reads public control' ([PrivacyProbe]::Control($token, $control))
  $scenario = Join-Path $work 'fresh'
  [void][IO.Directory]::CreateDirectory($scenario)
  $manifest = Fixture $scenario
  foreach ($root in $manifest.roots) {
    $rootAcl = Get-Acl -LiteralPath $root
    Record 'fresh root has protected DACL' $rootAcl.AreAccessRulesProtected
    Record 'fresh root belongs to current user' ($rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value)
    foreach ($rule in $rootAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      Record 'fresh root grants only current user' ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -eq $identity.User.Value)
    }
  }
  foreach ($artifact in $manifest.artifacts) {
    $actions = if ($artifact.type -eq 'file') { @('read', 'write', 'delete-file') } else { @('create', 'rename', 'delete-directory') }
    foreach ($action in $actions) { Record "second-user denied $action $($artifact.path.Substring($work.Length))" ([PrivacyProbe]::Denied($token, $artifact.path, $action)) }
  }
  foreach ($case in @('broad-child', 'foreign-owner', 'null-dacl', 'junction')) {
    $unsafe = Join-Path $work $case
    [void][IO.Directory]::CreateDirectory($unsafe); Set-Private $unsafe
    $sentinel = Join-Path $unsafe 'sentinel.txt'; [IO.File]::WriteAllText($sentinel, 'unchanged-synthetic')
    switch ($case) {
      'broad-child' {
        $acl = Get-Acl $sentinel
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($otherSid, 'Read', 'Allow'))
        Set-Acl -LiteralPath $sentinel -AclObject $acl
      }
      'foreign-owner' { $acl = Get-Acl $unsafe; $acl.SetOwner($otherSid); Set-Acl -LiteralPath $unsafe -AclObject $acl }
      'null-dacl' {
        $acl = Get-Acl $unsafe
        $acl.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL', [Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $unsafe -AclObject $acl
      }
      'junction' { [void](New-Item -ItemType Junction -Path (Join-Path $unsafe 'linked') -Target $scenario) }
    }
    $before = (Get-Acl -LiteralPath $unsafe).Sddl
    $sentinelAcl = (Get-Acl -LiteralPath $sentinel).Sddl
    $entries = @(Get-ChildItem -LiteralPath $unsafe -Force).Count
    $result = Fixture $unsafe 'reject'
    Record "refuses $case in fresh process" ($result.rejected -eq $true)
    Record "preserves $case content and ACL" (([IO.File]::ReadAllText($sentinel) -eq 'unchanged-synthetic') -and ((Get-Acl -LiteralPath $sentinel).Sddl -eq $sentinelAcl) -and ((Get-Acl -LiteralPath $unsafe).Sddl -eq $before) -and (@(Get-ChildItem -LiteralPath $unsafe -Force).Count -eq $entries))
  }
  $cliBase = Join-Path $work 'cli-refusal'
  $cliRoot = Join-Path $cliBase 'good-gh'
  [void][IO.Directory]::CreateDirectory($cliRoot); Set-Private $cliRoot
  $cliConfig = Join-Path $cliRoot 'config.json'
  [IO.File]::WriteAllText($cliConfig, '{"first_run_completed":true}')
  $cliAcl = Get-Acl -LiteralPath $cliConfig
  $cliAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($otherSid, 'Read', 'Allow'))
  Set-Acl -LiteralPath $cliConfig -AclObject $cliAcl
  $cliPlugins = Join-Path $cliRoot 'plugins'
  [void][IO.Directory]::CreateDirectory($cliPlugins)
  [IO.File]::WriteAllText((Join-Path $cliPlugins 'manifest.json'), '[]')
  $beforeCli = (Get-Acl -LiteralPath $cliConfig).Sddl
  $cliResult = Fixture $cliRoot 'reject-cli'
  Record 'unsafe config returns one structured agent failure' ($cliResult.rejected -eq $true)
  Record 'unsafe config is not rewritten' ((Get-Acl -LiteralPath $cliConfig).Sddl -eq $beforeCli -and [IO.File]::ReadAllText($cliConfig) -eq '{"first_run_completed":true}')
  $receipt.passed = $true
} catch {
  $receipt.error = $_.Exception.Message
  throw
} finally {
  if ($null -ne $token) { $token.Dispose() }
  $accountCleanupError = $null
  if ($created) {
    try { Remove-LocalUser -Name $userName -ErrorAction Stop; $receipt.accountRemoved = $true }
    catch { $accountCleanupError = $_; $receipt.accountRemoved = $false; $receipt.passed = $false }
  }
  $password = $null
  if (Test-Path $work) {
    # Remove reparse points before recursive cleanup so their targets are untouched.
    Get-ChildItem -LiteralPath $work -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object { [IO.Directory]::Delete($_.FullName) }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
  $receipt.sourceFiles = @(Get-ChildItem (Join-Path $ProjectRoot 'src'), (Join-Path $ProjectRoot 'scripts') -Recurse -File | Where-Object { $_.Extension -in @('.ts', '.ps1') } | Sort-Object FullName | ForEach-Object { @{ path = [IO.Path]::GetRelativePath($ProjectRoot, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
  $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultsFile -Encoding utf8
  if ($accountCleanupError) { throw 'Temporary account removal failed. See runner account management before reuse.' }
}
