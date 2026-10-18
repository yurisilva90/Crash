$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'CrashHistoryCollector'
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\receiver.ps1`""
& schtasks.exe /Create /TN $taskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $command /F | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Não foi possível criar a tarefa '$taskName'. Execute este script em um PowerShell elevado ou peça ao administrador do VPS para liberá-la."
}
Write-Host "Tarefa '$taskName' criada. Reinicie o VPS ou execute receiver.ps1 para iniciar agora."
