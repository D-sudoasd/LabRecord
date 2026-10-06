@echo off
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0release\win-unpacked\LabRecord.exe" (
  echo LabRecord.exe was not found. Please build or extract the complete Windows package.
  pause
  exit /b 1
)
start "" "%~dp0release\win-unpacked\LabRecord.exe"
