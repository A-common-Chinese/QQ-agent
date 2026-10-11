# Remove the two scheduled tasks registered by install-tasks.ps1.
# ASCII-only on purpose (see stop-qq-agent.ps1).
param(
  [string]$TaskStartName = 'QQ Agent DSH - Start on logon (network ready)',
  [string]$TaskStopName = 'QQ Agent DSH - Stop nightly (Sun-Thu)'
)

foreach ($name in @($TaskStartName, $TaskStopName)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host ('removed: ' + $name)
  } else {
    Write-Host ('not found: ' + $name)
  }
}
Write-Host 'Done. (QQ Agent itself is untouched; stop it by hand if you want.)'
