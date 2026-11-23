# dsh-session-inject — Windows PowerShell example (curl.exe + UTF-8 payload file).
#
#   .\hermes-curl.ps1                          # list sessions
#   .\hermes-curl.ps1 <session-id> "请只回复 INJECT-OK"
#
# PowerShell 5.1's Invoke-WebRequest encodes -Body as ISO-8859-1, which turns
# Chinese characters into "?". Writing a UTF-8 payload file and passing it with
# curl.exe --data-binary avoids that.
param(
  [string]$SessionId = '',
  [string]$Content = '请只回复 INJECT-OK',
  [string]$Url = $(if ($env:DSH_SESSION_INJECT_URL) { $env:DSH_SESSION_INJECT_URL } else { 'http://127.0.0.1:3090/mcp/session-inject' })
)

$ErrorActionPreference = 'Stop'
$auth = @()
if ($env:DSH_SESSION_INJECT_TOKEN) { $auth = @('-H', "Authorization: Bearer $env:DSH_SESSION_INJECT_TOKEN") }

if (-not $SessionId) {
  $payload = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sessions_list","arguments":{}}}'
} else {
  $payload = @{
    jsonrpc = '2.0'
    id = 2
    method = 'tools/call'
    params = @{
      name = 'session_inject'
      arguments = @{
        session_id = $SessionId
        content = $Content
        delivery = 'queue'
        wait_ms = 180000
      }
    }
  } | ConvertTo-Json -Depth 8 -Compress
}

$tmp = Join-Path $env:TEMP ('dsh-session-inject-' + [guid]::NewGuid().ToString('N') + '.json')
[System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))
try {
  & curl.exe -sS -X POST $Url -H 'content-type: application/json' @auth --data-binary "@$tmp"
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
