!macro RegisterFastTerminalContextMenu ROOT_KEY SHELL_KEY ARG_TOKEN
  WriteRegStr ${ROOT_KEY} "Software\Classes\${SHELL_KEY}\shell\FastTerminal" "" "Open in FastTerminal"
  WriteRegStr ${ROOT_KEY} "Software\Classes\${SHELL_KEY}\shell\FastTerminal" "MUIVerb" "Open in FastTerminal"
  WriteRegStr ${ROOT_KEY} "Software\Classes\${SHELL_KEY}\shell\FastTerminal" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr ${ROOT_KEY} "Software\Classes\${SHELL_KEY}\shell\FastTerminal\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-path "${ARG_TOKEN}"'
!macroend

!macro UnregisterFastTerminalContextMenu ROOT_KEY SHELL_KEY
  DeleteRegKey ${ROOT_KEY} "Software\Classes\${SHELL_KEY}\shell\FastTerminal"
!macroend

!macro customInstall
  !insertmacro RegisterFastTerminalContextMenu HKCU "Directory" "%1"
  !insertmacro RegisterFastTerminalContextMenu HKCU "Directory\Background" "%V"
  !insertmacro RegisterFastTerminalContextMenu HKCU "Drive" "%1"
  System::Call 'shell32::SHChangeNotify(l 0x08000000, l 0, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro UnregisterFastTerminalContextMenu HKCU "Directory"
  !insertmacro UnregisterFastTerminalContextMenu HKCU "Directory\Background"
  !insertmacro UnregisterFastTerminalContextMenu HKCU "Drive"
  System::Call 'shell32::SHChangeNotify(l 0x08000000, l 0, i 0, i 0)'
!macroend
