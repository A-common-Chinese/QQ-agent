# Shutdown / logoff hook: stop QQ Agent DSH and SnowLuma BEFORE Windows tears the
# session down. ASCII-only on purpose (see stop-qq-agent.ps1).
#
# Registered by install-tasks.ps1 as a hidden task triggered at logon, so it lives for
# the whole session. Two signals are watched:
#   1) Microsoft.Win32.SystemEvents.SessionEnding  (shutdown, restart, logoff)
#   2) a 1s poll of [System.Environment]::HasShutdownStarted (belt and braces)
#
# On fire it kills the app IN-PROCESS: during shutdown Windows only grants a few seconds
# (WaitToKillAppTimeout) and spawning a child powershell is not reliable there.
#
# -TestFire runs the same stop routine immediately and exits (used for verification).
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent DSH'),
  [switch]$TestFire,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'qq-agent-scheduler.log' }
$script:fired = $false

function Write-Log([string]$Message) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Stop-QQAgentFast([string]$Reason) {
  if ($script:fired) { return }
  $script:fired = $true
  Write-Log ('--- session ending (' + $Reason + '): stopping QQ Agent + SnowLuma ---')
  $killed = 0
  foreach ($p in @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue)) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $killed++ } catch { }
  }
  $snowDir = Join-Path $AppDir 'resources\app\snowluma'
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $snowDir + '*') })) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ } catch { }
  }
  Write-Log ('--- fast stop done, processes killed=' + $killed + ' ---')
}

if ($TestFire) {
  Write-Log '--- test fire requested ---'
  Stop-QQAgentFast 'test'
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms

# Signal 1: session ending, delivered through the message pump.
[Microsoft.Win32.SystemEvents]::add_SessionEnding({ Stop-QQAgentFast 'SessionEnding' })

# Signal 2: polling fallback (cheap, and survives a missed window message).
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ if ([System.Environment]::HasShutdownStarted) { Stop-QQAgentFast 'HasShutdownStarted' } })
$timer.Start()

$exe = Join-Path $AppDir 'QQ Agent DSH.exe'
Write-Log ('shutdown watcher started (app=' + (Test-Path $exe) + ', pid=' + $PID + ')')

# Message loop keeps this process alive and lets SystemEvents deliver callbacks.
[System.Windows.Forms.Application]::Run()
Write-Log 'shutdown watcher exited'
