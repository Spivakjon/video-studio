@echo off
chcp 65001 >nul
title New Video — Video Studio
cd /d "%~dp0"
cls
echo.
echo    ✨ NEW VIDEO
echo    ═══════════════════════════════════════
echo    Claude will walk you through creating a new video
echo.
echo    Tell Claude:
echo      * what product/topic
echo      * which brand (kikkaboo / dubai / ...)
echo      * image URLs or paths (optional)
echo.
echo    Claude will write a script for approval BEFORE any TTS/render.
echo.
claude "קרא את CLAUDE.md. אני רוצה ליצור סרטון חדש. שאל אותי על המוצר, המותג, והתמונות שברשותי. אחרי שאני עונה, כתוב את התסריט המלא בטבלה ממוספרת וחכה ל״אשר״ לפני TTS או רנדר."
