# Delete the leftover probe tasks that the Steam++ guard plugin created.
#
# Why a separate elevated script: those probe tasks were registered with
# RunLevel = Highest, so modifying/removing them is denied to a non-elevated
# process (Unregister-ScheduledTask -> "Access denied").
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses a BOM-less .ps1 as ANSI,
# so non-ASCII comments could break parsing (that already bit us once).
#
# We deliberately KEEP "dsh-steampp-github-guard-launch": it is the task the
# guard's README recommends, and it starts Steam++ at logon (state was Running).
param(
  [string]$Pattern = 'dsh-guard-missing-*',
  [string]$LogFile = ''
)
$ErrorActionPreference = 'Continue'
if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot 'clean-guard-tasks.log' }

function Write-Log([string]$Message) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

$elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Log ('--- cleanup requested (elevated=' + $elevated + ', pattern=' + $Pattern + ') ---')

$targets = @(Get-ScheduledTask | Where-Object { $_.TaskName -like $Pattern })
Write-Log ('matched ' + $targets.Count + ' task(s)')

$removed = 0
foreach ($t in $targets) {
  try {
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop
    $removed += 1
    Write-Log ('removed ' + $t.TaskName)
  } catch {
    Write-Log ('FAILED ' + $t.TaskName + ' -> ' + $_.Exception.Message)
  }
}

$left = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'dsh-guard-*' -or $_.TaskName -like 'dsh-steampp-*' })
Write-Log ('done: removed=' + $removed + ', left=' + $left.Count + ' [' + (($left | ForEach-Object { $_.TaskName }) -join ', ') + ']')
