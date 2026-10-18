param(
  [string]$DataDirectory = "$PSScriptRoot\data",
  [int]$ChunkSize = 80
)

# Caminho rápido: envia somente rodadas novas. A reconstrução histórica fica
# fora do fluxo ao vivo; assim, uma rodada não espera a releitura de todo CSV.
$ErrorActionPreference = 'Stop'
# A sessão da VPS herda um proxy local inexistente (127.0.0.1:9). Remover
# apenas no processo do coletor preserva as configurações globais da máquina
# e permite a conexão HTTPS direta com o Supabase.
foreach ($proxyVariable in 'ALL_PROXY','HTTP_PROXY','HTTPS_PROXY','all_proxy','http_proxy','https_proxy') {
  Remove-Item "Env:$proxyVariable" -ErrorAction SilentlyContinue
}
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'supabase-sync.json') -Raw | ConvertFrom-Json
$syncedPath = Join-Path $DataDirectory 'supabase-synced-ids.txt'
$lockPath = Join-Path $DataDirectory 'supabase-live-sync.lock'
$statusPath = Join-Path $DataDirectory 'supabase-live-sync-status.json'
# Um processo encerrado inesperadamente pode deixar uma trava vazia. Ela não
# representa um envio em curso depois de cinco minutos; removê-la aqui evita
# que o painel fique congelado sem afetar o coletor ou o Chrome.
if (Test-Path -LiteralPath $lockPath) {
  $lockAge = ([DateTime]::UtcNow - (Get-Item -LiteralPath $lockPath).LastWriteTimeUtc).TotalMinutes
  if ($lockAge -gt 5) {
    Remove-Item -LiteralPath $lockPath -Force
  }
}
$lock = $null
try {
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
} catch {
  [pscustomobject]@{ sent = 0; skipped = 'live sync already running' } | ConvertTo-Json -Compress
  exit 0
}
$lock.Dispose()

try {
  $synced = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  if (Test-Path -LiteralPath $syncedPath) {
    Get-Content -LiteralPath $syncedPath | ForEach-Object { [void]$synced.Add([string]$_) }
  }
  $latest = Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $latest) { throw 'Nenhum CSV de rodadas encontrado.' }

  # O painel calcula os indicadores de apresentação a partir do próprio
  # histórico. Estes dois campos ficam neutros na primeira gravação e podem
  # ser recalculados pelo sincronizador histórico sem travar a transmissão.
  $pending = @(Import-Csv -LiteralPath $latest.FullName | Where-Object {
    $_.round_id -match '^\d{7}$' -and -not $synced.Contains([string]$_.round_id)
  } | Sort-Object { [Int64]$_.round_id } | ForEach-Object {
    [pscustomobject]@{
      round_id = [Int64]$_.round_id
      multiplier = [decimal](($_.multiplier -replace ',', '.'))
      captured_at = [string]$_.captured_at
      source = if ($_.source) { [string]$_.source } else { 'collector' }
      signal_before = 'indeterminado'
      cycle_zone = 'indeterminado'
    }
  })
  if ($pending.Count) {
    $headers = @{ apikey = $config.publishableKey; Authorization = "Bearer $($config.publishableKey)"; 'Content-Type' = 'application/json' }
    for ($offset = 0; $offset -lt $pending.Count; $offset += $ChunkSize) {
      $end = [Math]::Min($offset + $ChunkSize - 1, $pending.Count - 1)
      $chunk = @($pending[$offset..$end])
      $body = @{ p_token = $config.collectorToken; p_rows = $chunk } | ConvertTo-Json -Compress -Depth 5
      [void](Invoke-RestMethod -Method Post -Uri "$($config.projectUrl)/rest/v1/rpc/$($config.rpc)" -Headers $headers -Body $body -TimeoutSec 15)
      $chunk.round_id | Add-Content -LiteralPath $syncedPath -Encoding utf8
      foreach ($row in $chunk) { [void]$synced.Add([string]$row.round_id) }
    }
  }
  $runtimeStatusPath = Join-Path $DataDirectory 'runtime-status-v2.json'
  $runtimeSent = $false
  if (Test-Path -LiteralPath $runtimeStatusPath) {
    try {
      $pythonResult = & python (Join-Path $PSScriptRoot 'sync-runtime-supabase.py') $PSScriptRoot $runtimeStatusPath 2>&1
      if ($LASTEXITCODE -ne 0) { throw ($pythonResult -join "`n") }
      $runtimeSent = [bool](($pythonResult | Select-Object -Last 1 | ConvertFrom-Json).runtime_sent)
    } catch {
      $runtimeError = $_.Exception.Message
    }
  }
  $result = [pscustomobject]@{ completed_at_utc = [DateTime]::UtcNow.ToString('o'); sent = $pending.Count; runtime_sent = $runtimeSent; runtime_error = $runtimeError; latest_csv = $latest.Name; mode = 'incremental' }
  $result | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
  $result | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
