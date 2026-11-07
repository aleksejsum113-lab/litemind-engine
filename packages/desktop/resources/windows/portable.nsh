; Portable-сборка LiteMind Engine.
; Патч patches/app-builder-lib@26.15.7.patch вызывает ${DirState} внутри
; extractUsing7za, но сам макрос определён только в assisted-шаблоне
; установщика (assistedInstaller.nsh), которого в portable-скрипте нет —
; без этой заглушки makensis падает с "Invalid command: ${DirState}".
; Заглушка всегда возвращает 1 («каталог занят/не пуст»), поэтому portable
; идёт по стандартному пути распаковки через $PLUGINSDIR: медленнее на копию,
; зато безопасно и без staged-update логики установщика.
!macro DirState PATH VAR
  StrCpy "${VAR}" 1
!macroend
