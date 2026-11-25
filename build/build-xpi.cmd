@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0.."
set "OUTDIR=%~dp0"
set "MANIFEST=%ROOT%\manifest.json"

for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$m = Get-Content -Raw '%MANIFEST%' | ConvertFrom-Json; $m.version"`) do (
  set "VERSION=%%a"
)

if "!VERSION!"=="" (
  echo Could not read version from manifest
  pause
  exit /b 1
)

set "ZIP=%OUTDIR%ScreenZot-!VERSION!.zip"
set "XPI=%OUTDIR%ScreenZot-!VERSION!.xpi"

echo Creating !XPI!...

if exist "!ZIP!" del "!ZIP!"
if exist "!XPI!" del "!XPI!"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%ROOT%\manifest.json','%ROOT%\bootstrap.js','%ROOT%\output.js' -DestinationPath '!ZIP!'"
rename "!ZIP!" "ScreenZot-!VERSION!.xpi"

echo Done.
pause
