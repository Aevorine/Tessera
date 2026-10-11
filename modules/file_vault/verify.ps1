# verify.ps1 - one-click acceptance check for the path-memory /
# position-memory / auto-scroll feature (this task's [auto] items only).
# Usage: powershell -ExecutionPolicy Bypass -File modules/file_vault/verify.ps1
$fail = 0
function Check($id, $desc, [scriptblock]$test) {
    if (& $test) { Write-Host "$id OK $desc" }
    else         { Write-Host "$id FAIL $desc"; $script:fail++ }
}

$uiDir = Join-Path $PSScriptRoot 'ui'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

# A2 scopes eslint to just the files this task actually changed, so a
# lint issue elsewhere in the project doesn't mask this specific task's
# result; A1 still runs whole-project tsc so you can see the real current
# state.
$touchedFiles = @(
  'src/components/NotesScreen.tsx',
  'src/components/AppShell.tsx',
  'src/components/PathQuickPick.tsx',
  'src/lib/pathMemory.ts',
  'src/lib/positionMemory.ts',
  'src/lib/positionMarkerExtension.ts',
  'src/lib/autoScroll.ts'
)

Push-Location $uiDir
try {
    Check 'A1' 'tsc --noEmit (whole project)' { npx tsc --noEmit *>$null; $LASTEXITCODE -eq 0 }
    Check 'A2' 'eslint (files touched by this task) 0 errors 0 warnings' {
        npx eslint $touchedFiles --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}

Push-Location $repoRoot
try {
    Check 'A3' 'i18n key consistency (no new missing keys)' {
        $out = node (Join-Path $uiDir 'scripts/check-i18n-keys.mjs') 2>&1 | Out-String
        # A pre-existing, unrelated [ai]-namespace drift is allowed here;
        # only a newly introduced "missing=[...]" would fail this check.
        -not ($out -match 'missing=\[[^\]]+\]')
    }
    Check 'A4' 'python pytest (modules/file_vault/tests/) all green' {
        python -m pytest modules/file_vault/tests/ -q *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}

# ---- This task's checks: 2026-07-21 file_clip native-buttons crash investigation ----
Push-Location $repoRoot
try {
    Check 'B1' 'core/fileops/*.py and setup_integration.py syntax OK' {
        python -m py_compile core/fileops/system_integration.py modules/file_clip/setup_integration.py modules/file_clip/hotkey_agent.py modules/file_vault/fileops/service.py
        $LASTEXITCODE -eq 0
    }
    Check 'B2' 'file_clip functional test suite (run_tests.py) all green' {
        $env:PYTHONPATH = '.'
        python -X utf8 modules/file_clip/tests/run_tests.py *>$null
        $ok = $LASTEXITCODE -eq 0
        Remove-Item Env:\PYTHONPATH -ErrorAction SilentlyContinue
        $ok
    }
    Check 'B3' 'file_clip test_hotkey.py (decide() logic) all green' {
        python -m pytest modules/file_clip/tests/test_hotkey.py -q *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'B4' 'native buttons defaults to OFF (safety default after crash finding)' {
        # Call the function directly for a plain OFF/ON answer instead of
        # parsing the CLI's Chinese status text through a PowerShell pipe
        # (that encoding path once misreported a FAIL when the real state
        # was correct -- calling the function directly sidesteps it).
        $out = python -c "import sys; sys.path.insert(0,'.'); from core.fileops.system_integration import native_buttons_enabled; print('OFF' if not native_buttons_enabled() else 'ON')" 2>$null
        $out.Trim() -eq 'OFF'
    }
} finally {
    Pop-Location
}
# B5 (native-buttons survival probe, ~15s) lives out here instead of inside
# Check() because it needs to really start/stop a background process, which
# doesn't fit the scriptblock pattern cleanly. Not counted in $fail: native
# buttons defaults to OFF and is known-unstable (see task-progress.md) --
# this just leaves a repeatable probe for whoever picks up that investigation
# later, it is not an assertion that the feature is expected to be stable.
Write-Host '--- B5 (informational, not a pass/fail gate): hook_agent.exe native-buttons file-race regression (~15s) ---'
Write-Host '    Native buttons defaults to OFF and is not recommended for use (known intermittent crash, see task-progress.md);'
Write-Host '    this probe is just a repeatable check for future debugging -- an occasional FAIL here does not fail the overall run.'
$hookExe = Join-Path $repoRoot 'core\fileops\c\hook_agent.exe'
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { $pyw = (Get-Command python).Source -replace 'python\.exe$','pythonw.exe' }
$cliPath = Join-Path $repoRoot 'modules\file_clip\cli.py'
$ps1Path = Join-Path $repoRoot 'core\fileops\c\ui_scan_agent.ps1'
# The hook agent is single-instance (named mutex), so any instance you have
# running day-to-day must be stopped first or the new test instance would
# just bounce off the mutex and get misread as "crashed". Either way this
# restarts your everyday keyboard-only instance at the end, so you're never
# left without Ctrl+V.
$wasRunning = Get-CimInstance Win32_Process -Filter "Name='hook_agent.exe'" -ErrorAction SilentlyContinue
if ($wasRunning) {
    & $hookExe --stop | Out-Null
    Start-Sleep -Milliseconds 400
}
$proc = Start-Process -FilePath $hookExe -ArgumentList "`"$pyw`"","`"$cliPath`"","rename","`"$ps1Path`"" -PassThru
Start-Sleep -Seconds 15
$proc.Refresh()
if ($proc.HasExited) {
    Write-Host 'B5 INFO(fail) hook_agent.exe (native buttons) died within 15s -- known intermittent issue, not counted against pass/fail'
} else {
    Write-Host 'B5 INFO(ok) hook_agent.exe (native buttons) survived 15s this run -- still intermittent, one pass does not mean fixed'
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ui_scan_agent' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item "$env:TEMP\file_clip_hotrects.txt","$env:TEMP\file_clip_mouse_hook.log" -ErrorAction SilentlyContinue
# Restore the everyday keyboard-only instance (no native-buttons arg, stable)
Start-Sleep -Milliseconds 300
Start-Process -FilePath $hookExe -ArgumentList "`"$pyw`"","`"$cliPath`"","rename" | Out-Null

# ---- This task's checks: 2026-07-21 UI innovation pass (nav polish / command palette / progress viz / settings grouping) ----
$uiTouchedFiles = @(
  'src/components/AppShell.tsx',
  'src/components/CommandPalette.tsx',
  'src/components/FilesPane.tsx',
  'src/components/SettingsScreen.tsx',
  'src/components/FileManagerScreen.tsx'
)
Push-Location $uiDir
try {
    Check 'C1' 'eslint (this UI task''s touched files) 0 errors 0 warnings' {
        npx eslint $uiTouchedFiles --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
# C2 (EXE rebuild) is intentionally not automated here - it's slow
# (~1-2 min) and this script is meant to stay fast. Rebuild manually with
# `cd modules/file_vault/ui && npm run build` when you need a fresh exe;
# A1/A3/C1 above already cover the source-level regression checks.

# ---- This task's checks: 2026-07-22 note-import auto-classification (offline keyword matcher) ----
$noteClassifyTouchedFiles = @(
  'src/components/NotesScreen.tsx',
  'src/shared/ipcTypes.ts'
)
Push-Location $uiDir
try {
    Check 'D1' 'eslint (this task''s touched frontend files) 0 errors 0 warnings' {
        npx eslint $noteClassifyTouchedFiles --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
Push-Location $repoRoot
try {
    Check 'D2' 'python py_compile (classifier/storage/service/backend_server touched by this task)' {
        python -m py_compile modules/file_vault/notes/classifier.py modules/file_vault/notes/storage.py modules/file_vault/notes/service.py modules/file_vault/backend_server.py
        $LASTEXITCODE -eq 0
    }
    Check 'D3' 'pytest (classifier + category + import-auto-classify tests) all green' {
        python -X utf8 -m pytest modules/file_vault/tests -q -k "classif or categor or note_import_files" *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
# D4 (EXE rebuild) not automated here for the same reason as C2 - rebuild
# manually with `cd modules/file_vault/ui && npm run build` before relying
# on the packaged app reflecting this task's changes.

# ---- This task's checks: 2026-07-22 stage-3 shortcut customization + help page ----
Push-Location $repoRoot
try {
    Check 'E1' 'pytest (ui_settings + hook shortcut config + shortcut RPCs) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_ui_settings.py modules/file_vault/tests/test_hook_shortcut_config.py -q *>$null
        $ok1 = $LASTEXITCODE -eq 0
        python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -q -k "file_manager_shortcuts" *>$null
        $ok1 -and ($LASTEXITCODE -eq 0)
    }
    Check 'E2' 'py_compile (ui_settings / backend_server / fileops service / system_integration)' {
        python -m py_compile modules/file_vault/ui_settings.py modules/file_vault/backend_server.py modules/file_vault/fileops/service.py core/fileops/system_integration.py
        $LASTEXITCODE -eq 0
    }
    Check 'E3' 'hook_agent.exe rebuilt from current source (exe mtime >= hook_agent.c mtime)' {
        $src = Get-Item 'core/fileops/c/hook_agent.c'
        $exe = Get-Item 'core/fileops/c/hook_agent.exe' -ErrorAction SilentlyContinue
        $exe -and ($exe.LastWriteTime -ge $src.LastWriteTime)
    }
    Check 'E4' 'menu locale files: helpGuide key present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $json = Get-Content "modules/file_vault/ui/electron/locales/$lang.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $json.helpGuide) { $missing++ }
        }
        $missing -eq 0
    }
} finally {
    Pop-Location
}
Push-Location $uiDir
try {
    Check 'E5' 'eslint (stage-3 touched frontend files) 0 errors 0 warnings' {
        npx eslint src/components/ShortcutSettings.tsx src/components/HelpScreen.tsx src/components/SettingsScreen.tsx src/components/FileManagerScreen.tsx src/components/AppShell.tsx src/lib/shortcutFormat.ts electron/main.ts electron/preload.ts --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
# E6 (EXE rebuild + real-machine shortcut capture) not automated - same
# reason as C2/D4, plus real key-capture needs a human hand anyway.

# ---- This task's checks: 2026-07-22 stage-4 clipboard streaming export/import + partial copy ----
Push-Location $repoRoot
try {
    Check 'G1' 'pytest (clipboard export/import streaming + storage) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_clipboard_export_import.py modules/file_vault/tests/test_clipboard_storage.py -q *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
Push-Location $uiDir
try {
    Check 'G2' 'partial-copy i18n keys present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $clip = Get-Content "src/i18n/locales/$lang/clipboard.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $clip.partialCopyButton) { $missing++ }
        }
        $missing -eq 0
    }
} finally {
    Pop-Location
}

# ---- This task's checks: 2026-07-22 stage-5 incremental folder re-encrypt (diff + safety-swapped reencrypt) ----
Push-Location $repoRoot
try {
    Check 'H1' 'pytest (container.py diff/reencrypt functions) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_container.py -q -k "diff or reencrypt" *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'H2' 'pytest (folder_container_diff/reencrypt RPCs) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -q -k "folder_container" *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
Push-Location $uiDir
try {
    Check 'H3' 'eslint (FilesPane.tsx + ipcTypes.ts) 0 errors 0 warnings' {
        npx eslint src/components/FilesPane.tsx src/shared/ipcTypes.ts --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}

# ---- This task's checks: 2026-07-22 stage-6 cross-module activity timeline ----
Push-Location $repoRoot
try {
    Check 'I1' 'pytest (activity_log.py storage) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_activity_log.py -q *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'I2' 'pytest (activity_log RPCs + 4-module record points) all green' {
        python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -q -k "activity" *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}
Push-Location $uiDir
try {
    Check 'I3' 'eslint (ActivityTimeline.tsx + FilesPane.tsx) 0 errors 0 warnings' {
        npx eslint src/components/ActivityTimeline.tsx src/components/FilesPane.tsx --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
} finally {
    Pop-Location
}

# ---- This task's checks: 2026-07-22 icon-toolbar UI redesign round ----
Push-Location $uiDir
try {
    Check 'F1' 'eslint (IconToolbar + three converted screens) 0 errors 0 warnings' {
        npx eslint src/components/IconToolbar.tsx src/components/NotesScreen.tsx src/components/FileManagerScreen.tsx src/components/ClipboardScreen.tsx --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'F2' 'toolbar group-label i18n keys present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $common = Get-Content "src/i18n/locales/$lang/common.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $notes = Get-Content "src/i18n/locales/$lang/notes.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $fm = Get-Content "src/i18n/locales/$lang/filemanager.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            $clip = Get-Content "src/i18n/locales/$lang/clipboard.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not ($common.toolbarShowLabels -and $notes.toolbarGroupView -and $fm.toolbarGroupNav -and $clip.toolbarGroupFilter)) { $missing++ }
        }
        $missing -eq 0
    }
} finally {
    Pop-Location
}


# ---- This task's checks: 2026-07-22 notes category icon-grid + tooltip audit ----
Push-Location $uiDir
try {
    Check 'J1' 'eslint (notes category redesign + bare-icon-button fixes) 0 errors 0 warnings' {
        npx eslint src/components/NotesScreen.tsx src/components/ClipboardScreen.tsx src/components/AIChatScreen.tsx src/components/SettingsScreen.tsx --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'J2' 'new category-preset + category-tree-toggle i18n keys present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $notes = Get-Content "src/i18n/locales/$lang/notes.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not ($notes.categoryPresetRadio -and $notes.categoryPresetNode -and $notes.categoryTreeShowButton -and $notes.categoryTreeHideButton)) { $missing++ }
        }
        $missing -eq 0
    }
    Check 'J3' 'new pin/unpin clipboard-row-action i18n keys present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $clip = Get-Content "src/i18n/locales/$lang/clipboard.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not ($clip.pinEntryAction -and $clip.unpinEntryAction)) { $missing++ }
        }
        $missing -eq 0
    }
} finally {
    Pop-Location
}
# J4 (EXE rebuild + real-machine look at the icon grid/tooltips/collapse toggle)
# not automated here for the same reason as C2/D4/E6 - rebuild manually with
# `cd modules/file_vault/ui && npm run build` and eyeball it once built.

# ---- This task's checks: 2026-07-23 recovery codes ("恢复码") module ----
Push-Location $uiDir
try {
    Check 'K1' 'eslint (recovery codes frontend files) 0 errors 0 warnings' {
        npx eslint src/components/RecoveryCodesScreen.tsx src/components/AppShell.tsx src/components/SettingsScreen.tsx src/components/ActivityTimeline.tsx src/lib/ocr.ts src/lib/recoveryCodesPdf.ts --report-unused-disable-directives --max-warnings 0 *>$null
        $LASTEXITCODE -eq 0
    }
    Check 'K2' 'recoveryCodes.json + new common.json/settings.json keys present in all 6 languages' {
        $missing = 0
        foreach ($lang in @('zh','en','fr','es','ru','ar')) {
            $rc = Get-Content "src/i18n/locales/$lang/recoveryCodes.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not ($rc.pageTitle -and $rc.importOcrButton -and $rc.pdfExportButton -and $rc.backupExportButton -and $rc.dashboardServiceCountLabel)) { $missing++ }
            $common = Get-Content "src/i18n/locales/$lang/common.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not ($common.navRecoveryCodes -and $common.'activityAction.recovery_codes.import')) { $missing++ }
            $settings = Get-Content "src/i18n/locales/$lang/settings.json" -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $settings.moduleLockRecoveryCodesLabel) { $missing++ }
        }
        $missing -eq 0
    }
    Check 'K3' 'public/tesseract local OCR assets present (worker + all 4 wasm core variants + English traineddata)' {
        $base = 'public/tesseract'
        (Test-Path "$base/worker.min.js") `
            -and (Test-Path "$base/core/tesseract-core.wasm") -and (Test-Path "$base/core/tesseract-core-simd.wasm") `
            -and (Test-Path "$base/core/tesseract-core-lstm.wasm") -and (Test-Path "$base/core/tesseract-core-simd-lstm.wasm") `
            -and (Test-Path "$base/lang-data/eng.traineddata.gz")
    }
} finally {
    Pop-Location
}
Push-Location $repoRoot
try {
    Check 'K4' 'python pytest (recovery_codes unit + RPC integration tests) all green' {
        python -m pytest modules/file_vault/tests/test_recovery_codes.py -q *>$null
        $unitOk = $LASTEXITCODE -eq 0
        python -m pytest modules/file_vault/tests/test_backend_server.py -k recovery_codes -q *>$null
        $rpcOk = $LASTEXITCODE -eq 0
        $unitOk -and $rpcOk
    }
} finally {
    Pop-Location
}
# K5 (EXE rebuild + real-machine walkthrough of the 恢复码 tab: import via
# file/drag/clipboard/OCR, reveal re-verification, dashboard, PDF export,
# full backup export/import) not automated here for the same reason as
# C2/D4/E6/J4 - rebuild with `cd modules/file_vault/ui && npm run build`
# and drive it with cua-computer-use or by hand.

if ($fail -eq 0) { Write-Host 'ALL AUTO CHECKS PASSED'; exit 0 }
else             { Write-Host "$fail check(s) failed"; exit 1 }
