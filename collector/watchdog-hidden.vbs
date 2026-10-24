Option Explicit

' Executado pelo Agendador a cada minuto. O WScript não cria console; assim o
' watchdog continua em segundo plano sem a janela azul piscando sobre a VPS.
Dim shell, fso, root, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & root & "\watchdog.ps1" & Chr(34)
shell.Run command, 0, False
