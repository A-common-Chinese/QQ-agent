' Window-less launcher for one PowerShell script file.
'
' Why this file exists: a scheduled task that runs powershell.exe (even with
' -WindowStyle Hidden) still creates a console window that flashes on screen.
' wscript.exe is a GUI-subsystem binary, so it never creates a console at all,
' and Run(..., 0, ...) makes the child window hidden too.
'
' Usage:  wscript.exe run-hidden.vbs "C:\path\to\script.ps1" [extra args...]
'
' NOTE: kept ASCII-only on purpose - wscript reads .vbs as ANSI unless it has a
' UTF-16 BOM, so non-ASCII characters here could break parsing (same trap as .ps1).
Option Explicit

Dim shell, args, cmd, i
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count = 0 Then
  WScript.Quit 2
End If

cmd = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File"
For i = 0 To args.Count - 1
  cmd = cmd & " """ & args(i) & """"
Next

' 0 = hidden window, False = do not wait for it to finish
shell.Run cmd, 0, False
WScript.Quit 0
