# verify.ps1 — 一键验收：大文件txt笔记支持这一轮改动，所有[自动]项逐项打印，全绿才交付
$fail = 0
function Check($id, $desc, [scriptblock]$test) {
    if (& $test) { Write-Host "$id OK $desc" }
    else         { Write-Host "$id FAIL $desc"; $script:fail++ }
}

Push-Location "$PSScriptRoot"
try {
    Check 'A1' 'Python 全量测试通过（含笔记大文件相关新增用例）' {
        python -X utf8 -m pytest modules/file_vault/tests -q
        $LASTEXITCODE -eq 0
    }
    Check 'A2' 'tsc --noEmit 无报错' {
        Push-Location modules/file_vault/ui
        npx tsc --noEmit
        $code = $LASTEXITCODE
        Pop-Location
        $code -eq 0
    }
    Check 'A3' 'eslint 对本轮改动文件无报错' {
        Push-Location modules/file_vault/ui
        npx eslint src/components/NotesScreen.tsx src/shared/ipcTypes.ts --report-unused-disable-directives --max-warnings 0
        $code = $LASTEXITCODE
        Pop-Location
        $code -eq 0
    }
    Check 'A4' '六语言 notes.json 键集合一致' {
        $counts = @()
        foreach ($lang in @('ar','en','es','fr','ru','zh')) {
            $json = Get-Content "modules/file_vault/ui/src/i18n/locales/$lang/notes.json" -Raw | ConvertFrom-Json
            $counts += ($json.PSObject.Properties | Measure-Object).Count
        }
        ($counts | Select-Object -Unique).Count -eq 1
    }
}
finally {
    Pop-Location
}

if ($fail -eq 0) { Write-Host '全部自动项通过 OK'; exit 0 }
else             { Write-Host "$fail 项未通过 FAIL"; exit 1 }
