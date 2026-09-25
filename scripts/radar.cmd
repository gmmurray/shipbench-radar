@echo off
rem Desktop launcher for Radar. Double-click it, or the shortcut that
rem `pnpm shortcut` puts on the desktop. The window shows the server starting,
rem then takes single keys: o opens Radar in a new browser tab, q quits.
title Radar
cd /d "%~dp0.."
call pnpm --silent run console
if errorlevel 1 (
  echo.
  echo Radar stopped with an error. Press any key to close this window.
  pause >nul
)
