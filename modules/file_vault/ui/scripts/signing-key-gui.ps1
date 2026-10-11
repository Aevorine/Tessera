<#
.SYNOPSIS
  签名密钥的图形界面：输入两次密码 → 自动生成/取用证书 → 导出带密码保护的私钥备份。

.DESCRIPTION
  这是 `npm run signing:export` 的图形版，做同一件事，但不需要在终端里敲命令、
  也不会因为「当前目录不对」而失败（命令行版必须在 ui/ 目录下跑，否则 npm 找不到
  package.json，报的还是一个跟签名毫无关系的 ENOENT）。

  流程：
    1. 弹框要两次密码，可切换明文显示
    2. 点「确定」→ 本机没有签名证书就**自动生成**一张（自签名，RSA-3072，20 年）
    3. 用刚才那个密码导出 .pfx（这才是真正的私钥备份）
    4. 显示这把密钥的身份信息，并可另存为 .txt

  ## 为什么 .txt 里没有私钥本身

  「导出成 txt」导出的是**身份信息**（主体名、指纹、公钥 SHA-256、有效期、
  .pfx 的位置），不是私钥。

  这不是偷懒，是刻意的：私钥一旦以明文落到 .txt 里，任何读到那个文件的人都能
  冒充你签发更新，而这套更新机制的全部安全性恰恰建立在「除了你，没人能签出
  客户端认可的包」之上。私钥的正确载体是下面那个**带密码的 .pfx**；.txt 用来
  记录「我这把钥匙是哪一把」，方便日后核对，泄露了也不造成损失。

.NOTES
  这个文件必须以 **UTF-8 with BOM** 保存。Windows PowerShell 5.1 对无 BOM 的
  .ps1 按系统 ANSI 代码页解码（本机是 gb2312），满篇中文会被解坏，报出来的错
  跟真实原因隔着十万八千里。同目录的 ensure-signing-cert.ps1 踩过这个坑。
#>
[CmdletBinding()]
param(
  [string]$Subject,
  [string]$OutDir,
  # 只把界面搭出来、跑一遍校验逻辑，然后退出，**不弹窗、不碰证书、不写任何文件**。
  # GUI 没法在无人值守下点，但"控件属性写错""事件处理器里引用了不存在的变量"
  # 这类问题占了这种脚本翻车的绝大多数，而它们在构造阶段就会暴露。
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$scriptDir = $PSScriptRoot
$uiDir = Split-Path $scriptDir -Parent

# 主体名默认跟着 signer-policy.json 走——那里钉的 publisher 就是证书主体名，
# 两者必须一字不差，否则导出的会是另一把（或者根本找不到）。
if (-not $Subject) {
  $policyPath = Join-Path $uiDir 'signer-policy.json'
  if (Test-Path $policyPath) {
    # **必须显式按 UTF-8 读**，不能用 `Get-Content -Raw`。
    #
    # signer-policy.json 的 _comment 里全是中文，而 Windows PowerShell 5.1 的
    # Get-Content 在文件没有 BOM 时按系统 ANSI 代码页（本机 gb2312）解码，中文
    # 被解坏之后 JSON 直接解析失败：
    #     ConvertFrom-Json: 无效的 JSON，应为 ',' 或 '}' (89)
    # 报的位置指向注释中间，跟"编码"两个字毫无关系。pwsh 7 默认 UTF-8，所以这个
    # 坑只在 5.1 上出现——而 npm 脚本调的正是 powershell.exe（5.1）。
    $p = [System.IO.File]::ReadAllText($policyPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($p.publisher) { $Subject = $p.publisher }
  }
}
if (-not $Subject) { $Subject = 'Tessera' }

if (-not $OutDir) { $OutDir = Split-Path $uiDir -Parent | Split-Path -Parent | Split-Path -Parent }

function Show-Error($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, '签名密钥', 'OK', 'Error') | Out-Null
}

<#
  两次输入的校验。**刻意抽成独立函数，而不是写在按钮的点击处理器里。**

  写在处理器里就没法在无人值守下验证：`Button.PerformClick()` 内部要求
  `CanSelect`，而它要求控件及其所有父级都可见——一个从没 ShowDialog 过的窗体
  Visible 是 false，于是 PerformClick 静默什么都不做。自检看起来"跑过了"，
  实际上一条校验分支都没碰到（这个脚本第一版就是这样，自检全绿但全是空字符串）。

  返回空串表示通过。
#>
function Get-PasswordValidationError([string]$first, [string]$second) {
  if ([string]::IsNullOrEmpty($first)) { return '请输入密码。' }
  if ($first.Length -lt 8) { return '密码太短，至少 8 位。' }
  if ($first -ne $second) { return '两次输入不一致。' }
  return ''
}

#--------------------------------------------------------------------------
# 第一个框：两次密码 + 明文开关
#--------------------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.Text = "签名密钥 - $Subject"
$form.Size = New-Object System.Drawing.Size(560, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lblIntro = New-Object System.Windows.Forms.Label
$lblIntro.Text = "给私钥备份设置一个密码。点「确定」后会自动准备好签名证书并导出备份。`r`n这个密码是打开备份文件的唯一凭据——忘了就等于丢了钥匙，没有找回途径。"
$lblIntro.Location = New-Object System.Drawing.Point(20, 18)
$lblIntro.Size = New-Object System.Drawing.Size(510, 44)
$form.Controls.Add($lblIntro)

$lbl1 = New-Object System.Windows.Forms.Label
$lbl1.Text = '密码'
$lbl1.Location = New-Object System.Drawing.Point(20, 78)
$lbl1.Size = New-Object System.Drawing.Size(70, 22)
$form.Controls.Add($lbl1)

$txt1 = New-Object System.Windows.Forms.TextBox
$txt1.Location = New-Object System.Drawing.Point(95, 75)
$txt1.Size = New-Object System.Drawing.Size(435, 24)
$txt1.UseSystemPasswordChar = $true
$form.Controls.Add($txt1)

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = '再输一次'
$lbl2.Location = New-Object System.Drawing.Point(20, 113)
$lbl2.Size = New-Object System.Drawing.Size(70, 22)
$form.Controls.Add($lbl2)

$txt2 = New-Object System.Windows.Forms.TextBox
$txt2.Location = New-Object System.Drawing.Point(95, 110)
$txt2.Size = New-Object System.Drawing.Size(435, 24)
$txt2.UseSystemPasswordChar = $true
$form.Controls.Add($txt2)

# 明文开关。默认隐藏，勾上同时作用于两个框——只放开一个的话，用户没法核对
# 自己两次输的是不是同一串。
$chk = New-Object System.Windows.Forms.CheckBox
$chk.Text = '显示密码'
$chk.Location = New-Object System.Drawing.Point(95, 142)
$chk.Size = New-Object System.Drawing.Size(120, 24)
$chk.Add_CheckedChanged({
  $txt1.UseSystemPasswordChar = -not $chk.Checked
  $txt2.UseSystemPasswordChar = -not $chk.Checked
})
$form.Controls.Add($chk)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Location = New-Object System.Drawing.Point(20, 175)
$lblHint.Size = New-Object System.Drawing.Size(510, 40)
$lblHint.ForeColor = [System.Drawing.Color]::DimGray
$lblHint.Text = "备份文件（.pfx）默认存到：`r`n$OutDir"
$form.Controls.Add($lblHint)

$lblErr = New-Object System.Windows.Forms.Label
$lblErr.Location = New-Object System.Drawing.Point(20, 218)
$lblErr.Size = New-Object System.Drawing.Size(510, 22)
$lblErr.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($lblErr)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = '确定'
$btnOk.Location = New-Object System.Drawing.Point(330, 248)
$btnOk.Size = New-Object System.Drawing.Size(95, 32)
$form.Controls.Add($btnOk)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '取消'
$btnCancel.Location = New-Object System.Drawing.Point(435, 248)
$btnCancel.Size = New-Object System.Drawing.Size(95, 32)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel
$form.AcceptButton = $btnOk

# 校验放在按钮里而不是靠 DialogResult：不合格时要留在框里提示，而不是关掉重来。
$script:password = $null
$btnOk.Add_Click({
  $err = Get-PasswordValidationError $txt1.Text $txt2.Text
  $lblErr.Text = $err
  if ($err) { return }
  $script:password = $txt1.Text
  $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Close()
})

if ($SelfTest) {
  # 逐条走一遍校验分支，确认 btnOk 的处理器不会在运行时炸（引用了不存在的变量、
  # 属性名拼错之类），以及明文开关确实同时作用于两个输入框。
  $checks = @()
  $checks += "空密码   -> '$(Get-PasswordValidationError '' '')'"
  $checks += "太短     -> '$(Get-PasswordValidationError 'short' 'short')'"
  $checks += "不一致   -> '$(Get-PasswordValidationError 'correct-horse' 'battery-staple')'"
  $checks += "合格     -> '$(Get-PasswordValidationError 'correct-horse-battery' 'correct-horse-battery')' (应为空)"
  $chk.Checked = $true
  $checks += "明文开关 -> txt1 masked=$($txt1.UseSystemPasswordChar), txt2 masked=$($txt2.UseSystemPasswordChar)"
  $chk.Checked = $false
  $checks += "隐藏开关 -> txt1 masked=$($txt1.UseSystemPasswordChar), txt2 masked=$($txt2.UseSystemPasswordChar)"
  $checks += "主体名   -> $Subject"
  $checks += "备份目录 -> $OutDir"
  $form.Dispose()
  $checks | ForEach-Object { Write-Output $_ }
  return
}

if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$plainPassword = $script:password

#--------------------------------------------------------------------------
# 干活：确保证书存在（没有就生成）→ 导出 .pfx
#--------------------------------------------------------------------------
try {
  # 复用 ensure-signing-cert.ps1，不另写一份生成逻辑：证书的参数（RSA-3072、
  # 用途、有效期、主体名）必须和构建时用的完全一致，两份实现迟早会漂移，
  # 而漂移的表现是"签出来的包客户端不认"——要等用户更新失败才发现。
  $certJson = & (Join-Path $scriptDir 'ensure-signing-cert.ps1') -Subject $Subject 2>$null |
    Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } |
    Select-Object -Last 1
  if (-not $certJson) { throw "ensure-signing-cert.ps1 没有返回证书信息。" }
  $cert = $certJson | ConvertFrom-Json

  $x509 = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $cert.thumbprint } | Select-Object -First 1
  if (-not $x509) { throw "证书 $($cert.thumbprint) 不在证书存储里。" }

  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
  $safe = $Subject -replace '[\\/:*?"<>|]', '_'
  $pfxPath = Join-Path $OutDir ("{0}-signing-{1:yyyyMMdd}.pfx" -f $safe, (Get-Date))

  $secure = ConvertTo-SecureString -String $plainPassword -AsPlainText -Force
  Export-PfxCertificate -Cert $x509 -FilePath $pfxPath -Password $secure | Out-Null
} catch {
  Show-Error "导出失败：`r`n$($_.Exception.Message)"
  return
} finally {
  # 明文密码尽快从变量里清掉。这挡不住内存取证，但能避免它在后续任何一次
  # 异常回溯/日志里被顺带打印出来。
  $plainPassword = $null
  $script:password = $null
}

#--------------------------------------------------------------------------
# 第二个框：显示这把密钥的身份，可另存为 txt
#--------------------------------------------------------------------------
$info = @"
Tessera - 发布签名密钥
=================================

主体名 (publisher)   : $($cert.publisher)
证书指纹 (thumbprint): $($cert.thumbprint)
公钥 SHA-256         : $($cert.publicKeySha256)
有效期至             : $($cert.notAfter)
私钥备份 (.pfx)      : $pfxPath
导出时间             : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

说明
----
* 「公钥 SHA-256」就是仓库里 modules/file_vault/ui/signer-policy.json 钉的那个值，
  客户端只认这把公钥。两边对不上，说明签名用的不是这张证书。
* 本文件**不含私钥**。私钥在上面那个 .pfx 里，用你刚才设的密码保护。
  把私钥写进明文 txt 等于把签发更新的能力交出去，所以这里刻意不写。
* .pfx 和它的密码请分开保存，并且**复制一份到这台电脑之外**。
  两者任缺其一，都等于这把钥匙没了——届时所有已安装的用户都必须手工重装。
"@

$form2 = New-Object System.Windows.Forms.Form
$form2.Text = '签名密钥已就绪'
$form2.Size = New-Object System.Drawing.Size(700, 470)
$form2.StartPosition = 'CenterScreen'
$form2.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lblOk = New-Object System.Windows.Forms.Label
$lblOk.Text = if ($cert.created) { '已生成新的签名证书，并导出了私钥备份。' } else { '已使用本机现有的签名证书，并导出了私钥备份。' }
$lblOk.Location = New-Object System.Drawing.Point(18, 15)
$lblOk.Size = New-Object System.Drawing.Size(640, 22)
$form2.Controls.Add($lblOk)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.ScrollBars = 'Vertical'
$box.Font = New-Object System.Drawing.Font('Consolas', 9)
$box.Location = New-Object System.Drawing.Point(18, 45)
$box.Size = New-Object System.Drawing.Size(645, 320)
$box.Text = $info
$form2.Controls.Add($box)

$btnTxt = New-Object System.Windows.Forms.Button
$btnTxt.Text = '导出为 txt'
$btnTxt.Location = New-Object System.Drawing.Point(18, 378)
$btnTxt.Size = New-Object System.Drawing.Size(120, 32)
$btnTxt.Add_Click({
  $dlg = New-Object System.Windows.Forms.SaveFileDialog
  $dlg.Filter = '文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*'
  $dlg.FileName = "$safe-signing-key-info.txt"
  $dlg.InitialDirectory = $OutDir
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    # UTF8 with BOM：这份文件多半会用记事本打开，无 BOM 的话中文会是乱码。
    [System.IO.File]::WriteAllText($dlg.FileName, $info, (New-Object System.Text.UTF8Encoding($true)))
    [System.Windows.Forms.MessageBox]::Show("已保存到：`r`n$($dlg.FileName)", '签名密钥', 'OK', 'Information') | Out-Null
  }
})
$form2.Controls.Add($btnTxt)

$btnCopy = New-Object System.Windows.Forms.Button
$btnCopy.Text = '复制全部'
$btnCopy.Location = New-Object System.Drawing.Point(148, 378)
$btnCopy.Size = New-Object System.Drawing.Size(120, 32)
$btnCopy.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($info) })
$form2.Controls.Add($btnCopy)

$btnFolder = New-Object System.Windows.Forms.Button
$btnFolder.Text = '打开所在文件夹'
$btnFolder.Location = New-Object System.Drawing.Point(278, 378)
$btnFolder.Size = New-Object System.Drawing.Size(150, 32)
$btnFolder.Add_Click({ Start-Process explorer.exe "/select,`"$pfxPath`"" })
$form2.Controls.Add($btnFolder)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(568, 378)
$btnClose.Size = New-Object System.Drawing.Size(95, 32)
$btnClose.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form2.Controls.Add($btnClose)
$form2.AcceptButton = $btnClose

$form2.ShowDialog() | Out-Null
