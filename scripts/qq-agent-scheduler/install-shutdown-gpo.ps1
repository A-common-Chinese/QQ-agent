# Install (or remove) a LOCAL GROUP POLICY shutdown script that stops QQ Agent DSH and
# SnowLuma synchronously before Windows finishes shutting down.
#
# Why this in addition to the session-end watcher: Group Policy shutdown scripts are run
# by the Group Policy engine and Windows WAITS for them (up to MaxGPOScriptWait, which we
# raise to 120s here). The watcher covers logoff and shutdown quickly; this covers
# shutdown with a real guarantee.
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI).
#
# Run (double-click is fine, it elevates itself):
#   install-shutdown-gpo.cmd                 or
#   powershell -ExecutionPolicy Bypass -File install-shutdown-gpo.ps1
# Remove:
#   powershell -ExecutionPolicy Bypass -File install-shutdown-gpo.ps1 -Uninstall
param(
  [string]$ScriptDir = $PSScriptRoot,
  [switch]$Uninstall,
  [switch]$NoSelfElevate,
  [int]$MaxScriptWaitSec = 120
)

$ErrorActionPreference = 'Stop'

$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($NoSelfElevate) {
    Write-Host 'ERROR: this script must run as administrator.' -ForegroundColor Red
    exit 1
  }
  Write-Host 'Requesting administrator rights (confirm the UAC prompt)...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  if ($Uninstall) { $argList += '-Uninstall' }
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs | Out-Null
    exit 0
  } catch {
    Write-Host ('elevation failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
  }
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stopScript = Join-Path $ScriptDir 'stop-qq-agent.ps1'
$logFile = Join-Path $ScriptDir 'qq-agent-scheduler.log'
# CRITICAL: computer shutdown scripts run as SYSTEM, so the script's own default
# (%LOCALAPPDATA%\Programs\QQ Agent DSH) would resolve to SYSTEM's profile and find
# nothing. Bake the installing user's absolute path into the parameters.
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent DSH'
$iniPath = Join-Path $env:SystemRoot 'System32\GroupPolicy\Machine\Scripts\scripts.ini'
$scriptKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Shutdown\0\0'
$stateKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\State\Machine\Scripts\Shutdown\0\0'
$policyKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$localGpoId = '{35378EAC-683F-11D2-A89A-00C04FBBCFA2}'   # Local Computer Policy

$params = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AppDir "{1}" -GracefulWaitSec 0 -Quick -LogFile "{2}"' -f $stopScript, $appDir, $logFile)

Write-Host ('QQ Agent DSH shutdown hook (Group Policy)')
Write-Host ('  action : ' + $psExe)
Write-Host ('  args   : ' + $params)
if (-not (Test-Path (Join-Path $appDir 'QQ Agent DSH.exe'))) {
  Write-Host ('  WARN: app not found under ' + $appDir) -ForegroundColor Yellow
}
Write-Host ''

# ---------------------------------------------------------------- scripts.ini
if (-not (Test-Path $iniPath)) { New-Item -Path (Split-Path $iniPath) -ItemType Directory -Force | Out-Null }
$lines = @()
if (Test-Path $iniPath) { $lines = @(Get-Content -LiteralPath $iniPath) }
# drop our old entry (and any stale index 0 of [Shutdown]) but keep everything else
$kept = New-Object System.Collections.Generic.List[string]
$inShutdown = $false
foreach ($line in $lines) {
  if ($line -match '^\s*\[(.+)\]\s*$') { $inShutdown = ($matches[1] -ieq 'Shutdown') }
  if ($inShutdown -and $line -match '^\s*0(CmdLine|Parameters)\s*=') { continue }
  if ($inShutdown -and $line -match '^\s*$' -and $kept.Count -gt 0) { continue }
  $kept.Add($line)
}
if (-not ($kept | Where-Object { $_ -match '^\s*\[Shutdown\]\s*$' })) { $kept.Add('[Shutdown]') }

if (-not $Uninstall) {
  $kept.Add(('0CmdLine=' + $psExe))
  $kept.Add(('0Parameters=' + $params))
}
[System.IO.File]::WriteAllLines($iniPath, $kept.ToArray(), (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- registry (applied policy)
if ($Uninstall) {
  foreach ($key in @($scriptKey, $stateKey)) {
    if (Test-Path $key) { Remove-Item -LiteralPath $key -Recurse -Force }
  }
  # tidy up now-empty parent containers
  foreach ($parent in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Shutdown',
                        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\State\Machine\Scripts\Shutdown')) {
    if (Test-Path $parent) {
      $kids = @(Get-ChildItem $parent -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 0) { Remove-Item -LiteralPath $parent -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }
  Remove-ItemProperty -Path $policyKey -Name MaxGPOScriptWait -ErrorAction SilentlyContinue
} else {
  New-Item -Path $scriptKey -Force | Out-Null
  Set-ItemProperty -Path $scriptKey -Name Script -Value $psExe
  Set-ItemProperty -Path $scriptKey -Name Parameters -Value $params

  New-Item -Path $stateKey -Force | Out-Null
  Set-ItemProperty -Path $stateKey -Name Script -Value $psExe
  Set-ItemProperty -Path $stateKey -Name Parameters -Value $params
  Set-ItemProperty -Path $stateKey -Name DisplayName -Value 'QQ Agent DSH - stop before shutdown'
  Set-ItemProperty -Path $stateKey -Name GPOId -Value $localGpoId
  Set-ItemProperty -Path $stateKey -Name GPOName -Value 'Local Group Policy'
  Set-ItemProperty -Path $stateKey -Name ExecTime -Value 0 -Type DWord

  # Windows waits this long for GP scripts; ours takes ~1s. (0 would mean "do not wait")
  Set-ItemProperty -Path $policyKey -Name MaxGPOScriptWait -Value $MaxScriptWaitSec -Type DWord
}

# ---------------------------------------------------------------- apply + verify
Write-Host 'Running gpupdate /target:computer /force ...'
& gpupdate.exe /target:computer /force 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }

Write-Host ''
Write-Host '--- scripts.ini ---'
Get-Content -LiteralPath $iniPath | ForEach-Object { Write-Host ('  ' + $_) }

Write-Host '--- applied policy (registry) ---'
foreach ($key in @($scriptKey, $stateKey)) {
  if (Test-Path $key) {
    $v = Get-ItemProperty -Path $key
    Write-Host ('  ' + $key)
    Write-Host ('    Script     = ' + $v.Script)
    Write-Host ('    Parameters = ' + $v.Parameters)
  } else {
    Write-Host ('  ' + $key + '  -> not present')
  }
}
$wait = (Get-ItemProperty -Path $policyKey -Name MaxGPOScriptWait -ErrorAction SilentlyContinue).MaxGPOScriptWait
Write-Host ('  MaxGPOScriptWait = ' + $wait)

Write-Host ''
if ($Uninstall) {
  Write-Host 'Removed. The next shutdown will not run the hook.' -ForegroundColor Yellow
} else {
  Write-Host 'Installed.' -ForegroundColor Green
  Write-Host 'Proof on the next real shutdown: this log gets a fresh timestamped line:'
  Write-Host ('  ' + $logFile)
  Write-Host '  --- stop requested ---  /  --- stop done, app processes left=0 ---'
}
Write-Host ''
