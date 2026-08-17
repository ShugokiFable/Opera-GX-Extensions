@echo off
title Opera GX Extensions - Build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build.ps1" %*
echo.
pause
