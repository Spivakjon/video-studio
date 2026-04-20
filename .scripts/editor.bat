@echo off
chcp 65001 >nul
title Video Studio Editor (web)
cd /d "%~dp0"
cls
echo.
echo    🎛  VIDEO STUDIO — Web Editor
echo    ═══════════════════════════════════════
echo    Starting editor server on http://localhost:3003
echo.
echo    (Press Ctrl+C to stop)
echo.
start "" "http://localhost:3003"
npm run studio
