<#
file_clip 原生按钮扫描代理（后台常驻，由 hook_agent.exe 启动/终止，不单独运行）。

用 UI Automation 周期性找资源管理器工具栏、以及 Win11 右键菜单顶部图标行里
「粘贴」「删除」按钮的屏幕矩形，写进 -OutFile 指定的文件，给 hook_agent.exe
的鼠标钩子用（鼠标钩子回调本身绝不做 UIA/COM 调用，只读这份缓存文件——
那些调用可能要几十上百毫秒，钩子里做会拖慢全系统鼠标响应）。

两类目标节奏不同：
  1. 资源管理器工具栏：窗口长期存在，~1.5 秒重扫一次足够跟上尺寸变化/DPI变化；
  2. 右键菜单图标行：弹出即可能消失，需要高频轮询探测「菜单出现了」这件事本身，
     一发现新菜单就立刻扫一次它的按钮（不然用户点得比我们扫得还快，白扫）。

只用 Windows 自带的 UIAutomationClient/Types 程序集 + .NET Framework 反射调用
user32 几个函数，不装任何东西。退出方式是被 hook_agent.exe 直接 kill 掉（不需要
优雅退出）：输出文件用"先写临时文件、再原子改名"的方式写，任何时刻被杀都不会
让 hook_agent.exe 读到写了一半的半份文件。
#>
param(
    [Parameter(Mandatory = $true)][string]$OutFile
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FcNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string title);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@

$ButtonType = [System.Windows.Automation.ControlType]::Button
$PasteHints = @('粘贴', 'Paste')
$DeleteHints = @('删除', 'Delete')
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ClassNameOf([IntPtr]$hwnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [FcNative]::GetClassName($hwnd, $sb, 256) | Out-Null
    return $sb.ToString()
}

# 在 $scanRoot 窗口里找「粘贴/删除」按钮，记录时把动作归属到 $ownerHwnd
# （右键菜单场景下 $scanRoot 是菜单弹窗自己的句柄，但 $ownerHwnd 要写真正的
# 资源管理器窗口句柄——cli.py 只认识真实的资源管理器窗口，不认识菜单弹窗）。
function Scan-Buttons([IntPtr]$scanRoot, [IntPtr]$ownerHwnd) {
    $found = New-Object System.Collections.Generic.List[string]
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($scanRoot)
        if (-not $root) { return $found }
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ButtonType)
        $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
        foreach ($b in $buttons) {
            try {
                $cur = $b.Current
                if (-not $cur.IsEnabled -or $cur.IsOffscreen) { continue }
                $r = $cur.BoundingRectangle
                if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
                $name = $cur.Name
                if (-not $name) { continue }
                $kind = $null
                foreach ($h in $PasteHints) { if ($name.Contains($h)) { $kind = 'paste'; break } }
                if (-not $kind) {
                    foreach ($h in $DeleteHints) { if ($name.Contains($h)) { $kind = 'delete'; break } }
                }
                if (-not $kind) { continue }
                $ownerNum = $ownerHwnd.ToInt64()
                $found.Add("$kind`t$ownerNum`t$([int]$r.X)`t$([int]$r.Y)`t$([int]$r.Width)`t$([int]$r.Height)")
            } catch { }
        }
    } catch { }
    return $found
}

$toolbarCache = @{}   # hwnd(int64) -> @{ Time=DateTime; Entries=[string[]] }
$menuCache = $null
$lastMenuHwnd = [IntPtr]::Zero
$lastOwnerExplorer = [IntPtr]::Zero
$ToolbarTtlMs = 1500
$ToolbarKeepMs = 12000   # 一个窗口这么久没再当过前台，就彻底丢弃它的缓存

while ($true) {
    try {
        $fg = [FcNative]::GetForegroundWindow()
        $fgClass = Get-ClassNameOf $fg
        $isExplorer = ($fgClass -eq 'CabinetWClass' -or $fgClass -eq 'ExploreWClass')
        $isDesktop = ($fgClass -eq 'Progman' -or $fgClass -eq 'WorkerW')

        if ($isExplorer) {
            $lastOwnerExplorer = $fg
            $key = $fg.ToInt64()
            $now = [DateTime]::UtcNow
            $needScan = $true
            if ($toolbarCache.ContainsKey($key)) {
                $age = ($now - $toolbarCache[$key].Time).TotalMilliseconds
                if ($age -lt $ToolbarTtlMs) { $needScan = $false }
            }
            if ($needScan) {
                $entries = Scan-Buttons $fg $fg
                $toolbarCache[$key] = @{ Time = $now; Entries = $entries }
            }
        }

        # 清掉太久没当过前台 / 窗口已经关掉的缓存，文件不会越写越大，矩形也不会占着旧位置
        $now2 = [DateTime]::UtcNow
        $staleKeys = @($toolbarCache.Keys | Where-Object {
                ($now2 - $toolbarCache[$_].Time).TotalMilliseconds -gt $ToolbarKeepMs -or
                -not [FcNative]::IsWindow([IntPtr]$_)
            })
        foreach ($k in $staleKeys) { $toolbarCache.Remove($k) }

        # 右键菜单图标行：只在前台是资源管理器/桌面时探测，避免碰到别的程序的菜单
        if ($isExplorer -or $isDesktop) {
            $menuHwnd = [FcNative]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, '#32768', $null)
            if ($menuHwnd -ne [IntPtr]::Zero -and [FcNative]::IsWindowVisible($menuHwnd)) {
                if ($menuHwnd -ne $lastMenuHwnd -and $lastOwnerExplorer -ne [IntPtr]::Zero) {
                    $menuCache = Scan-Buttons $menuHwnd $lastOwnerExplorer
                    $lastMenuHwnd = $menuHwnd
                }
            }
            else {
                $lastMenuHwnd = [IntPtr]::Zero
                $menuCache = $null
            }
        }
        else {
            $lastMenuHwnd = [IntPtr]::Zero
            $menuCache = $null
        }

        $all = New-Object System.Collections.Generic.List[string]
        foreach ($v in $toolbarCache.Values) { $all.AddRange($v.Entries) }
        if ($menuCache) { $all.AddRange($menuCache) }

        $tmp = "$OutFile.tmp"
        [System.IO.File]::WriteAllLines($tmp, [string[]]$all, $Utf8NoBom)
        Move-Item -LiteralPath $tmp -Destination $OutFile -Force
    }
    catch {
        # 扫描代理绝不能因为单次异常退出——吞掉，下一轮再试
    }
    Start-Sleep -Milliseconds 120
}
