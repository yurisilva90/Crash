param(
  [string]$DataDirectory = "$PSScriptRoot\data",
  [double]$TargetMultiplier = 30,
  [int]$LossesPerCycle = 61
)

$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File | Sort-Object Name
$roundById = [System.Collections.Generic.Dictionary[long, object]]::new()
foreach ($file in $files) {
  foreach ($row in (Import-Csv -LiteralPath $file.FullName)) {
    if ($row.round_id -notmatch '^\d{7}$' -or $row.multiplier -notmatch '^\d+(\.\d+)?$') { continue }
    $id = [long]$row.round_id
    if (-not $roundById.ContainsKey($id)) { $roundById.Add($id, $row) }
  }
}
$roundIds = [System.Collections.Generic.List[long]]::new()
foreach ($id in $roundById.Keys) { $roundIds.Add($id) }
$roundIds.Sort()

$map = [System.Collections.Generic.List[object]]::new()
$losses = 0
$sequenceStart = $null
$number = 0
$firstSequence = $true

foreach ($id in $roundIds) {
  $round = $roundById[$id]
  $multiplier = [double]$round.multiplier
  if ($multiplier -ge $TargetMultiplier) {
    $number++
    $lossCycles = [math]::Floor($losses / $LossesPerCycle)
    $pattern = ('X' * $lossCycles) + 'V'
    $map.Add([pscustomobject]@{
      sequence = $number
      pattern = $pattern
      level = $lossCycles
      is_hit = ($lossCycles -ge 2)
      losses_before_win = $losses
      loss_cycles_before_win = $lossCycles
      sequence_start_round = if ($sequenceStart) { $sequenceStart } else { $round.round_id }
      win_round = $round.round_id
      win_multiplier = $round.multiplier
      status = if ($firstSequence) { 'Inicial parcial' } else { 'Concluída' }
    })
    $losses = 0
    $sequenceStart = $null
    $firstSequence = $false
    continue
  }

  if ($losses -eq 0) { $sequenceStart = $round.round_id }
  $losses++
}

if ($roundIds.Count -and $losses -gt 0) {
  $number++
  $lossCycles = [math]::Floor($losses / $LossesPerCycle)
  $map.Add([pscustomobject]@{
    sequence = $number
    pattern = ('X' * $lossCycles) + 'P'
    level = $lossCycles
    is_hit = ($lossCycles -ge 2)
    losses_before_win = $losses
    loss_cycles_before_win = $lossCycles
    sequence_start_round = $sequenceStart
    win_round = $null
    win_multiplier = $null
    status = 'Em andamento'
  })
}

$output = Join-Path $DataDirectory 'cycle-map.csv'
$map | Export-Csv -LiteralPath $output -NoTypeInformation -Encoding utf8
Write-Output ("Mapa atualizado: {0} sequências em {1}" -f $map.Count, $output)
