# Restart ONLY the SYU guard console (port 8789).
# Safety: the process is killed only when it owns port 8789 AND its command line
# runs src\console\server.ts. Anything else on that port is reported, never killed.
param([int]$Port = 8789)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'src\console\server.ts'))) {
  Write-Host "not a Syu workspace, abort: $root" -ForegroundColor Red
  exit 2
}

function Get-SyuListener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

$listener = Get-SyuListener
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.OwningProcess)
  if (-not $proc) {
    Write-Host "port $Port is held by pid $($listener.OwningProcess), but that process is gone; abort." -ForegroundColor Red
    exit 3
  }
  $name = [string]$proc.Name
  $cmd = [string]$proc.CommandLine
  $isNode = $name -ieq 'node.exe'
  $isConsole = $cmd -match 'src[\\/]console[\\/]server\.ts'
  if (-not ($isNode -and $isConsole)) {
    Write-Host "port $Port is NOT held by the SYU console; nothing was killed." -ForegroundColor Red
    Write-Host ("  pid : {0}" -f $proc.ProcessId)
    Write-Host ("  name: {0}" -f $name)
    Write-Host ("  cmd : {0}" -f $cmd)
    exit 3
  }
  Write-Host ("stopping SYU console: pid {0}" -f $proc.ProcessId)
  Write-Host ("  {0}" -f $cmd)
  Stop-Process -Id $proc.ProcessId -Force
  $freed = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-SyuListener)) { $freed = $true; break }
  }
  if (-not $freed) {
    Write-Host "port $Port is still in use after stopping pid $($proc.ProcessId); abort." -ForegroundColor Red
    exit 4
  }
} else {
  Write-Host "SYU console is not running on port $Port."
}

Write-Host "starting SYU console (start.bat console) ..."
& (Join-Path $root 'start.bat') console
if ($LASTEXITCODE -ne 0) {
  Write-Host "start.bat failed, exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}
Write-Host "console restarted. If a tab was already open, press Ctrl+F5."
