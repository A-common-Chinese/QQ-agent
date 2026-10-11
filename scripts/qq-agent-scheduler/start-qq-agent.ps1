# Start QQ Agent DSH once the network is REALLY usable (captive-portal aware).
# ASCII-only on purpose (Windows PowerShell 5.1 parses BOM-less .ps1 as ANSI).
#
# Why not a plain TCP probe: a campus network with a captive portal (manual web login)
# happily completes TCP handshakes - and often plain HTTP - while there is no internet
# until you log in. So this script verifies CONTENT:
#   1) http://www.msftconnecttest.com/connecttest.txt must return the expected text
#      (Windows' own "no portal" probe; a portal answers with its login page instead)
#   2) fallback: a real TLS request to a public API must complete
#
# The scheduled task also repeats every few minutes for hours, so whenever you finish
# the campus login the bot still comes up by itself.
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\QQ Agent DSH'),
  [int]$WaitNetworkSec = 180,
  [int]$PollSec = 10,
  [switch]$CheckOnly,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'qq-agent-scheduler.log' }

function Write-Log([string]$Message) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Test-RealInternet {
  # Returns a hashtable: @{ ok = bool; how = string; detail = string }
  try {
    $r = Invoke-WebRequest -Uri 'http://www.msftconnecttest.com/connecttest.txt' -UseBasicParsing -TimeoutSec 6
    $body = ''
    if ($r.Content) { $body = [string]$r.Content }
    if ($r.StatusCode -eq 200 -and $body -match 'Microsoft Connect Test') {
      return @{ ok = $true; how = 'msftconnecttest'; detail = 'content verified' }
    }
    $snippet = ($body -replace '\s+', ' ')
    if ($snippet.Length -gt 80) { $snippet = $snippet.Substring(0, 80) }
    $first = @{ ok = $false; how = 'msftconnecttest'; detail = ('status=' + $r.StatusCode + ' body=' + $snippet) }
  } catch {
    $first = @{ ok = $false; how = 'msftconnecttest'; detail = $_.Exception.Message }
  }

  # Fallback: a portal cannot complete a real TLS exchange with the origin server.
  try {
    $r2 = Invoke-WebRequest -Uri 'https://api.deepseek.com/' -Method Head -UseBasicParsing -TimeoutSec 8
    if ($r2.StatusCode -ge 200) {
      return @{ ok = $true; how = 'tls-api'; detail = ('status=' + $r2.StatusCode) }
    }
    return @{ ok = $false; how = 'tls-api'; detail = ('status=' + $r2.StatusCode + ' | first: ' + $first.detail) }
  } catch {
    $msg = $_.Exception.Message
    return @{ ok = $false; how = 'none'; detail = ('first=' + $first.detail + ' | tls="' + $msg + '"') }
  }
}

if ($CheckOnly) {
  $r = Test-RealInternet
  Write-Host ('real internet = ' + $r.ok + '  via=' + $r.how + '  detail=' + $r.detail)
  if ($r.ok) { exit 0 } else { exit 2 }
}

$exe = Join-Path $AppDir 'QQ Agent DSH.exe'
Write-Log '--- start requested ---'
if (-not (Test-Path $exe)) {
  Write-Log ('ERROR app not found: ' + $exe)
  exit 1
}

$running = @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue).Count
if ($running -gt 0) {
  Write-Log ('already running (' + $running + ' processes), nothing to do')
  exit 0
}

$deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitNetworkSec))
$attempt = 0
while ($true) {
  $attempt++
  $net = Test-RealInternet
  if ($net.ok) { Write-Log ('real internet OK after ' + $attempt + ' probe(s) via ' + $net.how); break }
  if ((Get-Date) -ge $deadline) {
    Write-Log ('still not online after ' + $WaitNetworkSec + 's (' + $net.detail + '); leaving it to the next retry')
    exit 0   # the task repeats every few minutes, so a later run starts it after you log in
  }
  Write-Log ('waiting for real internet: ' + $net.detail)
  Start-Sleep -Seconds ([Math]::Max(3, $PollSec))
}

function Start-AppDetached([string]$ExePath, [string]$WorkingDir) {
  # Task Scheduler reclaims the task's whole process tree when the task instance ends,
  # so a plain Start-Process child can be killed right after the task finishes.
  # A WMI-created process belongs to WmiPrvSE and outlives the task.
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = ('"' + $ExePath + '"')
      CurrentDirectory = $WorkingDir
    }
    if ($result.ReturnValue -eq 0) {
      Write-Log ('launched via WMI, pid=' + $result.ProcessId)
      return $true
    }
    Write-Log ('WMI create returned ' + $result.ReturnValue + ', falling back')
  } catch {
    Write-Log ('WMI create failed: ' + $_.Exception.Message)
  }
  try { & explorer.exe $ExePath; Write-Log 'launched via explorer'; return $true } catch { }
  try { Start-Process -FilePath $ExePath -WorkingDirectory $WorkingDir; Write-Log 'launched via Start-Process'; return $true } catch { }
  return $false
}

if (-not (Start-AppDetached -ExePath $exe -WorkingDir $AppDir)) {
  Write-Log 'ERROR could not launch the app'
  exit 1
}
Start-Sleep -Seconds 5
Write-Log ('started: processes now=' + @(Get-Process -Name 'QQ Agent DSH' -ErrorAction SilentlyContinue).Count)

for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3210/api/status' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      $json = $r.Content | ConvertFrom-Json
      Write-Log ('console ready: onebot.connected=' + $json.onebot.connected + ' snowluma.running=' + $json.snowluma.running)
      exit 0
    }
  } catch { }
  Start-Sleep -Seconds 2
}
Write-Log 'WARN console did not answer within 60s (it may still be starting)'
exit 0
