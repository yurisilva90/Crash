param(
  [string]$DataDirectory = "$PSScriptRoot\data",
  [string]$DashboardDirectory = "$PSScriptRoot\..\..\work\crash-dashboard"
)

$ErrorActionPreference = 'Stop'
$mapPath = Join-Path $DataDirectory 'cycle-map.csv'
$statusPath = Join-Path $DataDirectory 'collector-status.json'
$latestCsv = Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $mapPath) -or -not $latestCsv) { exit 0 }

$sequences = Import-Csv -LiteralPath $mapPath
$completed = @($sequences | Where-Object { $_.pattern -ne 'P' })
$pending = $sequences | Select-Object -Last 1
$events = [System.Collections.Generic.List[object]]::new()
foreach ($sequence in $completed) {
  $lossCycles = [int]$sequence.loss_cycles_before_win
  for ($i = 1; $i -le $lossCycles; $i++) {
    $events.Add([pscustomobject]@{ label = "X$i"; color = 'red'; title = "Loss de ciclo - nivel $i" })
  }
  $losses = [int]$sequence.losses_before_win
  $color = if ($losses -le 20) { 'green' } elseif ($losses -le 40) { 'yellow' } else { 'orange' }
  $events.Add([pscustomobject]@{ label = 'V'; color = $color; title = "V: $losses rodadas ate 30x" })
}
if ($pending -and $pending.status -eq 'Em andamento') { $events.Add([pscustomobject]@{ label = '...'; color = 'pending'; title = 'Ciclo em andamento' }) }

$directStreak = 0
for ($i = $completed.Count - 1; $i -ge 0; $i--) { if ($completed[$i].pattern -eq 'V') { $directStreak++ } else { break } }
$allRounds = Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File |
  Sort-Object Name | ForEach-Object { Import-Csv -LiteralPath $_.FullName } |
  Sort-Object { [datetime]$_.captured_at } | Select-Object -Last 2000
$latestRound = $allRounds | Select-Object -Last 1
$status = if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ state='UNKNOWN'; receiver_active=$false } }
$syncPath = Join-Path $PSScriptRoot 'google-sync.json'
$liveUrl = $null
if (Test-Path -LiteralPath $syncPath) {
  try { $liveUrl = (Get-Content -LiteralPath $syncPath -Raw | ConvertFrom-Json).url } catch { }
}
$payload = [ordered]@{
  source = 'snapshot local do coletor'
  liveUrl = $liveUrl
  status = $status
  lastRound = [ordered]@{ round_id = $latestRound.round_id; multiplier = [double]$latestRound.multiplier; captured_at = $latestRound.captured_at }
  directWinStreak = $directStreak
  pending = [ordered]@{ losses_before_win = if ($pending) { [int]$pending.losses_before_win } else { $null }; level = if ($pending) { [int]$pending.loss_cycles_before_win } else { 0 } }
  rounds = @($allRounds | ForEach-Object { [ordered]@{ round_id = $_.round_id; multiplier = [double]$_.multiplier; captured_at = $_.captured_at; active_players = if ($null -ne $_.active_players -and $_.active_players -ne '') { [int]$_.active_players } else { $null }; total_players = if ($null -ne $_.total_players -and $_.total_players -ne '') { [int]$_.total_players } else { $null }; total_amount_brl = if ($null -ne $_.total_amount_brl -and $_.total_amount_brl -ne '') { [double](($_.total_amount_brl -replace ',', '.')) } else { $null }; total_amount_display = if ($_.total_amount_display) { [string]$_.total_amount_display } else { $null }; volume_captured_at = if ($_.volume_captured_at) { [string]$_.volume_captured_at } else { $null } } })
  events = @($events)
}
$target = Join-Path $DashboardDirectory 'data\dashboard.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
$payload | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $target -Encoding utf8
