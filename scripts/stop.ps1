<#
  LiteMind Engine — корректная остановка (Windows PowerShell).
  Использование:  .\scripts\stop.ps1              - остановить на http://127.0.0.1:8399
                   .\scripts\stop.ps1 -Port 8400
                   .\scripts\stop.ps1 -Force       - только если мягкая остановка не удалась

  Безопасность: завершаются ТОЛЬКО процессы node.exe, в командной строке которых
  присутствует путь к bin\litemind.js ЭТОГО проекта. Посторонние процессы не трогаются.
  Никакие модели и данные не удаляются.
#>
[CmdletBinding()]
param(
  [int]$Port = 8399,
  [switch]$Force
)

# Кодировка вывода: при перенаправлении (логи, пайпы) — UTF-8; в окне консоли — как есть
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { } }

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$target = (Join-Path $Root 'bin\litemind.js')

# --- 1. Мягкая остановка через HTTP (завершает генерацию и закрывает сервер) --
$stoppedSoft = $false
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/stop" -Method POST -UseBasicParsing -TimeoutSec 3 `
    -Headers @{ 'content-type' = 'application/json' } -Body '{}' | Out-Null
  Write-Host "Активные запросы отменены."
} catch { }

try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/shutdown" -Method POST -UseBasicParsing -TimeoutSec 3 `
    -Headers @{ 'content-type' = 'application/json' } -Body '{}' | Out-Null
  $stoppedSoft = $true
  Write-Host "Сервер получил команду на остановку."
  Start-Sleep -Milliseconds 1500
} catch { }

# --- 2. Проверка: не остался ли процесс --------------------------------------
function Get-LiteMindProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($target) }
}

$left = @(Get-LiteMindProcesses)
if ($left.Count -eq 0) {
  Write-Host "LiteMind Engine не запущен (порт $Port свободен)." -ForegroundColor Green
  exit 0
}

# --- 3. Форс-остановка только своих процессов --------------------------------
if ($Force -or -not $stoppedSoft) {
  foreach ($p in $left) {
    Write-Host "Завершение процесса PID $($p.ProcessId) (свой: содержит $target)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 700
}

$left = @(Get-LiteMindProcesses)
if ($left.Count -eq 0) {
  Write-Host "LiteMind Engine остановлен." -ForegroundColor Green
  exit 0
}

Write-Host "ОШИБКА: процесс(ы) ещё работают: $($left.ProcessId -join ', ')" -ForegroundColor Red
exit 1
