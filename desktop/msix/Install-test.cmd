@echo off
rem Installs the Nexum TEST package: trusts its throwaway certificate on this
rem PC, then installs the _test.msix next to this file. Asks for admin rights.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "try {" ^
  "  foreach ($s in 'TrustedPeople','Root') {" ^
  "    Import-Certificate -FilePath .\nexum-test.cer -CertStoreLocation ('Cert:\LocalMachine\' + $s) | Out-Null" ^
  "  }" ^
  "  $m = Get-ChildItem *_test.msix | Select-Object -First 1;" ^
  "  Add-AppxPackage -Path $m.FullName;" ^
  "  Write-Host ''; Write-Host 'Installed. Find Eve-Nexum in the Start menu.' -ForegroundColor Green" ^
  "} catch {" ^
  "  Write-Host ''; Write-Host 'Install failed:' -ForegroundColor Red; Write-Host $_" ^
  "}"
echo.
pause
