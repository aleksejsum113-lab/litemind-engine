; ============================================================
;  LiteMind Engine — установщик (NSIS, бесплатно)
;
;  Сборка:   makensis.exe installer\litemind.nsi
;  Результат: installer\Output\LiteMind-Setup-0.1.0.exe
;
;  Принципы (ТЗ):
;   - офлайн-установка, без сети и без моделей;
;   - не запускает Ollama, ничего не скачивает;
;   - не трогает %APPDATA%\LiteMind (конфиг) и ~/.ollama (модели);
;   - не требует Python; единственная проверка — Node.js 18+;
;   - удаляется через «Приложения», настройки удаляются только по желанию.
; ============================================================

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define PRODUCT_NAME        "LiteMind Engine"
!define PRODUCT_VERSION     "0.1.0"
!define PRODUCT_PUBLISHER   "LiteMind Engine contributors"
!define PRODUCT_URL         "https://github.com/"
!define PRODUCT_EXE         "Uninstall.exe"
!define APP_REGKEY          "Software\LiteMindEngine"
!define UNINST_REGKEY       "Software\Microsoft\Windows\CurrentVersion\Uninstall\LiteMindEngine"

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "Output\LiteMind-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\LiteMind Engine"
InstallDirRegKey HKCU "${APP_REGKEY}" "InstallDir"
RequestExecutionLevel user          ; установка без прав администратора
Unicode true
CRCCheck on
SetCompressor /SOLID lzma
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION}"
ShowInstDetails show
ShowUninstDetails show
; Проверка версии ОС — явно в .onInit (даёт понятное сообщение вместо отказа без слов)

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "Установка завершена.$\n$\nДля работы генерации нужна Ollama — установите её вручную: https://ollama.com/download$\nЗапуск: ярлык «LiteMind Engine»."
!define MUI_FINISHPAGE_LINK "Открыть документацию"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\README.md"

; ---------------------- Страницы установки ----------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; ---------------------- Страницы удаления -----------------------
Var UnDelConfig
Var UnDelConfigState

!insertmacro MUI_UNPAGE_WELCOME
UninstPage custom un.CustomCreate un.CustomLeave
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

; ====================== Проверки перед установкой ======================
Function .onInit
  ; 1) 64-битная ОС
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "LiteMind Engine требует 64-битную Windows 10/11.$\nУстановка прервана."
    Abort
  ${EndIf}

  ; 2) сборка Windows не ниже 19045 (Windows 10 22H2)
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuild"
  ${EndIf}
  ${If} $R0 != ""
    IntCmp $R0 19045 buildOk buildLow buildLow
    Goto buildOk
    buildLow:
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Обнаружена Windows со сборкой $R0.$\nOllama официально требует Windows 10 22H2 (сборка 19045) или новее.$\n$\nПродолжить установку на свой риск?" IDYES buildOk
      Abort
    buildOk:
  ${EndIf}

  ; 3) Node.js >= 18 (единственная обязательная зависимость)
  nsExec::ExecToStack 'cmd /c node -e "process.exit(+process.versions.node.split(String.fromCharCode(46))[0]>=18?0:1)"'
  Pop $R1   ; код возврата
  Pop $R2   ; возможный вывод ошибки
  ${If} $R1 != "0"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Node.js не найден или его версия старше 18.$\n$\nLiteMind Engine требует Node.js 18.17 или новее (бесплатно): https://nodejs.org$\nPython и другие языки не нужны.$\n$\nБез Node.js движок не запустится.$\n$\nПродолжить установку без Node.js?" IDYES nodeSkip
    Abort
    nodeSkip:
  ${EndIf}
FunctionEnd

; ====================== Компоненты ======================
Section "LiteMind Engine (программа)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Только файлы проекта. test/, docs/, installer/ и логи не входят.
  File /r /x "*.log" /x "*.pid" "..\bin"
  File /r /x "*.log" /x "*.pid" "..\src"
  File /r /x "*.log" "..\config"
  File /r /x "*.log" "..\scripts"
  File "..\README.md"
  File "..\README.en.md"
  File "..\LICENSE"
  File "..\CHANGELOG.md"

  ; Пользовательские данные СОЗДАЁМ только как пустую папку-подсказку не будем:
  ; конфиг живёт в %APPDATA%\LiteMind и создаётся движком сам при первом сохранении.

  WriteUninstaller "$INSTDIR\${PRODUCT_EXE}"

  ; Ярлык в меню «Пуск» (для текущего пользователя)
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\LiteMind Engine"
  CreateShortCut "$SMPROGRAMS\LiteMind Engine\LiteMind Engine.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\scripts\start.ps1$\""
  CreateShortCut "$SMPROGRAMS\LiteMind Engine\Остановить LiteMind Engine.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\scripts\stop.ps1$\""
  CreateShortCut "$SMPROGRAMS\LiteMind Engine\Диагностика.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoExit -NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\scripts\doctor.ps1$\""
  CreateShortCut "$SMPROGRAMS\LiteMind Engine\README.lnk" "$INSTDIR\README.md"

  ; Реестр: текущая версия и запись в «Приложения»
  WriteRegStr HKCU "${APP_REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REGKEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_REGKEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_REGKEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_REGKEY}" "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegStr HKCU "${UNINST_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REGKEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${UNINST_REGKEY}" "UninstallString" "$\"$INSTDIR\${PRODUCT_EXE}$\""
  WriteRegDWORD HKCU "${UNINST_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_REGKEY}" "NoRepair" 1
SectionEnd

Section /o "Ярлык на рабочем столе" SecDesktop
  SetShellVarContext current
  CreateShortCut "$DESKTOP\LiteMind Engine.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\scripts\start.ps1$\""
SectionEnd

; ====================== Страница удаления: настройки ======================
Function un.CustomCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "Удаление уберёт только программу.$\nМодели Ollama ($PROFILE\.ollama) не трогаются никогда.$\nНастройки хранятся отдельно: $APPDATA\LiteMind"
  Pop $0
  ${NSD_CreateCheckbox} 0 45u 100% 20u "Дополнительно удалить мои настройки LiteMind"
  Pop $UnDelConfig
  nsDialogs::Show
FunctionEnd

Function un.CustomLeave
  ${NSD_GetState} $UnDelConfig $UnDelConfigState
FunctionEnd

; ====================== Удаление ======================
Section "Uninstall"
  SetShellVarContext current

  ; Удаляем ТОЛЬКО свою папку и только если в ней есть наш файл (защита от чужой директории)
  ${If} ${FileExists} "$INSTDIR\bin\litemind.js"
    RMDir /r "$INSTDIR"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Папка $INSTDIR не похожа на установку LiteMind — пропускаю удаление файлов."
  ${EndIf}

  Delete "$DESKTOP\LiteMind Engine.lnk"
  RMDir /r "$SMPROGRAMS\LiteMind Engine"

  DeleteRegKey HKCU "${UNINST_REGKEY}"
  DeleteRegKey HKCU "${APP_REGKEY}"

  ; Настройки удаляются только если пользователь явно поставил галочку
  ${If} $UnDelConfigState == ${BST_CHECKED}
    RMDir /r "$APPDATA\LiteMind"
  ${EndIf}
SectionEnd
