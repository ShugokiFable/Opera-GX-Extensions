@echo off
setlocal
cd /d "%~dp0"
call npm run verify || goto :fail
call npm run release:unsigned || goto :fail
echo.
echo Unsigned release files are in: %CD%\release
exit /b 0
:fail
echo.
echo Build failed.
pause
exit /b 1
