param(
  [string]$InputCsv = '',
  [string]$DataDirectory = "$PSScriptRoot\data",
  [int]$ChunkSize = 400,
  [switch]$IncludePreviouslySynced,
  [switch]$FullHistory
)

# Compatibilidade com o processo live-sync já aberto: ele chama este arquivo
# em cada volta. A partir daqui, o caminho normal delega para o envio leve,
# sem precisar encerrar Chrome nem aguardar um reinício da VPS.
if (-not $FullHistory -and -not $IncludePreviouslySynced) {
  & (Join-Path $PSScriptRoot 'sync-live-supabase.ps1') -DataDirectory $DataDirectory
  exit $LASTEXITCODE
}

$ErrorActionPreference = 'Stop'
foreach ($proxyVariable in 'ALL_PROXY','HTTP_PROXY','HTTPS_PROXY','all_proxy','http_proxy','https_proxy') {
  Remove-Item "Env:$proxyVariable" -ErrorAction SilentlyContinue
}
$configPath = Join-Path $PSScriptRoot 'supabase-sync.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Arquivo supabase-sync.json não encontrado.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$syncedPath = Join-Path $DataDirectory 'supabase-synced-ids.txt'
$lockPath = Join-Path $DataDirectory 'supabase-sync.lock'
$syncStatusPath = Join-Path $DataDirectory 'supabase-sync-status.json'
$lockStream = $null
try {
  $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
} catch {
  [pscustomobject]@{ sent = 0; skipped = 'sync already running' } | ConvertTo-Json -Compress
  exit 0
}
$lockStream.Dispose()
try {
$synced = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
if (-not $IncludePreviouslySynced -and (Test-Path -LiteralPath $syncedPath)) {
  Get-Content -LiteralPath $syncedPath | ForEach-Object { [void]$synced.Add([string]$_) }
}

$paths = if ($InputCsv) { @((Resolve-Path -LiteralPath $InputCsv).Path) } else {
  @(Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File | Sort-Object Name | ForEach-Object FullName)
}

# Os metadados de sinal são derivados da sequência completa disponível no
# coletor, não apenas do lote pendente. Isso impede que uma nova rodada receba
# um estado calculado sem as 1.000 anteriores.
$eligibleIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$hasPendingRows = $IncludePreviouslySynced.IsPresent
foreach ($path in $paths) {
  Import-Csv -LiteralPath $path | ForEach-Object {
    $roundId = [string]$_.round_id
    [void]$eligibleIds.Add($roundId)
    if (-not $synced.Contains($roundId)) { $hasPendingRows = $true }
  }
}

# No fluxo normal o live-sync chama este script a cada poucos segundos. Se não
# entrou rodada nova, não há razão para recalcular as janelas de 250/1.000.
if (-not $hasPendingRows) {
  $result = [pscustomobject]@{
    completed_at_utc = [DateTime]::UtcNow.ToString('o')
    sent = 0
    files = $paths.Count
    destination = $config.projectUrl
  }
  $result | ConvertTo-Json | Set-Content -LiteralPath $syncStatusPath -Encoding utf8
  $result | ConvertTo-Json -Compress
  exit 0
}
$historyPaths = @(Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File | Sort-Object Name | ForEach-Object FullName)
$historyRows = @(foreach ($path in $historyPaths) {
  Import-Csv -LiteralPath $path | ForEach-Object {
    if ([string]$_.round_id -match '^\d{7}$') {
      [pscustomobject]@{
        round_id = [Int64]$_.round_id
        multiplier = [decimal](($_.multiplier -replace ',', '.'))
        captured_at = [string]$_.captured_at
        source = if ($_.source) { [string]$_.source } else { 'collector' }
      }
    }
  }
})
$orderedRows = @($historyRows | Group-Object round_id | ForEach-Object { $_.Group | Select-Object -First 1 } | Sort-Object round_id)
$metadataById = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$previousRound = $null
$misses = 0
$direct = 0
$continuous = 0
$cycleKnown = $false
$short = [Collections.Generic.Queue[int]]::new()
$long = [Collections.Generic.Queue[int]]::new()
$shortHits = 0
$longHits = 0
foreach ($row in $orderedRows) {
  if ($null -eq $previousRound -or $row.round_id -ne ($previousRound + 1)) {
    $misses = 0; $direct = 0; $continuous = 0; $cycleKnown = $false
    $short.Clear(); $long.Clear(); $shortHits = 0; $longHits = 0
  }
  if ($continuous -lt 1000) { $signalBefore = 'indeterminado' }
  else {
    $score = 0
    if ($direct -ge 3) { $score++ }
    if ($short.Count -eq 250 -and $shortHits -ge 9) { $score++ }
    if ($long.Count -eq 1000 -and $longHits -ge 33) { $score++ }
    $signalBefore = @('red', 'orange', 'yellow', 'green')[$score]
  }
  if (-not $cycleKnown) { $cycleZone = 'indeterminado' }
  else {
    $position = $misses + 1
    $cycleZone = if ($position -le 21) { 'green' } elseif ($position -le 41) { 'yellow' } elseif ($position -le 61) { 'orange' } else { 'red' }
  }
  $metadataById[[string]$row.round_id] = [pscustomobject]@{ signal_before = $signalBefore; cycle_zone = $cycleZone }
  $hit = if ($row.multiplier -ge 30) { 1 } else { 0 }
  if ($hit) {
    $direct = if ($misses -ge 61) { 0 } else { $direct + 1 }
    $misses = 0; $cycleKnown = $true
  } elseif ($cycleKnown) { $misses++ }
  $short.Enqueue($hit); $shortHits += $hit
  if ($short.Count -gt 250) { $shortHits -= $short.Dequeue() }
  $long.Enqueue($hit); $longHits += $hit
  if ($long.Count -gt 1000) { $longHits -= $long.Dequeue() }
  $continuous++; $previousRound = $row.round_id
}
$allRows = @($orderedRows | Where-Object {
  $IncludePreviouslySynced -or ($eligibleIds.Contains([string]$_.round_id) -and -not $synced.Contains([string]$_.round_id))
} | ForEach-Object {
  $meta = $metadataById[[string]$_.round_id]
  [pscustomobject]@{
    round_id = $_.round_id
    multiplier = $_.multiplier
    captured_at = $_.captured_at
    source = $_.source
    signal_before = $meta.signal_before
    cycle_zone = $meta.cycle_zone
  }
})

$headers = @{ apikey = $config.publishableKey; Authorization = "Bearer $($config.publishableKey)"; 'Content-Type' = 'application/json' }
$sent = 0
for ($offset = 0; $offset -lt $allRows.Count; $offset += $ChunkSize) {
  $end = [Math]::Min($offset + $ChunkSize - 1, $allRows.Count - 1)
  $chunk = @($allRows[$offset..$end])
  $body = @{ p_token = $config.collectorToken; p_rows = $chunk } | ConvertTo-Json -Compress -Depth 5
  [void](Invoke-RestMethod -Method Post -Uri "$($config.projectUrl)/rest/v1/rpc/$($config.rpc)" -Headers $headers -Body $body -TimeoutSec 30)
  $chunk.round_id | Add-Content -LiteralPath $syncedPath -Encoding utf8
  foreach ($id in $chunk.round_id) { [void]$synced.Add([string]$id) }
  $sent += $chunk.Count
}

$result = [pscustomobject]@{
  completed_at_utc = [DateTime]::UtcNow.ToString('o')
  sent = $sent
  files = $paths.Count
  destination = $config.projectUrl
}
$result | ConvertTo-Json | Set-Content -LiteralPath $syncStatusPath -Encoding utf8
$result | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
