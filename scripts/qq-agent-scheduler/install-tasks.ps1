# Register the scheduled tasks that keep QQ Agent DSH on your rhythm.
# ASCII-only on purpose (see stop-qq-agent.ps1).
#
#   QQ Agent DSH - Start on logon (network ready)   at logon (optionally + daily),
#                                                   waits for REAL internet, retries
#   QQ Agent DSH - Stop nightly (Sun-Thu)           weekly Sun/Mon/Tue/Wed/Thu at -StopAt
#   QQ Agent DSH - Session-end hook                 hidden watcher started at logon that
#                                                   stops the app+SnowLuma on shutdown/logoff
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File install-tasks.ps1
# No admin rights needed (tasks run as the current user, interactive).
param(
  [string]$ScriptDir = $PSScriptRoot,
  [string]$TaskStartName = 'QQ Agent DSH - Start on logon (network ready)',
  [string]$TaskStopName = 'QQ Agent DSH - Stop nightly (Sun-Thu)',
  [string]$TaskHookName = 'QQ Agent DSH - Session-end hook',
  [string]$StopAt = '23:20',
  [switch]$AddMorningStart,
  [string]$MorningAt = '08:00',
  [int]$RetryEveryMin = 10,
  [int]$RetryForHours = 3,
  [switch]$NoShutdownHook
)

$ErrorActionPreference = 'Stop'
$user = ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hiddenLauncher = Join-Path $ScriptDir 'run-hidden.vbs'
$startScript = Join-Path $ScriptDir 'start-qq-agent.ps1'
$stopScript = Join-Path $ScriptDir 'stop-qq-agent.ps1'
$hookScript = Join-Path $ScriptDir 'watch-shutdown.ps1'

# -At on a weekly/daily trigger needs a real DateTime ('23:20' as a string throws
# "The parameter is incorrect" / HRESULT 0x80070057).
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$stopTime = [datetime]::ParseExact($StopAt, 'HH:mm', $invariant)
$morningTime = [datetime]::ParseExact($MorningAt, 'HH:mm', $invariant)

foreach ($f in @($powershell, $wscript, $hiddenLauncher, $startScript, $stopScript, $hookScript)) {
  if (-not (Test-Path $f)) { throw ('missing: ' + $f) }
}

function New-Action([string]$ScriptPath) {
  # Launch PowerShell through wscript + run-hidden.vbs:
  # powershell.exe flashes a console window even with -WindowStyle Hidden (reported by the user
  # as a cmd window popping up and interrupting work); wscript is GUI-subsystem: no console at all.
  return New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}" "{1}"' -f $hiddenLauncher, $ScriptPath)
}
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# ---------------------------------------------------------------- start task
# Retry every few minutes for hours: on a captive-portal network the bot can only come up
# after you finish the web login, which may be minutes (or much longer) after logon.
$repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $RetryEveryMin) `
  -RepetitionDuration (New-TimeSpan -Hours $RetryForHours)).Repetition

$startTriggers = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
# Only the logon trigger gets repetition: two triggers each repeating meant two runs per 5 min
# (confirmed in the log). The daily trigger runs once - enough as a morning fallback.
$startTriggers[0].Repetition = $repetition
if ($AddMorningStart) { $startTriggers += New-ScheduledTaskTrigger -Daily -At $morningTime }

$startSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RunOnlyIfNetworkAvailable

Register-ScheduledTask -TaskName $TaskStartName `
  -Action (New-Action $startScript) -Trigger $startTriggers -Settings $startSettings -Principal $principal `
  -Description ('Start QQ Agent DSH after logon once there is REAL internet (captive-portal aware). Retries every ' + $RetryEveryMin + ' min for ' + $RetryForHours + ' h. Skips if already running.') `
  -Force | Out-Null

# ---------------------------------------------------------------- stop task
$stopTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday, Monday, Tuesday, Wednesday, Thursday -At $stopTime
$stopSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $TaskStopName `
  -Action (New-Action $stopScript) -Trigger $stopTrigger -Settings $stopSettings -Principal $principal `
  -Description ('Stop QQ Agent DSH and its SnowLuma at ' + $StopAt + ' (Sunday-Thursday night). A missed start does not run later.') `
  -Force | Out-Null

# ---------------------------------------------------------------- session-end hook
if (-not $NoShutdownHook) {
  $hookTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $hookSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -Hidden `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # long-running watcher
  Register-ScheduledTask -TaskName $TaskHookName `
    -Action (New-Action $hookScript) -Trigger $hookTrigger -Settings $hookSettings -Principal $principal `
    -Description 'Hidden watcher: on shutdown/restart/logoff it stops QQ Agent DSH and SnowLuma before Windows ends the session.' `
    -Force | Out-Null
}

Write-Host ''
Write-Host 'Registered:'
$names = @($TaskStartName, $TaskStopName)
if (-not $NoShutdownHook) { $names += $TaskHookName }
Get-ScheduledTask -TaskName $names | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo
  Write-Host ('  ' + $_.TaskName)
  Write-Host ('    state=' + $_.State + '  nextRun=' + $info.NextRunTime + '  lastRun=' + $info.LastRunTime + '  lastResult=' + $info.LastTaskResult)
}
Write-Host ''
Write-Host ('Scripts in: ' + $ScriptDir)
Write-Host ('Log: ' + (Join-Path $ScriptDir 'qq-agent-scheduler.log'))
Write-Host ''
Write-Host 'Tip: check the captive-portal probe any time with:'
Write-Host ('  powershell -NoProfile -ExecutionPolicy Bypass -File "' + $startScript + '" -CheckOnly')
