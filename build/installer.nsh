; Custom NSIS include picked up by electron-builder (buildResources/installer.nsh).
;
; Fixes L3-1. electron-builder's own check treats every process whose path STARTS WITH $INSTDIR
; as "this app", so the production installer closed a running staging launcher
; ("...\Microbot Cut Launcher" is a prefix of "...\Microbot Cut Launcher Staging"). Worse, with an
; empty $INSTDIR that predicate matches every process on the machine.
;
; This replaces the check (customCheckAppRunning) with three separate, individually testable
; steps. Each PowerShell command is a define below, below the 1024 character NSIS string limit,
; and takes its input from environment variables, so a quote in a path cannot alter a command:
;
;   1. VALIDATE  Is $INSTDIR a real install of this app? Refuses (exit 2) an empty, relative,
;                non-canonical, root, too shallow, system or profile directory, and any directory
;                that does not hold ${APP_EXECUTABLE_FILENAME} itself. Nothing is ever selected or
;                stopped after a refusal.
;   2. SELECT    Lists the processes (never stopping any) whose executable lives in EXACTLY one of
;                two directories: $INSTDIR, or $INSTDIR\resources\java-runtime\bin (the embedded
;                Java that clients run on). Equality of the directory, not a prefix. At most 25
;                processes; more is treated as a refusal. The list goes to a file.
;   3. STOP      Takes only the listed processes, re-checks each one's path right before stopping
;                it, and stops it. CUT_DRYRUN=1 prints what would be stopped and stops nothing.
;
; Exit codes of 1 and 2: 1 = nothing running, 2 = refused. Without PowerShell nothing is stopped:
; the user is asked to close the app (exact image name check) and to retry.

!define CUT_PS_VALIDATE `$$i = $$env:CUT_INSTDIR; $$x = $$env:CUT_APPEXE; if (-not $$i -or -not $$x) { exit 2 }; if ($$i -ne [IO.Path]::GetFullPath($$i)) { exit 2 }; if ($$i.EndsWith([string][char]92)) { exit 2 }; if ($$i.Split([char]92).Count -lt 3) { exit 2 }; if ([IO.Path]::GetPathRoot($$i).TrimEnd([char]92) -eq $$i) { exit 2 }; $$s = @($$env:SystemRoot, $$env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $$env:ProgramData, $$env:USERPROFILE, $$env:LOCALAPPDATA, $$env:APPDATA, $$env:TEMP) | ? { $$_ }; if ($$s -contains $$i -or $$i.StartsWith($$env:SystemRoot + [char]92)) { exit 2 }; if (-not (Test-Path -LiteralPath ($$i + [char]92 + $$x) -PathType Leaf)) { exit 2 }; exit 0`

!define CUT_PS_SELECT `$$i = $$env:CUT_INSTDIR; $$a = @($$i, ($$i + [char]92 + 'resources' + [char]92 + 'java-runtime' + [char]92 + 'bin')); $$p = @(Get-CimInstance Win32_Process | ? { $$_.ProcessId -ne $$PID -and $$_.ExecutablePath -and ($$a -contains [IO.Path]::GetDirectoryName($$_.ExecutablePath)) }); if ($$p.Count -gt 25) { exit 2 }; $$p | % { $$_.ProcessId.ToString() + [char]9 + $$_.ExecutablePath } | Out-File -Encoding utf8 -LiteralPath $$env:CUT_SELFILE; if ($$p.Count -gt 0) { exit 0 } else { exit 1 }`

!define CUT_PS_STOP `$$i = $$env:CUT_INSTDIR; $$a = @($$i, ($$i + [char]92 + 'resources' + [char]92 + 'java-runtime' + [char]92 + 'bin')); Get-Content -LiteralPath $$env:CUT_SELFILE | % { $$f = $$_ -split [char]9; if ($$f.Count -eq 2) { $$q = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$$f[0]); if ($$q -and $$q.ExecutablePath -eq $$f[1] -and ($$a -contains [IO.Path]::GetDirectoryName($$q.ExecutablePath))) { if ($$env:CUT_DRYRUN) { 'would stop ' + $$f[0] + ' ' + $$f[1] } elseif ($$env:CUT_FORCE) { Stop-Process -Id $$q.ProcessId -Force } else { Stop-Process -Id $$q.ProcessId } } } }`

!macro CUT_SET_ENVIRONMENT
  InitPluginsDir
  System::Call 'Kernel32::SetEnvironmentVariable(t "CUT_INSTDIR", t "$INSTDIR")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "CUT_APPEXE", t "${APP_EXECUTABLE_FILENAME}")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "CUT_SELFILE", t "$PLUGINSDIR\cut-selected.txt")'
!macroend

; $0 = 0 valid, 2 refused, anything else: PowerShell unusable.
!macro CUT_VALIDATE _RETURN
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "${CUT_PS_VALIDATE}"`
  Pop ${_RETURN}
!macroend

; ${_RETURN} = 0 something of this install runs (list in the file), 1 nothing, 2 refused.
!macro CUT_SELECT _RETURN
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "${CUT_PS_SELECT}"`
  Pop ${_RETURN}
!macroend

!macro CUT_STOP _FORCE
  ${if} ${_FORCE} == 1
    System::Call 'Kernel32::SetEnvironmentVariable(t "CUT_FORCE", t "1")'
  ${else}
    System::Call 'Kernel32::SetEnvironmentVariable(t "CUT_FORCE", t "")'
  ${endIf}
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "${CUT_PS_STOP}"`
  Pop $0
!macroend

!macro customCheckAppRunning
  ; electron-builder's CHECK_APP_RUNNING has already declared and set $CmdPath and $PowerShellPath.
  !insertmacro CUT_SET_ENVIRONMENT

  !insertmacro CUT_VALIDATE $R0
  ${if} $R0 == 0
    !insertmacro CUT_SELECT $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        Sleep 1000
        Goto doStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:
      DetailPrint "$(appClosing)"
      !insertmacro CUT_STOP 0
      Sleep 300

      StrCpy $R1 0
      loop:
        IntOp $R1 $R1 + 1
        !insertmacro CUT_SELECT $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro CUT_STOP 1
          !insertmacro CUT_SELECT $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${elseIf} $R0 != 2
    ; PowerShell is not usable: never stop anything. Look for the exact image name and ask the
    ; user to close the app.
    fallback_loop:
      nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
      Pop $R0
      ${if} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDRETRY fallback_loop
        Quit
      ${endIf}
  ${endIf}
  ; $R0 == 2 (refused): this directory is not a validated install of the app; nothing was
  ; selected and nothing is stopped.
!macroend
