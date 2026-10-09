@echo off
rem ============================================================
rem  Launcher.
rem  This file is intentionally pure ASCII: cmd.exe mis-parses
rem  Chinese text inside .bat files that are saved as GBK.
rem  All Chinese messages live in start-server.ps1 instead.
rem ============================================================
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"