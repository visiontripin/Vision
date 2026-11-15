!include "LogicLib.nsh"

; Stop and remove the previous SCM registration before NSIS replaces the wrapper
; and its XML. ProgramData (library, password hash, port and logs) is preserved.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\resources\server\service\VisionServer.exe" 0 vision_preinstall_done
  ExecWait '"$INSTDIR\resources\server\service\VisionServer.exe" stop' $0
  Sleep 1000
  ExecWait '"$INSTDIR\resources\server\service\VisionServer.exe" uninstall' $0
vision_preinstall_done:
!macroend

; The installer is configured per-machine, so these operations run elevated.
!macro NSIS_HOOK_POSTINSTALL
  ReadEnvStr $1 "ProgramData"
  StrCmp $1 "" 0 vision_programdata_ready
  StrCpy $1 "$WINDIR\..\ProgramData"
vision_programdata_ready:
  CreateDirectory "$1\VisionServer"
  CreateDirectory "$1\VisionServer\data"
  CreateDirectory "$1\VisionServer\logs"

  IfFileExists "$1\VisionServer\server-manager.json" vision_settings_ready
  FileOpen $0 "$1\VisionServer\server-manager.json" w
  FileWrite $0 '{"port":4000}$\r$\n'
  FileClose $0
vision_settings_ready:

  ; Keep service data private to SYSTEM/Administrators. Users can read rotated
  ; service logs and change only the non-secret port preference.
  ExecWait '"$SYSDIR\icacls.exe" "$1\VisionServer" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(RX)"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось защитить каталог данных Vision Server (icacls, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\icacls.exe" "$1\VisionServer\data" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось настроить права на данные Vision Server (icacls, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\icacls.exe" "$1\VisionServer\logs" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)R"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось настроить чтение журналов Vision Server (icacls, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\icacls.exe" "$1\VisionServer\server-manager.json" /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "*S-1-5-32-545:M"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось настроить пользовательский порт службы (icacls, код $0). Установка отменена."
    Abort
  ${EndIf}

  ; WinSW reads this file beside its executable. Write the actual machine-wide
  ; path here instead of relying on environment-variable expansion in XML.
  FileOpen $0 "$INSTDIR\resources\server\service\VisionServer.xml" w
  FileWrite $0 '<?xml version="1.0" encoding="utf-8"?>$\r$\n'
  FileWrite $0 '<service>$\r$\n'
  FileWrite $0 '  <id>VisionServer</id>$\r$\n'
  FileWrite $0 '  <name>Vision Server</name>$\r$\n'
  FileWrite $0 '  <description>Vision Server home API service</description>$\r$\n'
  FileWrite $0 '  <executable>%BASE%\..\..\node\node.exe</executable>$\r$\n'
  FileWrite $0 '  <argument>%BASE%\..\services\api\src\start.js</argument>$\r$\n'
  FileWrite $0 '  <workingdirectory>%BASE%\..</workingdirectory>$\r$\n'
  FileWrite $0 '  <env name="HOST" value="0.0.0.0" />$\r$\n'
  FileWrite $0 '  <env name="PORT" value="4000" />$\r$\n'
  FileWrite $0 '  <env name="NODE_ENV" value="production" />$\r$\n'
  FileWrite $0 '  <env name="DATA_DIR" value="$1\VisionServer\data" />$\r$\n'
  FileWrite $0 '  <env name="BACKUP_DIR" value="$1\VisionServer\data\backups" />$\r$\n'
  FileWrite $0 '  <env name="VISION_PASSWORD_FILE" value="$1\VisionServer\data\owner-auth.json" />$\r$\n'
  FileWrite $0 '  <env name="VISION_SERVER_SETTINGS_FILE" value="$1\VisionServer\server-manager.json" />$\r$\n'
  FileWrite $0 '  <env name="FFMPEG_PATH" value="%BASE%\..\bin\ffmpeg.exe" />$\r$\n'
  FileWrite $0 '  <logpath>$1\VisionServer\logs</logpath>$\r$\n'
  FileWrite $0 '  <logmode>roll</logmode>$\r$\n'
  FileWrite $0 '  <stoptimeout>30sec</stoptimeout>$\r$\n'
  FileWrite $0 '</service>$\r$\n'
  FileClose $0

  ExecWait '"$INSTDIR\resources\server\service\VisionServer.exe" install' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось установить службу VisionServer (WinSW, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" config VisionServer start= auto' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось включить автозапуск службы VisionServer (sc.exe, код $0). Установка отменена."
    Abort
  ${EndIf}
  ; Standard users may query, start and stop the service from the Vision panel;
  ; service configuration itself remains writable only by Administrators.
  ExecWait '"$SYSDIR\sc.exe" sdset VisionServer "D:(A;;LCRPWP;;;BU)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось настроить права управления службой VisionServer (sc.exe, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" failure VisionServer reset= 86400 actions= restart/5000/restart/15000/restart/60000' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось включить восстановление службы VisionServer (sc.exe, код $0). Установка отменена."
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" start VisionServer' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Не удалось запустить службу VisionServer. Проверьте журнал Windows и повторите установку."
    Abort
  ${EndIf}
!macroend

; Uninstalling the desktop manager must not leave an orphaned service behind.
!macro NSIS_HOOK_PREUNINSTALL
  IfFileExists "$INSTDIR\resources\server\service\VisionServer.exe" 0 vision_preuninstall_done
  ExecWait '"$INSTDIR\resources\server\service\VisionServer.exe" stop' $0
  Sleep 1000
  ExecWait '"$INSTDIR\resources\server\service\VisionServer.exe" uninstall' $0
vision_preuninstall_done:
!macroend

; ProgramData is intentionally not removed: library and backups survive uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
