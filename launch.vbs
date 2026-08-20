' launch.vbs
' Punto de entrada para doble click: ejecuta launch.ps1 sin mostrar ninguna
' ventana de consola (ni de PowerShell ni del servidor).

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\launch.ps1"""
shell.Run cmd, 0, False
