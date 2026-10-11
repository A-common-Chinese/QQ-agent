# Stop QQ Agent DSH and its bundled SnowLuma.
# ASCII-only on purpose: Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI,
# so non-ASCII comments would break the parser (it happened before on this box).
#
# Used by the scheduled task "QQ Agent DSH - Stop nightly (Sun-Thu 23:20)",
# and safe to run by hand.
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent DSH'),
  [int]$GracefulWaitSec = 8,
  [switch]$Quick,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'qq-agent-scheduler.log' }

function Write-Log([string]$Message) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

$exe = Join-Path $AppDir 'QQ Agent DSH.exe'
$snowDir = Join-Path $AppDir 'resources\app\snowluma'
Write-Log '--- stop requested ---'
if (-not (Test-Path $exe)) { Write-Log ('WARN app not found: ' + $exe) }

# 0) Switch the QQ online status to "do not disturb" BEFORE killing the bot.
#    Why a script and not just the plugin hook: the force-stop below runs no JS at all,
#    so a plugin can never observe that shutdown. Best effort, short timeout - it must
#    never delay the shutdown (with -Quick the GPO shutdown path is waiting on us).
$presenceTimeout = if ($Quick) { 2 } else { 3 }
try {
  $presence = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/presence' -Method Post `
    -ContentType 'application/json; charset=utf-8' -Body '{"status":"dnd"}' -TimeoutSec $presenceTimeout
  Write-Log ('presence -> dnd (status=' + $presence.status + ')')
} catch {
  Write-Log ('presence -> dnd skipped (best effort): ' + $_.Exception.Message)
}

# 1) Ask the app to close itself first (it is a tray app, so this may just minimize;
#    that is fine - step 2 force-stops whatever is left).
$apps = @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue)
Write-Log ('QQ Agent DSH processes before: ' + $apps.Count)
foreach ($p in $apps) { try { [void]$p.CloseMainWindow() } catch { } }
if ($apps.Count -gt 0) {
  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $GracefulWaitSec))
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
}
foreach ($p in @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue)) {
  Write-Log ('force stop QQ Agent DSH pid=' + $p.Id)
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
}

# 2) SnowLuma: normally a child of the app, but it can survive the parent, so stop it
#    explicitly. Matched by the install-dir path in its command line.
$snow = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*' + $snowDir + '*') -or $_.CommandLine -like '*snowluma*index.mjs*') })
Write-Log ('SnowLuma processes: ' + $snow.Count)
foreach ($p in $snow) {
  Write-Log ('stop snowluma pid=' + $p.ProcessId)
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
}

# 3) Verify the ports the bot uses are released. Skipped with -Quick (used by the
#    Group Policy shutdown script, where every second of shutdown time counts).
if (-not $Quick) {
  Start-Sleep -Seconds 2
  foreach ($port in 3210, 3000, 3001, 5099) {
    $conn = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($conn.Count -gt 0) {
      Write-Log ('WARN port ' + $port + ' still listening (pid ' + (($conn | ForEach-Object { $_.OwningProcess }) -join ',') + ')')
    } else {
      Write-Log ('port ' + $port + ' free')
    }
  }
}
$left = @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue).Count
Write-Log ('--- stop done, app processes left=' + $left + ' ---')
exit 0
