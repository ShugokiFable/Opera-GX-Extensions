@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 server.py --show-token) else (python server.py --show-token)
pause
endlocal
