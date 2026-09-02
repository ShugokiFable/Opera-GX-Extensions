param(
  [string]$KeyPath = "$PSScriptRoot\private\signing-key.pem"
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install Node.js 20+ and reopen PowerShell.'
  }
  if (-not (Test-Path $KeyPath)) {
    throw "CRX signing key not found: $KeyPath"
  }
  npm run verify
  if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
  npm run release -- --key "$KeyPath"
  if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
  Write-Host "`nRelease files are in: $PSScriptRoot\release" -ForegroundColor Green
} finally {
  Pop-Location
}
