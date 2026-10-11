<#
.SYNOPSIS
  保护 / 取回 .pfx 的密码。把明文密码换成只有你这个 Windows 账户能解开的密文。

.DESCRIPTION
  ## 要解决的问题

  自动导出私钥备份时，密码是脚本随机生成的——没人记得住，所以它必须被写在某个
  地方。最初写在 .pfx 旁边的 .txt 里，那等于**没有密码**：能读到那个文件夹的
  任何东西（同步盘客户端、备份软件、翻硬盘的人、任何以你身份运行的程序）都能
  同时拿到密钥和开锁的钥匙。

  ## 做法

  用 **DPAPI**（Windows 数据保护 API）把密码加密成一个 .dpapi 文件。DPAPI 的密钥
  由 Windows 从你的登录凭据派生并托管，**不出现在磁盘上任何地方**，所以：

    * 这个文件被拷到别的机器 / 别的 Windows 账户下 → 解不开，是一串废字节。
    * 连同 .pfx 一起被上传到网盘、被备份软件抓走 → 拿到的人开不了。
    * 你自己在这台机器上、用这个账户 → 一条命令就能取回来。

  这不是万能的：**以你的身份运行的恶意程序仍然能解开它**（DPAPI 保护的是"换个
  身份就读不了"，不是"本人也读不了"）。但它把"任何人拷走文件夹就得手"降级成了
  "必须先拿到你的 Windows 账户"，这中间差着一整个攻击面。

  ## 代价（必须知道）

  DPAPI 绑定这台机器 + 这个账户。**机器坏了、系统重装了、账户没了，这个 .dpapi
  文件就永远解不开了**——而那时 .pfx 也就成了一块打不开的砖，和丢了私钥没区别。

  所以 -Reveal 存在的意义不是"临时看一眼"，而是**让你在机器还活着的时候，把密码
  抄一份到离线的地方**（密码管理器、纸、保险箱）。这一步没有任何自动化能替你做：
  任何"自动存到第二个地方"的方案，都只是把同一个问题挪到那个地方去。

.PARAMETER Protect
  把 -PlainPassword 给的密码加密存起来。已存在则覆盖。

.PARAMETER Reveal
  解出密码并打印到 stdout（配合 -Gui 则弹窗显示，带复制按钮）。

.PARAMETER Gui
  用弹窗而不是终端输出。给不用命令行的人。

.NOTES
  本文件必须存成 UTF-8 with BOM——Windows PowerShell 5.1 对无 BOM 的 .ps1 按系统
  ANSI 代码页解码，满篇中文会被解坏。同目录 ensure-signing-cert.ps1 踩过这个坑。
#>
[CmdletBinding(DefaultParameterSetName = 'Reveal')]
param(
  [Parameter(ParameterSetName = 'Protect', Mandatory = $true)]
  [switch]$Protect,

  [Parameter(ParameterSetName = 'Protect')]
  [string]$PlainPassword,

  [Parameter(ParameterSetName = 'Reveal')]
  [switch]$Reveal,

  [switch]$Gui,

  # 位置不写死、不进仓库——理由同 secure-signing-key.ps1 里那段：
  # 路径本身就是敏感信息，而提交进去的东西会永远留在 git 历史里。
  [string]$KeyDir = $env:TESSERA_SIGNING_KEY_DIR
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($KeyDir)) {
  throw @'
没有指定密钥库位置。

  [Environment]::SetEnvironmentVariable('TESSERA_SIGNING_KEY_DIR','<你的目录>','User')

或者每次传参： -KeyDir '<你的目录>'
'@
}

$blobPath = Join-Path $KeyDir 'Tessera-signing-password.dpapi'

function Protect-Password([string]$plain) {
  if (-not (Test-Path $KeyDir)) { New-Item -ItemType Directory -Path $KeyDir -Force | Out-Null }
  # ConvertFrom-SecureString **不带 -Key** 时走 DPAPI，密钥由 Windows 按当前用户
  # 托管。带 -Key 的话密钥就得自己存在某个地方，那又回到了原来的问题。
  $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
  $cipher = ConvertFrom-SecureString -SecureString $secure
  [System.IO.File]::WriteAllText($blobPath, $cipher, (New-Object System.Text.ASCIIEncoding))
  return $blobPath
}

function Unprotect-Password() {
  if (-not (Test-Path $blobPath)) {
    throw "找不到 $blobPath —— 密码还没被保护起来，或者 -KeyDir 指错了。"
  }
  $cipher = [System.IO.File]::ReadAllText($blobPath).Trim()
  try {
    $secure = ConvertTo-SecureString -String $cipher
  } catch {
    # 最常见的原因就是"换了机器/换了账户"，而默认报错完全看不出这一点。
    throw ("解不开这个密码文件。DPAPI 密文只能由**加密它的那个 Windows 账户、" +
           "在那台机器上**解开——如果你换了电脑、重装了系统或换了账户，它就永久" +
           "失效了，请改用你当初抄到离线处的那份密码。原始错误：$($_.Exception.Message)")
  }
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ($Protect) {
  if (-not $PlainPassword) { throw "-Protect 需要 -PlainPassword。" }
  $p = Protect-Password $PlainPassword
  Write-Output "已加密保存：$p"
  return
}

# 默认就是 Reveal
$password = Unprotect-Password

if (-not $Gui) {
  Write-Output $password
  return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Tessera 签名密钥 - 备份密码'
$form.Size = New-Object System.Drawing.Size(660, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = "这是私钥备份 (.pfx) 的密码。`r`n`r`n它平时以加密形式存放，只有你这个 Windows 账户在这台机器上能解开。"
$lbl.Location = New-Object System.Drawing.Point(18, 15)
$lbl.Size = New-Object System.Drawing.Size(610, 50)
$form.Controls.Add($lbl)

$box = New-Object System.Windows.Forms.TextBox
$box.ReadOnly = $true
$box.Font = New-Object System.Drawing.Font('Consolas', 10)
$box.Location = New-Object System.Drawing.Point(18, 72)
$box.Size = New-Object System.Drawing.Size(610, 26)
$box.Text = $password
$form.Controls.Add($box)

$warn = New-Object System.Windows.Forms.Label
$warn.Location = New-Object System.Drawing.Point(18, 110)
$warn.Size = New-Object System.Drawing.Size(610, 120)
$warn.ForeColor = [System.Drawing.Color]::Firebrick
$warn.Text = @"
请现在就把它抄一份到离线的地方（密码管理器、纸质记录都行）。

原因：这个密码的加密方式绑定当前这台机器和这个 Windows 账户。机器坏了、系统重装了、
账户没了，它就永远解不开——那时 .pfx 也跟着变成一块打不开的砖，等同于私钥丢失，
所有已安装的用户都必须手工重装。

这一步没有任何自动化能替你完成：把它"自动存到第二个地方"，只是把同一个风险
挪到那个地方去。
"@
$form.Controls.Add($warn)

$btnCopy = New-Object System.Windows.Forms.Button
$btnCopy.Text = '复制密码'
$btnCopy.Location = New-Object System.Drawing.Point(18, 240)
$btnCopy.Size = New-Object System.Drawing.Size(120, 32)
$btnCopy.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($password) })
$form.Controls.Add($btnCopy)

$btnFolder = New-Object System.Windows.Forms.Button
$btnFolder.Text = '打开密钥文件夹'
$btnFolder.Location = New-Object System.Drawing.Point(148, 240)
$btnFolder.Size = New-Object System.Drawing.Size(150, 32)
$btnFolder.Add_Click({ Start-Process explorer.exe $KeyDir })
$form.Controls.Add($btnFolder)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '关闭'
$btnClose.Location = New-Object System.Drawing.Point(533, 240)
$btnClose.Size = New-Object System.Drawing.Size(95, 32)
$btnClose.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnClose)
$form.AcceptButton = $btnClose

$form.ShowDialog() | Out-Null
