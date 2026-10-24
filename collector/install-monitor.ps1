$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'CrashHistoryMonitor'
$action = "wscript.exe `"$root\watchdog-hidden.vbs`""
& schtasks.exe /Create /TN $taskName /SC MINUTE /MO 1 /TR $action /F
if ($LASTEXITCODE -ne 0) { throw "Não foi possível criar a tarefa '$taskName'." }
Write-Host "Monitor criado: $taskName"
