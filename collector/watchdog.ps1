param(
  [int]$MaxAgeMinutes = 5,
  [string]$DataDirectory = "$PSScriptRoot\data"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$cycleMapScript = Join-Path $PSScriptRoot 'build-cycle-map.ps1'
if (Test-Path -LiteralPath $cycleMapScript) {
  & $cycleMapScript -DataDirectory $DataDirectory | Out-Null
}
$dashboardScript = Join-Path $PSScriptRoot 'build-dashboard-data.ps1'
if (Test-Path -LiteralPath $dashboardScript) {
  & $dashboardScript -DataDirectory $DataDirectory | Out-Null
}
# O painel usa Supabase. Não sincronizar Google Planilhas aqui: a rotina antiga
# relia todo o histórico repetidamente e podia prender o watchdog.
$liveSyncScript = Join-Path $PSScriptRoot 'live-sync.ps1'
$balanceHistoryScript = Join-Path $PSScriptRoot 'balance-history-writer.ps1'
$liveSyncProcesses = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*live-sync.ps1*' })
$liveSyncActive = $liveSyncProcesses.Count -gt 0
# Um processo existente não é garantia de que ele está sincronizando. Se o lock
# estiver preso por mais de 2 minutos, reinicia somente o sincronizador local.
$syncLock = Join-Path $DataDirectory 'supabase-sync.lock'
$staleSyncLock = (Test-Path -LiteralPath $syncLock) -and (([DateTime]::UtcNow - (Get-Item -LiteralPath $syncLock).LastWriteTimeUtc).TotalMinutes -gt 2)
$supabaseSyncRestarted = $false
if ($staleSyncLock) {
  foreach ($process in $liveSyncProcesses) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $syncLock -Force -ErrorAction SilentlyContinue
  $liveSyncActive = $false
  $supabaseSyncRestarted = $true
}
if (-not $liveSyncActive -and (Test-Path -LiteralPath $liveSyncScript)) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $liveSyncScript
  ) -WindowStyle Hidden
  $liveSyncActive = $true
}

# O escritor usa mutex; iniciar a cada passagem é seguro e garante que volte
# após reinício sem duplicar o processo nem as linhas do histórico de saldo.
if (Test-Path -LiteralPath $balanceHistoryScript) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $balanceHistoryScript
  ) -WindowStyle Hidden
}

function Test-Receiver {
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync('127.0.0.1', 8765)
    if (-not $task.Wait(1000)) {
      $client.Dispose()
      return $false
    }
    # Wait() só informa que a tentativa terminou; ela também termina quando a
    # conexão falha. Ler o resultado da tarefa e o estado do socket impede que
    # um receptor caído seja marcado equivocadamente como saudável.
    [void]$task.GetAwaiter().GetResult()
    $connected = $client.Connected
    $client.Dispose()
    return $connected
  } catch { return $false }
}

$receiverActive = Test-Receiver
$receiverRestarted = $false
if (-not $receiverActive) {
  $receiverScript = Join-Path $PSScriptRoot 'receiver.ps1'
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $receiverScript
  ) -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $receiverActive = Test-Receiver
  $receiverRestarted = $receiverActive
}

$latest = Get-ChildItem -LiteralPath $DataDirectory -Filter 'crash-*.csv' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$gapAuditPath = Join-Path $DataDirectory 'gap-audit.json'
$gapAudit = $null
if (Test-Path -LiteralPath $gapAuditPath) {
  try { $gapAudit = Get-Content -LiteralPath $gapAuditPath -Raw | ConvertFrom-Json } catch { }
}
$now = [DateTime]::UtcNow
$age = if ($latest) {
  # Um lote capturado antes de uma correção de relógio pode ter LastWriteTime
  # alguns minutos no futuro. Isso não deve aparecer como idade negativa no
  # painel nem fazer o watchdog abrir recuperações desnecessárias.
  [math]::Max(0, [math]::Round(($now - $latest.LastWriteTimeUtc).TotalMinutes, 1))
} else { $null }
$latestLocalRound = $null
if ($latest) {
  try { $latestLocalRound = [Int64]((Import-Csv -LiteralPath $latest.FullName | Where-Object { $_.round_id -match '^\d+$' } | Sort-Object { [Int64]$_.round_id } | Select-Object -Last 1).round_id) } catch { }
}
$supabaseRound = $null
$supabaseAge = $null
try {
  $supabaseConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'supabase-sync.json') -Raw | ConvertFrom-Json
  $supabaseHeaders = @{ apikey = $supabaseConfig.publishableKey; Authorization = "Bearer $($supabaseConfig.publishableKey)" }
  $supabaseUrl = "$($supabaseConfig.projectUrl)/rest/v1/crash_rounds?select=round_id,captured_at&round_id=gte.9600000&round_id=lte.9999999&order=round_id.desc&limit=1"
  $supabaseLatest = @(Invoke-RestMethod -Uri $supabaseUrl -Headers $supabaseHeaders -TimeoutSec 15)[0]
  if ($supabaseLatest) {
    $supabaseRound = [Int64]$supabaseLatest.round_id
    $supabaseCaptured = [DateTime]$supabaseLatest.captured_at
    $supabaseAge = [math]::Max(0, [math]::Round(($now - $supabaseCaptured.ToUniversalTime()).TotalMinutes, 1))
  }
} catch { }
$collectorStale = $null -eq $age -or $age -gt $MaxAgeMinutes
$supabaseStale = $null -eq $supabaseAge -or $supabaseAge -gt $MaxAgeMinutes
$syncLag = $null -ne $latestLocalRound -and ($null -eq $supabaseRound -or $supabaseRound -lt $latestLocalRound)
$chromeRunning = @(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count -gt 0
$chromeRecoveryOpened = $false
$crashUrl = 'https://bc.game/pt/game/crash?collector_recovery=1'
$activityPath = Join-Path $DataDirectory 'receiver-activity.json'
$activity = $null
if (Test-Path -LiteralPath $activityPath) {
  try { $activity = Get-Content -LiteralPath $activityPath -Raw | ConvertFrom-Json } catch { }
}
$statusPath = Join-Path $DataDirectory 'collector-status.json'
# Mantém o horário de recuperação em um arquivo próprio. O status é refeito a
# cada minuto e não deve apagar este controle nem criar uma sequência de abas.
$recoveryStatePath = Join-Path $DataDirectory 'chrome-recovery-state.json'
$lastChromeRecovery = $null
$recoveryPending = $false
$recoveryRound = $null
if (Test-Path -LiteralPath $recoveryStatePath) {
  try {
    $recoveryState = Get-Content -LiteralPath $recoveryStatePath -Raw | ConvertFrom-Json
    $recoveryPending = [bool]$recoveryState.pending
    if ($null -ne $recoveryState.round_at_open) { $recoveryRound = [Int64]$recoveryState.round_at_open }
    if ($recoveryState.last_chrome_recovery_utc) {
      $rawRecoveryTime = $recoveryState.last_chrome_recovery_utc
      $lastChromeRecovery = if ($rawRecoveryTime -is [DateTime]) {
        $rawRecoveryTime.ToUniversalTime()
      } else {
        [DateTimeOffset]::Parse([string]$rawRecoveryTime, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
      }
    }
  } catch { }
}
# Uma nova rodada depois da abertura comprova que a tentativa funcionou.
# Só então liberamos uma futura abertura; uma tentativa parada não empilha abas.
if ($recoveryPending -and $null -ne $recoveryRound -and $latestLocalRound -gt $recoveryRound) {
  $recoveryPending = $false
  [pscustomobject]@{ last_chrome_recovery_utc = $lastChromeRecovery.ToString('o'); url = $crashUrl;
    reason = 'recovered'; round_at_open = $recoveryRound; pending = $false } |
    ConvertTo-Json | Set-Content -LiteralPath $recoveryStatePath -Encoding utf8
}
$gapRecoveryRequired = $gapAudit -and $gapAudit.state -eq 'GAP_DETECTED' -and [int]$gapAudit.recoverable_missing_count -gt 0
$recoveryDue = -not $recoveryPending -and ($null -eq $lastChromeRecovery -or ($now - $lastChromeRecovery).TotalMinutes -ge 10)
# Lacunas exigem a mesma varredura do histórico que um coletor parado. Antes,
# esta aba só era aberta quando o CSV ficava velho, deixando pedidos de gap sem
# uma segunda tentativa caso a mensagem da extensão não fosse recebida.
$recoveryReason = if ($gapRecoveryRequired) { 'gap-detected' } elseif ($collectorStale) { 'collector-stale' } else { $null }
if ($recoveryReason -and $recoveryDue) {
  $chromePath = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
  if (Test-Path -LiteralPath $chromePath) {
    # Recuperação sempre abre o jogo, nunca a URL pública do painel.
    # Abre uma única aba na sessão existente, evitando acumular janelas do Crash.
    Start-Process -FilePath $chromePath -ArgumentList @($crashUrl)
    $chromeRecoveryOpened = $true
    $recoveryPending = $true
    [pscustomobject]@{ last_chrome_recovery_utc = $now.ToString('o'); url = $crashUrl;
      reason = $recoveryReason; round_at_open = $latestLocalRound; pending = $true } |
      ConvertTo-Json | Set-Content -LiteralPath $recoveryStatePath -Encoding utf8
  }
}
$state = if (-not $receiverActive) { 'RECEIVER_OFFLINE' } elseif ($collectorStale) { 'STALE' } elseif ($syncLag -or $supabaseStale) { 'SYNC_LAG' } else { 'OK' }
$status = [pscustomobject]@{
  checked_at_utc = $now.ToString('o')
  state = $state
  age_minutes = $age
  latest_file = if ($latest) { $latest.Name } else { $null }
  latest_modified_utc = if ($latest) { $latest.LastWriteTimeUtc.ToString('o') } else { $null }
  latest_local_round = $latestLocalRound
  supabase_last_round = $supabaseRound
  supabase_age_minutes = $supabaseAge
  supabase_sync_lag = $syncLag
  receiver_active = $receiverActive
  supabase_sync_active = $liveSyncActive
  supabase_sync_restarted = $supabaseSyncRestarted
  receiver_restarted = $receiverRestarted
  chrome_running = $chromeRunning
  chrome_recovery_opened = $chromeRecoveryOpened
  chrome_recovery_url = if ($chromeRecoveryOpened) { $crashUrl } else { $null }
  chrome_recovery_reason = if ($chromeRecoveryOpened) { $recoveryReason } else { $null }
  chrome_recovery_pending = $recoveryPending
  gap_recovery_required = [bool]$gapRecoveryRequired
  last_extension_payload_utc = if ($activity) { $activity.received_at_utc } else { $null }
  last_payload_rows = if ($activity) { $activity.payload_rows } else { $null }
  last_stored_rows = if ($activity) { $activity.stored_rows } else { $null }
  gap_audit = $gapAudit
  last_chrome_recovery_utc = if ($chromeRecoveryOpened) { $now.ToString('o') } elseif ($lastChromeRecovery) { $lastChromeRecovery.ToString('o') } else { $null }
}
$status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $DataDirectory 'collector-status.json') -Encoding utf8
if ($state -ne 'OK') { "$($status.checked_at_utc) $state age_minutes=$age" | Add-Content -LiteralPath (Join-Path $DataDirectory 'collector-watchdog.log') -Encoding utf8 }
$remoteControlScript = Join-Path $PSScriptRoot 'remote-control.ps1'
if (Test-Path -LiteralPath $remoteControlScript) {
  try { & $remoteControlScript -DataDirectory $DataDirectory } catch { }
}
Write-Output ($status | ConvertTo-Json -Depth 5 -Compress)
