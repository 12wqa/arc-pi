@echo off
REM ARC proof-of-concept autodriver wrapper for Windows.
REM Usage: scripts\arc-driver.bat "pi"
set WINDOW_TITLE=%~1
if "%WINDOW_TITLE%"=="" set WINDOW_TITLE=pi
powershell.exe -ExecutionPolicy Bypass -File "%~dp0arc-driver.ps1" -WindowTitle "%WINDOW_TITLE%"
