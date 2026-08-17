@echo off
setlocal
cd /d "%~dp0"
echo Updating NebulaGrab extraction stack to the latest yt-dlp nightly...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m pip install --upgrade --pre "yt-dlp[default,curl-cffi]"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    python -m pip install --upgrade --pre "yt-dlp[default,curl-cffi]"
  ) else (
    echo Python 3 was not found.
    goto :end
  )
)
where winget >nul 2>nul
if %errorlevel%==0 (
  winget upgrade --id DenoLand.Deno --exact --accept-package-agreements --accept-source-agreements
  winget upgrade --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
)
:end
pause
endlocal
