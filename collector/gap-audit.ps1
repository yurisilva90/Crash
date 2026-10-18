param(
  [int]$WindowRounds = 2000,
  [string]$DataDirectory = "$PSScriptRoot\data"
)

$ErrorActionPreference = 'Stop'
foreach ($proxyVariable in 'ALL_PROXY','HTTP_PROXY','HTTPS_PROXY','all_proxy','http_proxy','https_proxy') {
  Remove-Item "Env:$proxyVariable" -ErrorAction SilentlyContinue
}
$now = [DateTime]::UtcNow
$files = @(Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File)
$ids = @($files | ForEach-Object { Import-Csv -LiteralPath $_.FullName } |
  ForEach-Object { [Int64]$_.round_id } |
  Where-Object { $_ -ge 9000000 -and $_ -le 9999999 } |
  Sort-Object -Unique)

if (-not $ids.Count) {
  [pscustomobject]@{ checked_at_utc=$now.ToString('o'); state='NO_CURRENT_IDS'; window_rounds=$WindowRounds } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDirectory 'gap-audit.json') -Encoding utf8
  exit 0
}

# A rodada mais nova pode ainda estar na fila de sincronização. Audita uma
# janela estabilizada, cinco rodadas atrás da ponta local.
$lastId = $ids[-1] - 5
$firstExpected = [Math]::Max($ids[0], $lastId - $WindowRounds + 1)
$windowIds = @($ids | Where-Object { $_ -ge $firstExpected -and $_ -le $lastId })
$localSet = [Collections.Generic.HashSet[long]]::new()
foreach ($id in $windowIds) { [void]$localSet.Add([long]$id) }
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'supabase-sync.json') -Raw | ConvertFrom-Json
$headers = @{ apikey = $config.publishableKey; Authorization = "Bearer $($config.publishableKey)" }
$databaseSet = [Collections.Generic.HashSet[long]]::new()
$databaseError = $null
try {
  for ($offset = 0; $offset -lt $WindowRounds; $offset += 1000) {
    $url = "$($config.projectUrl)/rest/v1/crash_rounds?select=round_id&round_id=gte.$firstExpected&round_id=lte.$lastId&order=round_id.asc&limit=1000&offset=$offset"
    $page = Invoke-RestMethod -Method Get -Uri $url -Headers $headers -TimeoutSec 30
    foreach ($row in $page) { [void]$databaseSet.Add([long]$row.round_id) }
    if ($page.Count -lt 1000) { break }
  }
} catch {
  $databaseError = $_.Exception.Message
}
$missingLocalIds = [Collections.Generic.List[long]]::new()
$missingDatabaseIds = [Collections.Generic.List[long]]::new()
$missingEitherIds = [Collections.Generic.List[long]]::new()
if (-not $databaseError) {
  for ($id = $firstExpected; $id -le $lastId; $id++) {
    $missingLocal = -not $localSet.Contains([long]$id)
    $missingDatabase = -not $databaseSet.Contains([long]$id)
    if ($missingLocal) { $missingLocalIds.Add([long]$id) }
    if ($missingDatabase) { $missingDatabaseIds.Add([long]$id) }
    if ($missingLocal -or $missingDatabase) { $missingEitherIds.Add([long]$id) }
  }
}
function Get-MissingSegments([long[]]$missingIds) {
  $segments = [Collections.Generic.List[object]]::new()
  if (-not $missingIds.Count) { return @() }
  $start = $missingIds[0]
  $end = $start
  for ($index = 1; $index -lt $missingIds.Count; $index++) {
    if ($missingIds[$index] -eq $end + 1) { $end = $missingIds[$index]; continue }
    $segments.Add([pscustomobject]@{ after_id = $start - 1; before_id = $end + 1; missing_count = $end - $start + 1 })
    $start = $missingIds[$index]
    $end = $start
  }
  $segments.Add([pscustomobject]@{ after_id = $start - 1; before_id = $end + 1; missing_count = $end - $start + 1 })
  return @($segments)
}
$segments = @(Get-MissingSegments $missingEitherIds.ToArray())
$missing = $missingEitherIds.Count
$recoverableFloor = $ids[-1] - 1999
$recoverableMissingIds = @($missingEitherIds | Where-Object { $_ -ge $recoverableFloor })
$recoverableSegments = @(Get-MissingSegments ([long[]]$recoverableMissingIds))
$audit = [ordered]@{
  checked_at_utc = $now.ToString('o')
  state = if ($databaseError) { 'DB_CHECK_FAILED' } elseif ($missing) { 'GAP_DETECTED' } else { 'OK' }
  window_rounds = $WindowRounds
  range_start = $firstExpected
  range_end = $lastId
  local_ids = $windowIds.Count
  supabase_ids = if ($databaseError) { $null } else { $databaseSet.Count }
  local_missing_count = if ($databaseError) { $null } else { $missingLocalIds.Count }
  supabase_missing_count = if ($databaseError) { $null } else { $missingDatabaseIds.Count }
  supabase_error = $databaseError
  missing_count = $missing
  missing_segments = $segments
  recoverable_missing_count = $recoverableMissingIds.Count
  unrecoverable_missing_count = $missing - $recoverableMissingIds.Count
}
$audit | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DataDirectory 'gap-audit.json') -Encoding utf8

if ($recoverableMissingIds.Count -and -not $databaseError) {
  [ordered]@{
    requested_at_utc = $now.ToString('o')
    reason = 'gap_detected_in_last_2000_rounds'
    missing_count = $recoverableMissingIds.Count
    missing_segments = @($recoverableSegments)
    dispatched_at_utc = $null
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DataDirectory 'history-recovery-request.json') -Encoding utf8
} elseif ($missing -and -not $databaseError) {
  [ordered]@{
    requested_at_utc = $now.ToString('o')
    reason = 'gap_outside_site_history_window'
    missing_count = $missing
    missing_segments = @($segments)
    dispatched_at_utc = $now.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $DataDirectory 'history-recovery-request.json') -Encoding utf8
}

Write-Output ($audit | ConvertTo-Json -Depth 4 -Compress)
