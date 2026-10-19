param(
  [int]$Port = 8765,
  [string]$DataDirectory = "$PSScriptRoot\data",
  [string]$GoogleSyncConfig = "$PSScriptRoot\google-sync.json",
  [int]$MapBuildIntervalSeconds = 30
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
# O receptor roda em segundo plano; não escrever no console evita que uma janela
# azul apareça quando a tarefa agendada inicia ou reinicia o processo.
$idsIndexPath = Join-Path $DataDirectory 'round-ids.txt'
$payloadArchivePath = Join-Path $DataDirectory ("payload-archive-" + [DateTime]::UtcNow.ToString('yyyy-MM-dd') + '.jsonl')
$historyRecoveryRequestPath = Join-Path $DataDirectory 'history-recovery-request.json'
$controlTokenPath = Join-Path $DataDirectory 'control-token.txt'
if (-not (Test-Path -LiteralPath $controlTokenPath)) {
  [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) | Set-Content -LiteralPath $controlTokenPath -Encoding ascii
}
$controlToken = (Get-Content -LiteralPath $controlTokenPath -Raw).Trim()
$lastMapBuildUtc = [DateTime]::MinValue
$mapBuildProcess = $null
$existing = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
if (Test-Path $idsIndexPath) {
  Get-Content -LiteralPath $idsIndexPath | ForEach-Object { [void]$existing.Add([string]$_) }
} else {
  Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File | ForEach-Object {
    Import-Csv $_.FullName | ForEach-Object { [void]$existing.Add([string]$_.round_id) }
  }
  $existing | Sort-Object | Set-Content -LiteralPath $idsIndexPath -Encoding utf8
}

function Send-Json($writer, [int]$status, $object) {
  $json = $object | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $reason = if ($status -eq 200) { 'OK' } elseif ($status -eq 404) { 'Not Found' } else { 'Internal Server Error' }
  $writer.Write("HTTP/1.1 $status $reason`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
  $writer.Flush()
  $writer.BaseStream.Write($bytes, 0, $bytes.Length)
  $writer.BaseStream.Flush()
}

function Ensure-VolumeColumns([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $header = (Get-Content -LiteralPath $path -TotalCount 1 -ErrorAction SilentlyContinue)
  if ($header -and $header -match 'total_amount_brl') { return }
  $tmp = "$path.volume.tmp"
  @(Import-Csv -LiteralPath $path | Select-Object captured_at,round_id,multiplier,source,active_players,total_players,total_amount_brl,total_amount_display,volume_captured_at) |
    Export-Csv -LiteralPath $tmp -NoTypeInformation -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  $stream = $null
  $reader = $null
  $writer = $null
  try {
    $stream = $client.GetStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 8192, $true)
    $writer = [IO.StreamWriter]::new($stream, [Text.Encoding]::ASCII, 8192, $true)
    $firstLine = $reader.ReadLine()
    if (-not $firstLine) { continue }
    $parts = $firstLine.Split(' ')
    $method, $path = $parts[0], [Uri]::UnescapeDataString($parts[1])
    $routePath = ($path -split '\?', 2)[0]
    $query = if ($path.Contains('?')) { ($path -split '\?', 2)[1] } else { '' }
    $contentLength = 0
    while ($line = $reader.ReadLine()) {
      if ($line -eq '') { break }
      if ($line -match '^Content-Length:\s*(\d+)$') { $contentLength = [int]$Matches[1] }
    }
    if ($method -eq 'OPTIONS') {
      Send-Json $writer 200 @{ status = 'ok' }
      continue
    }
    if ($method -eq 'GET' -and $path -eq '/health') {
      Send-Json $writer 200 @{ status = 'ok'; time = [DateTime]::UtcNow.ToString('o') }
      continue
    }
    if ($method -eq 'GET' -and $path -eq '/history-recovery-request') {
      $request = $null
      if (Test-Path -LiteralPath $historyRecoveryRequestPath) {
        try { $request = Get-Content -LiteralPath $historyRecoveryRequestPath -Raw | ConvertFrom-Json } catch { }
      }
      $required = $null -ne $request -and -not $request.dispatched_at_utc
      if ($required) {
        $request | Add-Member -NotePropertyName dispatched_at_utc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
        $request | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $historyRecoveryRequestPath -Encoding utf8
      }
      Send-Json $writer 200 @{ recovery_required = $required; request = $request }
      continue
    }
    if ($method -eq 'POST' -and $routePath -match '^/control/(gaps|recover|sync)$') {
      $tokenPair = ($query -split '&' | Where-Object { $_ -like 'token=*' } | Select-Object -First 1)
      $receivedToken = if ($tokenPair) { [Uri]::UnescapeDataString($tokenPair.Substring(6)) } else { '' }
      if ($receivedToken -ne $controlToken) {
        Send-Json $writer 401 @{ error = 'unauthorized' }; continue
      }
      $script = if ($routePath -eq '/control/gaps') { Join-Path $PSScriptRoot 'gap-audit.ps1' } elseif ($routePath -eq '/control/recover') { Join-Path $PSScriptRoot 'watchdog.ps1' } else { Join-Path $PSScriptRoot 'sync-live-supabase.ps1' }
      if (-not (Test-Path -LiteralPath $script)) { Send-Json $writer 404 @{ error = 'control script unavailable' }; continue }
      $args = @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$script)
      if ($routePath -eq '/control/gaps') { $args += @('-WindowRounds','5000','-DataDirectory',$DataDirectory) }
      Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden
      Send-Json $writer 200 @{ accepted = $true; action = $routePath; started_at_utc = [DateTime]::UtcNow.ToString('o') }; continue
    }
    if ($method -ne 'POST' -or $path -ne '/rounds') {
      Send-Json $writer 404 @{ error = 'not found' }
      continue
    }
    $bodyChars = New-Object char[] $contentLength
    [void]$reader.ReadBlock($bodyChars, 0, $contentLength)
    # Arquiva o payload bruto antes de qualquer validação/deduplicação. Isso
    # permite reprocessar um lote mesmo se o Supabase ou o parser falhar.
    $rawBody = -join $bodyChars
    [pscustomobject]@{
      received_at_utc = [DateTime]::UtcNow.ToString('o')
      body = $rawBody
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $payloadArchivePath -Encoding utf8
    $payload = $rawBody | ConvertFrom-Json
    $today = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
    $csv = Join-Path $DataDirectory "crash-$today.csv"
    $jsonl = Join-Path $DataDirectory "crash-$today.jsonl"
    # List evita a cópia do array inteiro a cada rodada recebida.
    $newRows = [Collections.Generic.List[object]]::new()
    foreach ($row in @($payload.rows)) {
      $id = [string]$row.id
      $mult = [double]$row.multiplier
      # O Crash atual usa IDs de 7 dígitos na faixa 8–9 milhões. Isto bloqueia
      # números de outros elementos da página que o DOM possa expor como rodada.
      if ($id -notmatch '^\d{7}$' -or [Int64]$id -lt 8000000 -or $mult -le 0 -or -not $existing.Add($id)) { continue }
      $capturedAt = [string]$row.captured_at
      # Se a extensão ficou com o relógio adiantado, não deixe um timestamp
      # futuro contaminar o painel. Mantemos o valor original quando ele é
      # plausível; só usamos a hora de recebimento para desvios maiores que
      # dois minutos.
      try {
        $parsedCapturedAt = [DateTimeOffset]::Parse($capturedAt, [Globalization.CultureInfo]::InvariantCulture)
        if (($parsedCapturedAt.UtcDateTime - [DateTime]::UtcNow).TotalMinutes -gt 2) {
          $capturedAt = [DateTime]::UtcNow.ToString('o')
        }
      } catch {
        $capturedAt = [DateTime]::UtcNow.ToString('o')
      }
      [void]$newRows.Add([pscustomobject]@{
        captured_at = $capturedAt
        round_id = $id
        multiplier = $mult.ToString([Globalization.CultureInfo]::InvariantCulture)
        source = [string]$payload.source
        active_players = if ($null -ne $row.active_players) { [int]$row.active_players } else { $null }
        total_players = if ($null -ne $row.total_players) { [int]$row.total_players } else { $null }
        total_amount_brl = if ($null -ne $row.total_amount_brl) { ([double]$row.total_amount_brl).ToString([Globalization.CultureInfo]::InvariantCulture) } else { $null }
        total_amount_display = if ($row.total_amount_display) { [string]$row.total_amount_display } else { $null }
        volume_captured_at = if ($row.volume_captured_at) { [string]$row.volume_captured_at } else { $null }
      })
    }
    if ($newRows.Count) {
      Ensure-VolumeColumns $csv
      $newRows | Export-Csv -Path $csv -Append -NoTypeInformation -Encoding utf8
      $newRows.round_id | Add-Content -LiteralPath $idsIndexPath -Encoding utf8
      foreach ($row in $newRows) { ($row | ConvertTo-Json -Compress) | Add-Content -Path $jsonl -Encoding utf8 }
      # A reconstrução lê todo o histórico e não deve bloquear o receptor nem
      # ficar acumulando memória no processo principal. No máximo uma execução
      # a cada intervalo; o filho termina e devolve a memória ao Windows.
      $nowUtc = [DateTime]::UtcNow
      $mapProcessRunning = $null -ne $mapBuildProcess -and -not $mapBuildProcess.HasExited
      $mapDue = ($nowUtc - $lastMapBuildUtc).TotalSeconds -ge [Math]::Max(5, $MapBuildIntervalSeconds)
      if (-not $mapProcessRunning -and $mapDue) {
        $mapArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $PSScriptRoot 'build-cycle-map.ps1'),'-DataDirectory',$DataDirectory)
        $mapBuildProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $mapArgs -WindowStyle Hidden -PassThru
        $lastMapBuildUtc = $nowUtc
      }
    }
    $storedMetrics = 0
    if ($null -ne $payload.live_metrics) {
      $metric = $payload.live_metrics
      $activePlayers = [int]$metric.active_players
      $totalPlayers = [int]$metric.total_players
      $totalAmountBrl = [double]$metric.total_amount_brl
      if ($activePlayers -ge 0 -and $totalPlayers -ge $activePlayers -and $totalAmountBrl -ge 0) {
        $metricsCsv = Join-Path $DataDirectory "live-round-metrics-$today.csv"
        [pscustomobject]@{
          captured_at = [string]$metric.captured_at
          active_players = $activePlayers
          total_players = $totalPlayers
          total_amount_brl = $totalAmountBrl.ToString([Globalization.CultureInfo]::InvariantCulture)
          total_amount_display = [string]$metric.total_amount_display
          source = [string]$payload.source
        } | Export-Csv -Path $metricsCsv -Append -NoTypeInformation -Encoding utf8
        $storedMetrics = 1
      }
    }
    $storedAccountStatus = 0
    if ($null -ne $payload.account_status) {
      $account = $payload.account_status
      $balance = if ($null -eq $account.balance) { $null } else { [double]$account.balance }
      $currency = [string]$account.currency
      $betActive = [bool]$account.bet_active
      $roundId = if ($null -eq $account.round_id -or [string]::IsNullOrWhiteSpace([string]$account.round_id)) { $null } else { [string]$account.round_id }
      $betAmount = if ($null -eq $account.bet_amount) { $null } else { [double]$account.bet_amount }
      $liveMultiplier = if ($null -eq $account.live_multiplier) { $null } else { [double]$account.live_multiplier }
      # A leitura do multiplicador pode ocorrer na animação inicial, antes de
      # chegar a 1x. Isso não invalida o saldo nem o estado da aposta.
      if (($null -eq $balance -or $balance -ge 0) -and ($null -eq $liveMultiplier -or $liveMultiplier -ge 0)) {
        # Gravação atômica: evita que o sincronizador leia um arquivo vazio ou
        # fique preso no lock durante a troca do saldo.
        $runtimePath = Join-Path $DataDirectory 'runtime-status-v2.json'
        $runtimeTempPath = "$runtimePath.tmp"
        [pscustomobject]@{
          captured_at = if ($account.captured_at) { [string]$account.captured_at } else { [DateTime]::UtcNow.ToString('o') }
          balance = $balance
          currency = $currency
          bet_active = $betActive
          round_id = $roundId
          bet_amount = $betAmount
          live_multiplier = $liveMultiplier
          status = if ($account.status) { [string]$account.status } elseif ($betActive) { 'aposta ativa' } else { 'sem aposta' }
          source = [string]$payload.source
        } | ConvertTo-Json | Set-Content -LiteralPath $runtimeTempPath -Encoding utf8
        Move-Item -LiteralPath $runtimeTempPath -Destination $runtimePath -Force
        $storedAccountStatus = 1
      }
    }
    [pscustomobject]@{
      received_at_utc = [DateTime]::UtcNow.ToString('o')
      source = [string]$payload.source
      payload_rows = @($payload.rows).Count
      stored_rows = $newRows.Count
      stored_live_metrics = $storedMetrics
      stored_account_status = $storedAccountStatus
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDirectory 'receiver-activity.json') -Encoding utf8
    Send-Json $writer 200 @{ ok = $true; received = @($payload.rows).Count; stored = $newRows.Count; stored_live_metrics = $storedMetrics; stored_account_status = $storedAccountStatus }
  } catch {
    try { Send-Json $writer 500 @{ error = $_.Exception.Message } } catch { }
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($writer) { $writer.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($client) { $client.Close() }
  }
}
