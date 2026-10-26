<#
  LiteMind Engine — диагностика системы и Ollama (Windows PowerShell).
  Только чтение: ничего не устанавливает, не скачивает и не изменяет.
  Использование:  .\scripts\doctor.ps1
#>
[CmdletBinding()]
param()

# Кодировка вывода: при перенаправлении (логи, пайпы) — UTF-8; в окне консоли — как есть
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { } }

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$problems = 0
$warnings = 0

function OK([string]$m)  { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function WARN([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:warnings++ }
function BAD([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:problems++ }

Write-Host "=== LiteMind Engine — диагностика ==="

# --- Windows ----------------------------------------------------------------
Write-Host "`n-- Windows --"
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -ge 22000)      { OK "$($os.Caption), сборка $build (Windows 11)" }
elseif ($build -ge 19045) { OK "$($os.Caption), сборка $build (Windows 10 22H2+)" }
else                       { BAD "$($os.Caption), сборка $build — нужен Windows 10 22H2 или новее" }
if ($os.OSArchitecture -notlike '*64*') { BAD "архитектура $($os.OSArchitecture) — нужна 64-бит" }
else { OK "архитектура $($os.OSArchitecture)" }

# --- Оборудование -----------------------------------------------------------
Write-Host "`n-- Оборудование --"
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
OK "CPU: $($cpu.Name.Trim()) ($($cpu.NumberOfCores) ядер / $($cpu.NumberOfLogicalProcessors) потоков)"
$freeMb  = [math]::Round($os.FreePhysicalMemory / 1KB)
$totalMb = [math]::Round($os.TotalVisibleMemorySize / 1KB)
if ($totalMb -lt 8192) { BAD "RAM $totalMb МБ — рекомендуется от 8192 МБ" }
elseif ($freeMb -lt 4000) { WARN "RAM свободно только $freeMb МБ из $totalMb МБ — перед генерацией закройте лишнее" }
else { OK "RAM: $freeMb МБ свободно из $totalMb МБ" }

# --- Диск -------------------------------------------------------------------
Write-Host "`n-- Диск --"
$c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$cFreeGb = [math]::Round($c.FreeSpace / 1GB, 1)
if ($cFreeGb -lt 5) { WARN "C: свободно $cFreeGb ГБ — под Ollama и модель нужно от ~5 ГБ" }
else { OK "C: свободно $cFreeGb ГБ" }
$drive = Split-Path -Qualifier $Root
if ($drive -ne 'C:') {
  $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
  OK "$drive`: свободно $([math]::Round($d.FreeSpace/1GB,1)) ГБ (папка проекта)"
}

# --- Node.js ----------------------------------------------------------------
Write-Host "`n-- Node.js (обязательная зависимость) --"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  BAD "Node.js не найден. Установите с https://nodejs.org (LTS, бесплатно). Python не нужен."
} else {
  $nv = (node -v) -replace '^v', ''
  try {
    if ([version]($nv -split '-')[0] -lt [version]'18.17.0') { BAD "Node.js $nv — нужно 18.17.0 или новее" }
    else { OK "Node.js $nv" }
  } catch { WARN "Node.js $nv — версию проверить не удалось" }
}

# --- Ollama -----------------------------------------------------------------
Write-Host "`n-- Ollama (необязательна, для генерации) --"
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaCmd) { OK "команда ollama найдена: $($ollamaCmd.Source)" }
else { WARN "Ollama не установлена — генерация будет недоступна. Ставить сами: https://ollama.com/download" }

$ollamaOk = $false
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 2
  OK "Ollama отвечает: $($r.Content)"
  $ollamaOk = $true
} catch { WARN "Ollama не отвечает на 127.0.0.1:11434 (служба не запущена?)" }

if ($ollamaOk) {
  try {
    $tags = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 3
    $models = ($tags.Content | ConvertFrom-Json).models
    if ($models -and $models.Count -gt 0) {
      OK "модели установлены: $((@($models) | ForEach-Object { $_.name }) -join ', ')"
    } else {
      WARN "моделей нет. Одна маленькая: ollama pull qwen2.5:0.5b (~400 МБ) — только по вашему решению"
    }
  } catch { WARN "список моделей получить не удалось" }
}

# --- Проект -----------------------------------------------------------------
Write-Host "`n-- Проект LiteMind --"
$entry = Join-Path $Root 'bin\litemind.js'
if (Test-Path $entry) { OK "точка входа: $entry" } else { BAD "не найден bin\litemind.js" }
$lowSpec = Join-Path $Root 'config\litemind.low-spec.json'
if (Test-Path $lowSpec) { OK "конфигурация слабого ПК: config\litemind.low-spec.json" } else { WARN "нет config\litemind.low-spec.json" }
$cfgPath = Join-Path $env:APPDATA 'LiteMind\config.json'
if (Test-Path $cfgPath) { OK "пользовательский конфиг: $cfgPath" } else { WARN "пользовательский конфиг ещё не создан (будет при первом сохранении)" }

# --- Движок -----------------------------------------------------------------
Write-Host "`n-- Движок --"
if (Test-Path $entry) {
  & node $entry doctor
  if ($LASTEXITCODE -ne 0) { $script:warnings++ }
}

Write-Host ""
if ($problems -gt 0) {
  Write-Host "ИТОГ: найдено критичных проблем: $problems, предупреждений: $warnings" -ForegroundColor Red
  exit 1
}
Write-Host "ИТОГ: критичных нет, предупреждений: $warnings" -ForegroundColor Green
exit 0
