@echo off
title Mealio Flow Maps
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node serve.js
  goto :end
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" serve.js
  goto :end
)

echo Node was not found, falling back to Python...
python -m http.server 8777 --bind 127.0.0.1
if %errorlevel% neq 0 (
  echo.
  echo Could not start a server: neither Node nor Python is available.
  echo You can still open index.html directly in a browser.
  pause
)

:end
