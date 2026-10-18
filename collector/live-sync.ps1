param(
  [string]$DataDirectory = "$PSScriptRoot\data",
  [int]$IntervalSeconds = 2
)

# Mantém o Supabase próximo do receptor sem criar um processo por rodada.
# Há apenas este sincronizador persistente; o watchdog o religa se ele cair.
while ($true) {
  try {
    & (Join-Path $PSScriptRoot 'sync-live-supabase.ps1') -DataDirectory $DataDirectory | Out-Null
  } catch { }
  Start-Sleep -Seconds $IntervalSeconds
}
