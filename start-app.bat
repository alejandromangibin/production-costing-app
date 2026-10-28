@echo off
rem Double-click this file to run Production Costing on Windows.
rem It installs what is needed the first time, then starts the app and opens your browser.
cd /d "%~dp0"

if not exist node_modules (
  echo First-time setup: installing. This takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Make sure Node.js is installed and you are online, then try again.
    pause
    exit /b 1
  )
)

echo Starting Production Costing. Keep this window open while you use the app.
echo To stop the app, close this window.
start "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:3001"
call npm start
pause
