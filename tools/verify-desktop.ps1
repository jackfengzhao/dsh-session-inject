# dsh-session-inject - desktop profile verification (run AFTER restarting dsh desktop).
#
# Desktop runs the same bundle from the same source directory, so no copy is
# needed; it must be restarted once to load v0.2. If the web profile is still
# running, port 3090 is already taken - stop one of them first (the plugin logs
# an EADDRINUSE error instead of crashing).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-desktop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-desktop.ps1 -Url http://127.0.0.1:3090/mcp/session-inject
param(
  [string]$Url = 'http://127.0.0.1:3090/mcp/session-inject'
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

function Step([string]$name, [scriptblock]$body) {
  try {
    & $body
    Write-Host "[PASS] $name"
  } catch {
    $failures.Add($name + ': ' + $_.Exception.Message) | Out-Null
    Write-Host "[FAIL] $name - $($_.Exception.Message)"
  }
}

function Rpc([string]$method, $params) {
  $payload = @{ jsonrpc = '2.0'; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
  $tmp = Join-Path $env:TEMP ('dsh-session-inject-verify-' + [guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $raw = & curl.exe -sS -X POST $Url -H 'content-type: application/json' --data-binary "@$tmp"
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  return ($raw | ConvertFrom-Json)
}

function Payload($response) {
  if (-not $response.result -or -not $response.result.content) { return $null }
  return ($response.result.content[0].text | ConvertFrom-Json)
}

$healthUrl = $Url -replace '/mcp/session-inject$', '/health'

Step 'health endpoint reachable' {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if (-not $health.ok) { throw 'health.ok is false' }
  if ($health.version -lt '0.3.0') { throw "version is $($health.version), expected >= 0.3.0 (restart desktop)" }
  Write-Host "       version=$($health.version) auth=$($health.auth) live=$($health.live_sessions.Count)"
}

Step 'MCP initialize' {
  $r = Rpc 'initialize' @{ protocolVersion = '2024-11-05'; capabilities = @{}; clientInfo = @{ name = 'verify-desktop'; version = '0.2.0' } }
  if (-not $r.result.protocolVersion) { throw 'no protocolVersion in initialize result' }
}

Step 'tools/list has 5 tools' {
  $r = Rpc 'tools/list' @{}
  $names = @($r.result.tools | ForEach-Object { $_.name })
  foreach ($wanted in @('sessions_list', 'session_inject', 'inject_status', 'submissions_list', 'session_create')) {
    if ($names -notcontains $wanted) { throw "missing tool $wanted (got: $($names -join ', '))" }
  }
}

Step 'sessions_list returns live sessions' {
  $r = Rpc 'tools/call' @{ name = 'sessions_list'; arguments = @{} }
  $sessions = Payload $r
  if (-not $sessions -or $sessions.Count -eq 0) { throw 'no live sessions' }
  $busy = @($sessions | Where-Object { $_.busy }).Count
  Write-Host "       sessions=$($sessions.Count) busy=$busy"
}

Step 'session_create + session_inject + inject_status round trip' {
  # provider/model are environment-specific; override with VERIFY_PROVIDER / VERIFY_MODEL
  $verifyArgs = @{ cwd = (Join-Path $env:TEMP 'dsh-session-inject-desktop-check') }
  if ($env:VERIFY_PROVIDER) { $verifyArgs.provider = $env:VERIFY_PROVIDER }
  if ($env:VERIFY_MODEL) { $verifyArgs.model = $env:VERIFY_MODEL }
  $created = Payload (Rpc 'tools/call' @{
    name = 'session_create'
    arguments = $verifyArgs
  })
  if (-not $created.ok -or -not $created.session_id) { throw 'session_create failed' }
  New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP 'dsh-session-inject-desktop-check') | Out-Null

  $injected = Payload (Rpc 'tools/call' @{
    name = 'session_inject'
    arguments = @{
      session_id = $created.session_id
      content = 'Reply with exactly DESKTOP-OK and nothing else.'
      delivery = 'queue'
      wait_ms = 120000
    }
  })
  if ($injected.status -ne 'done') { throw "inject status=$($injected.status) error=$($injected.error)" }
  if ($injected.reply_text -notmatch 'DESKTOP-OK') { throw "unexpected reply: $($injected.reply_text)" }

  $status = Payload (Rpc 'tools/call' @{ name = 'inject_status'; arguments = @{ submission_id = $injected.submission_id } })
  if ($status.status -ne 'done') { throw "inject_status=$($status.status)" }
  if ($status.phase -ne 'done') { throw "inject_status phase=$($status.phase)" }

  $list = Payload (Rpc 'tools/call' @{ name = 'submissions_list'; arguments = @{ session_id = $created.session_id; limit = 5 } })
  $found = @($list | Where-Object { $_.submission_id -eq $injected.submission_id })
  if ($found.Count -lt 1) { throw 'submissions_list did not return the submission' }
  Write-Host "       session=$($created.session_id) reply=$($injected.reply_text) phase=$($status.phase)"
}

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host "RESULT: FAIL ($($failures.Count) step(s))"
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host ''
Write-Host 'RESULT: PASS (desktop profile verified)'
exit 0
