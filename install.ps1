# dsh-session-inject - install helper (Windows PowerShell).
#
# Registers this directory as a bundle in one or more dsh profiles:
#   1. `dsh plugin --profile <p> add <this-dir>`  (pnpm link + dependency)
#   2. ensures "dsh-session-inject" is in dsh.profile.bundles
#
# Usage:
#   pwsh -File .\install.ps1
#   pwsh -File .\install.ps1 -Profiles web
#
# Restart dsh afterwards (or run `workspace_control action=refresh` in a live
# session) to load the plugin. It listens on http://127.0.0.1:3090 by default.
param(
  [string[]]$Profiles = @('web', 'desktop')
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'dsh is not on PATH. Run: dsh plugin --profile <profile> add "<dir>"'
}

foreach ($profile in $Profiles) {
  Write-Host "== profile: $profile =="
  & dsh plugin --profile $profile add $source
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed for profile $profile" }

  $pkgPath = Join-Path $env:USERPROFILE ".dsh\profiles\$profile\package.json"
  if (-not (Test-Path $pkgPath)) { throw "missing profile package.json: $pkgPath" }

  $json = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
  $pkg = $json | ConvertFrom-Json
  $bundles = @($pkg.dsh.profile.bundles)
  if ($bundles -notcontains 'dsh-session-inject') {
    $pkg.dsh.profile.bundles = @($bundles + 'dsh-session-inject')
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 10), $utf8)
    Write-Host "added dsh-session-inject to dsh.profile.bundles"
  } else {
    Write-Host "dsh.profile.bundles already lists dsh-session-inject"
  }
}

Write-Host ''
Write-Host 'Done. Restart dsh, then check:'
Write-Host '  curl http://127.0.0.1:3090/health'
