<#
额度恢复探测脚本。独立于任何 Claude Code 交互会话运行，不持有 IMK、不
接触加密数据 - 只做两件事：轻量探测 claude CLI 是否可用，可用时要么什么
都不用做（应用已解锁运行中时，续跑交给应用自身的解锁自检/后续手动重试
完成），要么发一条系统通知（应用未运行/未解锁）。

用法：
  powershell -File task_watcher.ps1 -IntervalMinutes 30
#>

param(
    [int]$IntervalMinutes = 30,
    [string]$DataDir = "$PSScriptRoot\..\data"
)

function Test-ClaudeAvailable {
    & claude -p "ping" --output-format json --verbose *> $null
    return $LASTEXITCODE -eq 0
}

function Get-TaskIds {
    # meta.json.enc 是加密的，这个脚本读不了内容 - 只能列出 tasks/ 下的
    # 子目录名，供日志参考，不用于判断状态（那是应用自己的事）。
    $tasksDir = Join-Path $DataDir "tasks"
    if (-not (Test-Path $tasksDir)) { return @() }
    return Get-ChildItem $tasksDir -Directory | ForEach-Object { $_.Name }
}

function Test-BackendRunning {
    # file_vault Electron 应用把 backend_server.py 起成子进程，探测 python
    # 进程命令行里是否包含 backend_server.py 作为"应用是否在跑"的信号。
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue
    return $null -ne ($procs | Where-Object { $_.CommandLine -like "*backend_server.py*" })
}

function Send-RecoveryNotification {
    $sent = $false
    if (Get-Module -ListAvailable -Name BurntToast) {
        try {
            Import-Module BurntToast -ErrorAction Stop
            New-BurntToastNotification -Text "Ideal1 自动任务", "Claude Code 额度已恢复，打开并解锁 file_vault 以自动续跑等待中的任务。"
            $sent = $true
        } catch {
            $sent = $false
        }
    }
    if (-not $sent) {
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
        [System.Windows.Forms.MessageBox]::Show(
            "Claude Code 额度已恢复，请打开并解锁 file_vault。",
            "Ideal1 自动任务"
        ) | Out-Null
    }
}

Write-Host "task_watcher 启动，每 $IntervalMinutes 分钟探测一次。数据目录：$DataDir"

while ($true) {
    if (Test-ClaudeAvailable) {
        if (Test-BackendRunning) {
            Write-Host "$(Get-Date -Format o) 额度探测成功，且应用正在运行 - 续跑交给应用自身的解锁自检/后续手动重试完成（本脚本不直接调用 RPC，见设计文档）。"
        } else {
            Write-Host "$(Get-Date -Format o) 额度探测成功，但应用未运行 - 发送系统通知。"
            Send-RecoveryNotification
        }
    } else {
        Write-Host "$(Get-Date -Format o) 额度仍未恢复。"
    }
    Start-Sleep -Seconds ($IntervalMinutes * 60)
}
