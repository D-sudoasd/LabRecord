@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "LABRECORD_LAUNCH_ROOT=%~dp0"
set "LABRECORD_EXE="
rem Prefer the current versioned release and reject an outdated unversioned build.
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $v=(Get-Content -LiteralPath (Join-Path $env:LABRECORD_LAUNCH_ROOT 'package.json') -Raw | ConvertFrom-Json).version; if ($v -notmatch '^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { exit 1 }; $want=[version]$Matches[1]; $paths=@((Join-Path $env:LABRECORD_LAUNCH_ROOT ('release\' + $v + '\win-unpacked\LabRecord.exe'))); if ($v -match '^\d+\.\d+\.\d+$') { $paths += (Join-Path $env:LABRECORD_LAUNCH_ROOT 'release\win-unpacked\LabRecord.exe') }; foreach ($path in $paths) { if (Test-Path -LiteralPath $path -PathType Leaf) { try { $got=[version](Get-Item -LiteralPath $path).VersionInfo.FileVersion } catch { continue }; if ($got.Major -eq $want.Major -and $got.Minor -eq $want.Minor -and $got.Build -eq $want.Build) { $path; exit 0 } } }; exit 1"`) do set "LABRECORD_EXE=%%I"
if not defined LABRECORD_EXE (
  echo Matching LabRecord.exe was not found. Please build or extract the current version.
  pause
  exit /b 1
)
start "" "%LABRECORD_EXE%"
