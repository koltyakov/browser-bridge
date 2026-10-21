Unicode True
Name "Browser Bridge"
OutFile "..\dist\standalone\Browser-Bridge-Setup.exe"
RequestExecutionLevel user
Page instfiles
AutoCloseWindow true
!include "LogicLib.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "..\dist\standalone\bbx-windows-x64-baseline.exe"
  nsExec::ExecToStack '"$PLUGINSDIR\bbx-windows-x64-baseline.exe" setup'
  Pop $0
  Pop $1
  ${If} $0 == 0
    MessageBox MB_OK "Browser Bridge is ready. Return to the extension to connect your agent and enable window access. Restart existing terminals and agents once."
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "Setup could not finish. $1"
    SetErrorLevel 1
  ${EndIf}
SectionEnd
