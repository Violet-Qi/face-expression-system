@echo off
rem ============================================================
rem  Launcher.
rem  This file is intentionally pure ASCII: cmd.exe mis-parses
rem  Chinese text inside .bat files that are saved as GBK.
rem  All Chinese messages live in start-server.ps1 instead.
rem ============================================================
rem Switch the console to UTF-8 so the Node server can print Chinese
rem log lines correctly. This line itself is pure ASCII on purpose.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"