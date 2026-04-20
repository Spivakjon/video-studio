@echo off
chcp 65001 >nul
title Video Studio
cd /d "%~dp0"
cls
echo.
echo    🎬 VIDEO STUDIO
echo    ═══════════════════════════════════════
echo    Conversational video production via Claude Code
echo.
echo    Project: %CD%
echo.
echo    You can say things like:
echo      * "בוא ניצור סרטון חדש על X של Kikkaboo"
echo      * "ערוך את הטקסטים של ivan-demo"
echo      * "רנדר את video-name באיכות גבוהה"
echo      * "תראה לי מה יש לי בסטודיו"
echo.
echo    Starting Claude Code...
echo.
claude "קרא את CLAUDE.md ותגיד לי מה יש בסטודיו כרגע (סרטונים ותבניות זמינים). אני מוכן לעבוד — מה אתה רוצה שאעשה?"
