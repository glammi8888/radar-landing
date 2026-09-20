@echo off
REM Double-click this file to start App Opportunity Scout. No typing required.
cd /d "%~dp0"

set PY=
for %%C in (python py) do (
  if not defined PY (
    %%C -c "import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)" >nul 2>&1 && set PY=%%C
  )
)

if not defined PY (
  echo.
  echo   Python 3.9+ was not found on this PC.
  echo   Install it from https://www.python.org/downloads/
  echo   IMPORTANT: tick "Add Python to PATH" during setup, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting App Opportunity Scout...
echo   Your browser will open at http://localhost:8787
echo   Leave this window open while you work. Close it to stop.
echo.
start "" http://localhost:8787
%PY% scout.py --port 8787
pause
