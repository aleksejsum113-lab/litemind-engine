<#
  LiteMind Engine — запуск движка (Windows PowerShell).
  Использование:  .\scripts\start.ps1            - конфигурация для слабого ПК (по умолчанию)
                   .\scripts\start.ps1 -LowSpec:$false   - стандартная конфигурация
                   .\scripts\start.ps1 -Port 8400 -Config "C:\path\config.json"
  Ничего не устанавливает и не скачивает. Ollama только проверяется на доступность.
#>
[CmdletBinding()]
param(
  [int]$Port = 8399,
  [string]$Config = "",
  [bool]$LowSpec = $true,
  [switch]$SkipOllamaCheck
)

# Кодировка вывода: при перенаправлении (логи, пайпы) — UTF-8; в окне консоли — как есть
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { } }

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Exit-With([int]$Code, [string]$Message) {
  if ($Message) { Write-Host $Message }
  exit $Code
}

# --- 1. Проверка Node.js (единственная обязательная зависимость) -------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "ОШИБКА: не найден Node.js." -ForegroundColor Red
  Write-Host "Установите Node.js 18.17 или новее с https://nodejs.org (бесплатно, LTS),"
  Write-Host "затем откройте новый терминал и повторите запуск."
  exit 1
}
$nodeVer = (node -v) -replace '^v', ''
try {
  $ver = [version]($nodeVer -split '-')[0]
  if ($ver -lt [version]'18.17.0') {
    Write-Host "ОШИБКА: Node.js $nodeVer старше требуемой 18.17.0." -ForegroundColor Red
    Write-Host "Обновите: https://nodejs.org"
    exit 1
  }
} catch { Write-Warning "Не удалось определить версию Node.js ($nodeVer) — продолжаю." }

# --- 2. Конфигурация --------------------------------------------------------
if (-not $Config -and $LowSpec) {
  $candidate = Join-Path $Root 'config\litemind.low-spec.json'
  if (Test-Path $candidate) { $Config = $candidate }
}
if ($Config) {
  if (-not (Test-Path $Config)) {
    Write-Host "ОШИБКА: файл конфигурации не найден: $Config" -ForegroundColor Red
    exit 1
  }
  $env:LITEMIND_CONFIG = (Resolve-Path $Config).Path
  Write-Host "Конфигурация: $env:LITEMIND_CONFIG"
} else {
  Write-Host "Конфигурация: значения по умолчанию (или %APPDATA%\LiteMind\config.json)"
}

# --- 3. Проверка Ollama (только чтение, ничего не ставим) -------------------
if (-not $SkipOllamaCheck) {
  $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
  $ollamaHttp = $false
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 2
    $ollamaHttp = $true
    Write-Host "Ollama: работает ($($resp.Content))"
  } catch { }
  if (-not $ollamaHttp) {
    Write-Warning "Ollama не отвечает на 127.0.0.1:11434."
    if ($ollamaCmd) { Write-Host "  Команда найдена, но служба не запущена — запустите приложение Ollama из меню Пуск." }
    else { Write-Host "  Ollama не установлена. Ставьте только сами: https://ollama.com/download" }
    Write-Host "  Движок запустится и без неё: панель и API работать будут, генерация вернёт понятную ошибку."
  }
}

# --- 4. Краткая сводка о системе --------------------------------------------
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $freeMb = [math]::Round($os.FreePhysicalMemory / 1KB)
  Write-Host "Свободная RAM: $freeMb МБ (всего $([math]::Round($os.TotalVisibleMemorySize/1KB)) МБ)"
  if ($freeMb -lt 4000) { Write-Warning "Меньше 4000 МБ свободно — генерация может быть отклонена проверкой памяти (это защита)." }
} catch { }

# --- 5. Запуск ---------------------------------------------------------------
$entry = Join-Path $Root 'bin\litemind.js'
if (-not (Test-Path $entry)) {
  Write-Host "ОШИБКА: не найдена точка входа $entry" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "LiteMind Engine запускается: http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "Остановка: другое окно -> .\scripts\stop.ps1   (или Ctrl+C здесь)"
Write-Host ""
& node $entry serve --port $Port
exit $LASTEXITCODE
