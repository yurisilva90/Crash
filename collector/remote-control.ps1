param([string]$DataDirectory = "$PSScriptRoot\data")

$ErrorActionPreference = 'Stop'
foreach ($name in 'ALL_PROXY','HTTP_PROXY','HTTPS_PROXY','all_proxy','http_proxy','https_proxy') {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'supabase-sync.json') -Raw | ConvertFrom-Json
$token = (Get-Content -LiteralPath (Join-Path $DataDirectory 'control-token.txt') -Raw).Trim()
$headers = @{ apikey = $config.publishableKey; Authorization = "Bearer $($config.publishableKey)" }
$statusPath = Join-Path $DataDirectory 'remote-control-status.json'

function Invoke-ControlRpc([string]$Name, [hashtable]$Params) {
  $body = $Params | ConvertTo-Json -Compress -Depth 4
  Invoke-RestMethod -Method Post -Uri "$($config.projectUrl)/rest/v1/rpc/$Name" `
    -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
}

try {
  $command = Invoke-ControlRpc 'crash_control_claim' @{ p_token = $token }
  if ($null -eq $command -or -not $command.id) { return }
  $success = $false
  $result = ''
  try {
    switch ([string]$command.action) {
      'gaps' {
        $auditText = & (Join-Path $PSScriptRoot 'gap-audit.ps1') -WindowRounds 5000 -DataDirectory $DataDirectory
        $audit = $auditText | Select-Object -Last 1 | ConvertFrom-Json
        if ($audit.state -eq 'DB_CHECK_FAILED') { throw "Auditoria incompleta: $($audit.supabase_error)" }
        $result = "Auditoria: $($audit.missing_count) lacunas nas ultimas 5.000 rodadas."
      }
      'recover' {
        $auditPath = Join-Path $DataDirectory 'gap-audit.json'
        $audit = if (Test-Path $auditPath) { Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json } else { $null }
        [ordered]@{
          requested_at_utc = [DateTime]::UtcNow.ToString('o')
          reason = 'manual_remote_control'
          missing_count = if ($audit) { [int]$audit.missing_count } else { 0 }
          missing_segments = if ($audit) { @($audit.missing_segments) } else { @() }
          dispatched_at_utc = $null
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $DataDirectory 'history-recovery-request.json') -Encoding utf8
        $result = 'Varredura das ultimas 2.000 rodadas solicitada a extensao; aguarde a proxima verificacao.'
        if ($audit -and [int]$audit.unrecoverable_missing_count -gt 0) {
          $result += ' Lacunas anteriores a essa janela nao podem ser recuperadas pelo site.'
        }
      }
      'sync' {
        $syncText = & (Join-Path $PSScriptRoot 'sync-live-supabase.ps1') -DataDirectory $DataDirectory
        $sync = Get-Content -LiteralPath (Join-Path $DataDirectory 'supabase-live-sync-status.json') -Raw | ConvertFrom-Json
        if ($sync.runtime_error) { throw [string]$sync.runtime_error }
        $result = "Sincronizacao concluida; $($sync.sent) rodadas enviadas."
        if (-not $sync.runtime_sent) { $result += ' Saldo indisponivel nesta aba do jogo.' }
      }
      default { throw 'Acao desconhecida.' }
    }
    $success = $true
  } catch {
    $result = $_.Exception.Message
  }
  try {
    [void](Invoke-ControlRpc 'crash_control_finish' @{
      p_token = $token; p_id = [int64]$command.id; p_success = $success; p_result = $result
    })
  } finally {
    [pscustomobject]@{ checked_at_utc = [DateTime]::UtcNow.ToString('o'); id = $command.id;
      action = $command.action; success = $success; result = $result } |
      ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
  }
} catch {
  [pscustomobject]@{ checked_at_utc = [DateTime]::UtcNow.ToString('o'); success = $false;
    result = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}
