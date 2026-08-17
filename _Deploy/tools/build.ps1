#requires -version 5
<#
  One script. Validates every extension in this repo, signs a .crx for each with
  Opera GX's own packer, drops the packages in Release\, and reports what your
  browser is currently running against what was just built.

  There is no staging copy anywhere on the system. Every extension has its public
  key pinned in its manifest, so its ID comes from the key rather than from a
  folder path - which is what makes a plain source folder safe to load unpacked
  and a .crx safe to move between machines.
#>
[CmdletBinding()]
param(
  [string]$Opera,
  [switch]$NoZip,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ToolsDir    = $PSScriptRoot
$DeployDir   = Split-Path $ToolsDir -Parent
$SourceRoot  = Split-Path $DeployDir -Parent
$KeyDir      = Join-Path $DeployDir 'keys'
$ReleaseDir  = Join-Path $SourceRoot 'Release'
$StageRoot   = Join-Path $env:TEMP ('gx-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$SkipNames   = @('_Deploy', 'zSources', 'Release', 'node_modules')

function Write-Head([string]$text) {
  Write-Host ''
  Write-Host $text -ForegroundColor Magenta
  Write-Host ('-' * $text.Length) -ForegroundColor DarkMagenta
}

if (-not $Opera) {
  $Opera = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Opera GX\opera.exe'),
    (Join-Path $env:ProgramFiles 'Opera GX\opera.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Opera GX\opera.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Opera) { Write-Host 'Opera GX not found. Pass -Opera "<path to opera.exe>".' -ForegroundColor Red; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js is required to derive public keys.' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Path $KeyDir, $ReleaseDir, $StageRoot -Force | Out-Null

function Get-Slug($manifest, [string]$fallback) {
  $base = $manifest.short_name
  if ([string]::IsNullOrWhiteSpace($base)) { $base = $manifest.name }
  if ([string]::IsNullOrWhiteSpace($base)) { $base = $fallback }
  $slug = ($base.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'extension' }
  return $slug
}

# The packer writes <dir>.crx beside the directory and exits non-zero even when
# it succeeds, so the produced file is the only reliable signal.
function Invoke-Pack([string]$dir, [string]$keyPath) {
  $arguments = @("--pack-extension=`"$dir`"")
  if ($keyPath) { $arguments += "--pack-extension-key=`"$keyPath`"" }
  $process = Start-Process $Opera -ArgumentList $arguments -PassThru -WindowStyle Hidden
  $process | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue
  if (-not $process.HasExited) { $process | Stop-Process -Force; throw "packer timed out for $dir" }
  if (-not (Test-Path "$dir.crx")) { throw "packer produced no .crx for $dir" }
  return "$dir.crx"
}

function Set-ManifestKey([string]$path, [string]$publicKey) {
  $raw = Get-Content $path -Raw
  if ($raw -match '"key"\s*:\s*"[^"]*"') {
    $text = [regex]::Replace($raw, '"key"\s*:\s*"[^"]*"', ('"key": "' + $publicKey + '"'))
  } else {
    $newline = "`n"; if ($raw.Contains("`r`n")) { $newline = "`r`n" }
    $lines = $raw -split "`r?`n"
    $anchor = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '"manifest_version"\s*:') { $anchor = $i; break } }
    if ($anchor -lt 0) { return $false }
    $indent = ([regex]::Match($lines[$anchor], '^[ \t]*')).Value
    $updated = @(); $updated += $lines[0..$anchor]; $updated += ('{0}"key": "{1}",' -f $indent, $publicKey)
    if ($anchor + 1 -le $lines.Count - 1) { $updated += $lines[($anchor + 1)..($lines.Count - 1)] }
    $text = ($updated -join $newline)
  }
  try { $text | ConvertFrom-Json | Out-Null } catch { return $false }
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

function Get-InstalledIndex {
  $index = @{}
  $prefs = Join-Path $env:APPDATA 'Opera Software\Opera GX Stable\Default\Secure Preferences'
  if (-not (Test-Path $prefs)) { return $index }
  try { $json = Get-Content $prefs -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $index }
  foreach ($entry in $json.extensions.opsettings.PSObject.Properties) {
    $name = $entry.Value.manifest.name
    if ($name) { $index[$name] = [pscustomobject]@{ Id = $entry.Name; Version = $entry.Value.manifest.version; Path = $entry.Value.path } }
  }
  return $index
}

Write-Head 'GX Extension Builder'
Write-Host "  source  : $SourceRoot"
Write-Host "  output  : $ReleaseDir"

$installed = Get-InstalledIndex
$built = New-Object System.Collections.Generic.List[object]
$notes = New-Object System.Collections.Generic.List[string]

Write-Head 'Building'
foreach ($dir in (Get-ChildItem $SourceRoot -Directory)) {
  if ($SkipNames -contains $dir.Name) { continue }
  $manifestPath = Join-Path $dir.FullName 'manifest.json'
  if (-not (Test-Path $manifestPath)) { continue }

  try { $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Host "  SKIP  $($dir.Name) (manifest.json is not valid JSON)" -ForegroundColor Red; continue }

  $slug = Get-Slug $manifest $dir.Name
  $key = Join-Path $KeyDir "$slug.pem"

  # A missing key is not fatal: mint a fresh one. The cost is a new extension ID,
  # which means the next .crx installs alongside the old copy instead of updating
  # it, so say that out loud rather than letting it be discovered later.
  if (-not (Test-Path $key)) {
    $seed = Join-Path $StageRoot "$slug-seed"
    Copy-Item $dir.FullName $seed -Recurse -Force
    Invoke-Pack $seed $null | Out-Null
    Move-Item "$seed.pem" $key -Force
    Remove-Item "$seed.crx", $seed -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  NEWKEY  $slug  (no signing key existed - a fresh identity was generated)" -ForegroundColor Yellow
    $notes.Add("$slug got a brand new signing key, so its .crx installs as a new extension rather than updating an existing one. Remove the old card once.")
  }

  $identity = node (Join-Path $ToolsDir 'pubkey.cjs') $key | ConvertFrom-Json
  if ($manifest.key -ne $identity.key) {
    if ($manifest.key) { $notes.Add("$slug had a different key pinned; its ID is now $($identity.id).") }
    if (Set-ManifestKey $manifestPath $identity.key) { Write-Host "  PIN     $slug -> $($identity.id)" -ForegroundColor Cyan }
  }

  $stage = Join-Path $StageRoot $slug
  Copy-Item $dir.FullName $stage -Recurse -Force
  Remove-Item (Join-Path $stage '.git') -Recurse -Force -ErrorAction SilentlyContinue
  $crx = Invoke-Pack $stage $key
  $crxTarget = Join-Path $ReleaseDir ("{0}-v{1}.crx" -f $slug, $manifest.version)
  Get-ChildItem $ReleaseDir -Filter "$slug-v*.crx" | Remove-Item -Force -ErrorAction SilentlyContinue
  Move-Item $crx $crxTarget -Force

  if (-not $NoZip) {
    $zipTarget = Join-Path $ReleaseDir ("{0}-v{1}.zip" -f $slug, $manifest.version)
    Get-ChildItem $ReleaseDir -Filter "$slug-v*.zip" | Remove-Item -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipTarget -CompressionLevel Optimal
  }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

  $live = $installed[$manifest.name]
  $state = 'not installed'
  if ($live) {
    if ($live.Version -eq $manifest.version) { $state = "installed, up to date" }
    else { $state = "installed v$($live.Version) - drag to update" }
  }

  $built.Add([pscustomobject]@{
    Extension = $slug
    Version   = $manifest.version
    Id        = $identity.id
    Browser   = $state
  })
  Write-Host ("  OK      {0,-16} v{1,-8} {2}" -f $slug, $manifest.version, $state) -ForegroundColor Green
}

Remove-Item $StageRoot -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem $ReleaseDir -File | Where-Object { $_.Extension -in @('.crx', '.zip') } | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.Name
} | Set-Content (Join-Path $ReleaseDir 'SHA256SUMS.txt') -Encoding utf8

Write-Head 'Result'
$built | Format-Table Extension, Version, Id, Browser -AutoSize | Out-String | Write-Host

if ($notes.Count -gt 0) {
  Write-Head 'Read this'
  foreach ($note in $notes) { Write-Host "  $note" -ForegroundColor Yellow }
}

Write-Head 'Install or update'
Write-Host '  Drag the .crx files from Release onto opera://extensions.'
Write-Host '  Same key + higher version = in-place update, settings kept.'
Write-Host ''
Write-Host "  keys live in $KeyDir - back that folder up." -ForegroundColor Yellow
Write-Host '  Lose it and the next build mints a new identity automatically; the'
Write-Host '  only cost is removing the old card once.'

if (-not $NoLaunch) { Start-Process explorer.exe $ReleaseDir }
Write-Host ''
