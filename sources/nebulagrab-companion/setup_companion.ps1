$ErrorActionPreference = "Stop"
Write-Host "NebulaGrab Companion 1.3 setup" -ForegroundColor Magenta

$Python = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $Python = @("py", "-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $Python = @("python")
} else {
    Write-Host "Python 3.11 or newer is missing. Install it from python.org or Microsoft Store first." -ForegroundColor Red
    exit 1
}

function Invoke-Python {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    if ($Python.Count -eq 2) {
        & $Python[0] $Python[1] @Arguments
    } else {
        & $Python[0] @Arguments
    }
    if ($LASTEXITCODE -ne 0) { throw "Python command failed with exit code $LASTEXITCODE" }
}

Write-Host "Installing the current yt-dlp nightly with browser impersonation support..." -ForegroundColor Yellow
Invoke-Python -m pip install --upgrade pip
Invoke-Python -m pip install --upgrade --pre "yt-dlp[default,curl-cffi]"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Installing ffmpeg through winget..." -ForegroundColor Yellow
        winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
    } else {
        Write-Host "ffmpeg is missing and winget is unavailable. Install ffmpeg and add it to PATH, or place ffmpeg.exe in companion\bin\." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "ffmpeg is ready." -ForegroundColor Green
}

if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "Installing Deno for modern JavaScript challenge support..." -ForegroundColor Yellow
        winget install --id DenoLand.Deno --exact --accept-package-agreements --accept-source-agreements
    } else {
        Write-Host "Deno is not installed. Smart Fetch still works on many sites, but current YouTube support may be incomplete." -ForegroundColor Yellow
    }
} else {
    Write-Host "Deno is ready." -ForegroundColor Green
}

Write-Host "`nInstalled tool versions:" -ForegroundColor Cyan
Invoke-Python -m yt_dlp --version
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { ffmpeg -version | Select-Object -First 1 }
if (Get-Command deno -ErrorAction SilentlyContinue) { deno --version | Select-Object -First 1 }

Write-Host "`nSetup complete. Open a fresh terminal if winget changed PATH, run start_helper.bat, then paste the displayed token into NebulaGrab Settings." -ForegroundColor Green
