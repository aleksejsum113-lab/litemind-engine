<#
  LiteMind Engine — запуск автотестов (Windows PowerShell).
  Тесты БЕЗОПАСНЫ: работают на mock-сервере, Ollama не нужны, модели не скачиваются
  и не запускаются, настройки Windows не меняются. Нагрузки на систему нет (~3-4 сек).
  Использование:  .\scripts\test.ps1                 - все тесты
                   .\scripts\test.ps1 -Filter "api"  - только тесты с "api" в имени
#>
[CmdletBinding()]
param([string]$Filter = "")

# Кодировка вывода: при перенаправлении (логи, пайпы) — UTF-8; в окне консоли — как есть
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { } }

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "ОШИБКА: не найден Node.js. Установите https://nodejs.org (18.17+), Python не нужен." -ForegroundColor Red
  exit 1
}

Push-Location $Root
try {
  Write-Host "Запуск автотестов (mock-данные, без моделей)..." -ForegroundColor Cyan
  if ($Filter) {
    & node --test --test-name-pattern $Filter "test/*.test.js"
  } else {
    & node --test "test/*.test.js"
  }
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -eq 0) { Write-Host "Все тесты прошли." -ForegroundColor Green }
else { Write-Host "Есть упавшие тесты (код $code)." -ForegroundColor Red }
exit $code
