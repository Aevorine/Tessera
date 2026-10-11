<#
.SYNOPSIS
  用你自己的口令重新保护私钥备份，**并且不在磁盘上留下任何可以解开它的东西**。

.DESCRIPTION
  ## 为什么要有这一步

  自动导出 .pfx 时脚本随机生成了一个 44 位密码。没人记得住随机串，所以它必须被
  存在某个地方——而"存在某个地方"正是全部问题的根源：

    * 存成明文  → 能读到那个文件夹的任何东西都同时拿到了钥匙和锁。
    * 存成 DPAPI 密文 → 以你的身份运行的程序照样能解开（DPAPI 保护的是"换个身份
      读不了"，不是"本人也读不了"）；而且它绑定这台机器和这个账户，机器没了密文
      就永久失效，.pfx 跟着变成一块砖。

  换任何一种加密方式都只是把问题挪一层：**保护那个密码的东西，又该由谁来保护。**

  ## 做法：让"要存的秘密"根本不存在

  用**你自己的口令**重新导出 .pfx，然后把随机密码连同它的密文一起删掉。之后：

    * 磁盘上不再有任何能打开 .pfx 的东西。翻遍这台机器也翻不出来。
    * 保护不再绑定这台机器——.pfx 拷到任何地方，用同一个口令都能打开。
      机器坏了、系统重装了、账户没了，只要你记得口令，密钥就还在。

  一句话：第一个问题（本机恶意程序）从"能解开"变成"必须在你输入口令的那一刻抓到
  它"；第二个问题（机器绑定）直接消失。

  ## 这一步为什么必须你参与

  口令必须是**只存在于你脑子里（或你的密码管理器里）**的东西。任何"自动生成并
  替你保管"的方案，都会立刻退化回上面那两条——因为保管的地方就在这台机器上。
  这不是自动化偷懒，是这件事的定义如此：能被本机自动取用的秘密，就不是秘密。

  两种都支持，选一个：
    * 自己想一个口令（推荐记进密码管理器）
    * 让脚本生成一个强口令，**只显示这一次**，你抄走 / 打印

.PARAMETER SelfTest
  拿一张临时的自签名证书，完整跑一遍"导出 → 用口令重新打开"的往返，验证机制本身
  可用。不碰真实密钥，不写真实目录。

.NOTES
  必须存成 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 gb2312 解码中文注释。
#>
[CmdletBinding()]
param(
  # 密钥库的位置**不写死在这里**，也不进仓库。
  #
  # 路径本身就是攻击者想要的信息：知道 .pfx 放在哪，剩下的只是拿到那台机器。
  # 一个提交进版本库的默认值等于把它公开出去，而且删不干净——它会永远留在
  # git 历史里。所以位置只从环境变量来，或者每次显式传 -KeyDir。
  #
  # 设一次（当前用户，重开终端生效）：
  #   [Environment]::SetEnvironmentVariable('TESSERA_SIGNING_KEY_DIR','<你的目录>','User')
  [string]$KeyDir = $env:TESSERA_SIGNING_KEY_DIR,
  [string]$Subject = 'Tessera',
  [switch]$SelfTest
)

if (-not $SelfTest -and [string]::IsNullOrWhiteSpace($KeyDir)) {
  throw @'
没有指定密钥库位置。

这个路径不写进仓库（位置本身就是敏感信息），所以要么设环境变量、要么每次传参：

  [Environment]::SetEnvironmentVariable('TESSERA_SIGNING_KEY_DIR','<你的目录>','User')

或者：

  .\secure-signing-key.ps1 -KeyDir '<你的目录>'
'@
}

$ErrorActionPreference = 'Stop'

function New-StrongPassphrase {
  # 6 组 5 位大写字母数字，去掉容易看错的 I/O/0/1（这份口令是要被人抄到纸上的）。
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 30
  $rng.GetBytes($bytes)
  $chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
  return (($chars -join '') -replace '(.{5})(?!$)', '$1-')
}

<#
  这把私钥现在还能不能被导出？

  两条路都试：不同的密钥存储提供程序（CAPI / CNG）对"不可导出"的表现不一样，
  只试一条会得出相反的结论——实测同一台机器上，真实证书用 ExportPkcs8PrivateKey()
  能导出，而 New-SelfSignedCertificate 刚造出来的那张却在同一个调用上抛异常。
  只要**任意一条**能导出，就算可导出。
#>
function Test-KeyExportable {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)
  try { $null = $Cert.PrivateKey.ExportPkcs8PrivateKey(); return $true } catch { }
  $probe = Join-Path $env:TEMP ("_exp-" + [Guid]::NewGuid().ToString('N').Substring(0,6) + ".pfx")
  try {
    Export-PfxCertificate -Cert $Cert -FilePath $probe `
      -Password (ConvertTo-SecureString 'probe-only' -AsPlainText -Force) -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false } finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}

function Export-WithPassphrase {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert,
        [string]$Path, [string]$Passphrase)
  $secure = ConvertTo-SecureString -String $Passphrase -AsPlainText -Force
  Export-PfxCertificate -Cert $Cert -FilePath $Path -Password $secure -Force | Out-Null
}

<#
  把证书存储里那把**活的**私钥换成不可导出的。

  ## 为什么这才是重点

  保护 .pfx 备份，防的是"攻击者拿到备份文件"。但只要证书存储里那把正在用的私钥
  是可导出的，攻击者**根本不需要备份**——一行 PowerShell 就能把它取走：

      $cert.PrivateKey.ExportPkcs8PrivateKey()

  不弹窗、不要口令、以当前用户身份即可。所以在做完这一步之前，前面所有关于备份
  口令的功夫，防的都是一扇敞着后门的房子的正门。

  ## 做完之后

  私钥仍然能**用来签名**（signtool 照常工作），但**取不出来**——CNG/CAPI 在导出
  时会直接拒绝。恶意程序能做的从"悄悄复制走你的签名身份、以后随时冒充你"降级成
  "只能在它还在你机器上时借用一次"。

  ## 代价

  存储里的这把从此再也导不出来。**唯一的备份就是那个 .pfx**——所以这一步必须在
  .pfx 已经被验证可以用口令打开之后才做，顺序不能反。
#>
function Convert-KeyToNonExportable {
  param([string]$PfxPath, [string]$Passphrase, [string]$Thumbprint)

  $secure = ConvertTo-SecureString -String $Passphrase -AsPlainText -Force
  $storePath = "Cert:\CurrentUser\My\$Thumbprint"

  # 先把旧的那份（可导出）从存储里拿掉。同一指纹在存储里只能有一份，不先删
  # 就导不进去。此刻 .pfx 已经验证过能打开，所以这一步是可回退的。
  if (Test-Path $storePath) { Remove-Item $storePath -Force -DeleteKey -ErrorAction SilentlyContinue }

  # **不带 -Exportable**：Import-PfxCertificate 默认导入为不可导出。
  Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $secure | Out-Null

  $now = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
  if (-not $now -or -not $now.HasPrivateKey) {
    # 导入失败：把可导出的那份原样放回去，绝不让用户落到"两边都没有"的状态。
    Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $secure -Exportable | Out-Null
    return @{ ok = $false; reason = '导入后证书不在存储里，已回滚为可导出状态。' }
  }

  # 真的去试一次导出，确认它现在确实导不出来。不验证的话，"我以为设了不可导出"
  # 和"确实不可导出"之间差着整个这一步的意义。
  if (Test-KeyExportable -Cert $now) {
    return @{ ok = $false; reason = '导入后私钥仍然可以导出，这台机器上的存储不支持该保护。' }
  }
  return @{ ok = $true; reason = '' }
}

function Test-PfxOpens {
  param([string]$Path, [string]$Passphrase)
  # 真的把它加载回来，而不是"导出没报错就算成功"。导出成功但打不开的 .pfx
  # 是最坏的一种结果：等你真需要它的那天才发现，而那天通常已经没有退路了。
  $secure = ConvertTo-SecureString -String $Passphrase -AsPlainText -Force
  try {
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
      $Path, $secure,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    return $c.HasPrivateKey
  } catch { return $false }
}

#--------------------------------------------------------------------------
# 自检：整套机制在临时证书上跑一遍，不碰真实密钥
#--------------------------------------------------------------------------
if ($SelfTest) {
  $tmp = Join-Path $env:TEMP ("sk-selftest-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $results = @()
  try {
    $c = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Tessera SelfTest' `
         -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 `
         -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
    $pfx = Join-Path $tmp 'test.pfx'
    $pass = New-StrongPassphrase
    $results += "生成的口令格式        : $pass"
    Export-WithPassphrase -Cert $c -Path $pfx -Passphrase $pass
    $results += "导出的 .pfx 存在      : $(Test-Path $pfx)"
    $results += "用正确口令能打开      : $(Test-PfxOpens -Path $pfx -Passphrase $pass)"
    $results += "用错误口令打不开      : $(-not (Test-PfxOpens -Path $pfx -Passphrase 'WRONG-WRONG-WRONG'))"

    # --- 加固：改成不可导出，然后验证「还能签名」和「确实导不出」 ---
    $results += "加固前可导出          : $(Test-KeyExportable -Cert $c)"

    $conv = Convert-KeyToNonExportable -PfxPath $pfx -Passphrase $pass -Thumbprint $c.Thumbprint
    $results += "加固执行成功          : $($conv.ok)$(if(-not $conv.ok){' -> '+$conv.reason})"

    $after = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $c.Thumbprint } | Select-Object -First 1
    $results += "加固后导不出来        : $(-not (Test-KeyExportable -Cert $after))"

    # **最要紧的一条**：不可导出的密钥必须仍然能用来签名。如果这里断了，加固就等于
    # 把发版能力一起锁死了——而那要等到下一次发布才会发现。
    $signOk = $false
    $st = $env:IDEAL1_SIGNTOOL
    if (-not $st) {
      $st = (Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
             Where-Object { $_.FullName -like '*x64*' } | Select-Object -First 1).FullName
    }
    if ($st -and (Test-Path $st)) {
      $victim = Join-Path $tmp 'sign-me.exe'
      Copy-Item "$env:WINDIR\System32\where.exe" $victim -Force
      # 断言 signtool 自己的退出码，**不要**去比对 Get-AuthenticodeSignature 的签发者：
      # 这个靶子是系统二进制的副本，Windows 会通过**目录签名(catalog)**继续把它认成
      # 微软签的，于是即便我们的签名写进去了，那个属性读出来仍是 Microsoft——
      # 一个跟"这把密钥能不能签名"毫无关系的假阴性（第一版就栽在这上面）。
      $argv = @('sign','/sha1',$c.Thumbprint,'/fd','sha256',$victim)
      & $st @argv 2>&1 | Out-Null
      $signOk = ($LASTEXITCODE -eq 0)
      $results += "加固后仍能签名        : $signOk (signtool exit=$LASTEXITCODE)"
    } else {
      $results += "加固后仍能签名        : 跳过（找不到 signtool）"
    }
  } finally {
    if ($c) { Remove-Item "Cert:\CurrentUser\My\$($c.Thumbprint)" -Force -ErrorAction SilentlyContinue }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  $results | ForEach-Object { Write-Output $_ }
  return
}

#--------------------------------------------------------------------------
# 真实流程
#--------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq "CN=$Subject" -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) { throw "本机没有 CN=$Subject 的签名证书（带私钥）。" }

$form = New-Object System.Windows.Forms.Form
$form.Text = "重新保护签名密钥 - CN=$Subject"
$form.Size = New-Object System.Drawing.Size(640, 500)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$intro = New-Object System.Windows.Forms.Label
$intro.Location = New-Object System.Drawing.Point(18, 15)
$intro.Size = New-Object System.Drawing.Size(595, 72)
$intro.Text = @"
用你自己的口令重新保护私钥备份。做完之后，这台机器上**不再存在任何能打开它的东西**
——现在那个随机密码和它的密文都会被删掉。

保护也不再绑定这台机器：换台电脑，用同一个口令照样能打开。
"@
$form.Controls.Add($intro)

$rbOwn = New-Object System.Windows.Forms.RadioButton
$rbOwn.Text = '我自己想一个口令（建议存进密码管理器）'
$rbOwn.Location = New-Object System.Drawing.Point(18, 95)
$rbOwn.Size = New-Object System.Drawing.Size(400, 24)
$rbOwn.Checked = $true
$form.Controls.Add($rbOwn)

$lbl1 = New-Object System.Windows.Forms.Label
$lbl1.Text = '口令'; $lbl1.Location = New-Object System.Drawing.Point(40, 128)
$lbl1.Size = New-Object System.Drawing.Size(60, 22); $form.Controls.Add($lbl1)
$txt1 = New-Object System.Windows.Forms.TextBox
$txt1.Location = New-Object System.Drawing.Point(105, 125); $txt1.Size = New-Object System.Drawing.Size(500, 24)
$txt1.UseSystemPasswordChar = $true; $form.Controls.Add($txt1)

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = '再输一次'; $lbl2.Location = New-Object System.Drawing.Point(40, 160)
$lbl2.Size = New-Object System.Drawing.Size(60, 22); $form.Controls.Add($lbl2)
$txt2 = New-Object System.Windows.Forms.TextBox
$txt2.Location = New-Object System.Drawing.Point(105, 157); $txt2.Size = New-Object System.Drawing.Size(500, 24)
$txt2.UseSystemPasswordChar = $true; $form.Controls.Add($txt2)

$chk = New-Object System.Windows.Forms.CheckBox
$chk.Text = '显示口令'; $chk.Location = New-Object System.Drawing.Point(105, 187)
$chk.Size = New-Object System.Drawing.Size(120, 24)
$chk.Add_CheckedChanged({ $txt1.UseSystemPasswordChar = -not $chk.Checked; $txt2.UseSystemPasswordChar = -not $chk.Checked })
$form.Controls.Add($chk)

$rbGen = New-Object System.Windows.Forms.RadioButton
$rbGen.Text = '帮我生成一个强口令（只显示这一次，请抄走或打印）'
$rbGen.Location = New-Object System.Drawing.Point(18, 220)
$rbGen.Size = New-Object System.Drawing.Size(500, 24)
$form.Controls.Add($rbGen)

$toggle = {
  $txt1.Enabled = $rbOwn.Checked; $txt2.Enabled = $rbOwn.Checked; $chk.Enabled = $rbOwn.Checked
}
$rbOwn.Add_CheckedChanged($toggle); $rbGen.Add_CheckedChanged($toggle)

$lblErr = New-Object System.Windows.Forms.Label
$lblErr.Location = New-Object System.Drawing.Point(18, 355)
$lblErr.Size = New-Object System.Drawing.Size(595, 36)
$lblErr.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($lblErr)

$chkHarden = New-Object System.Windows.Forms.CheckBox
$chkHarden.Text = '同时把证书存储里那把「活的」私钥改成不可导出（强烈建议）'
$chkHarden.Location = New-Object System.Drawing.Point(18, 250)
$chkHarden.Size = New-Object System.Drawing.Size(595, 24)
$chkHarden.Checked = $true
$form.Controls.Add($chkHarden)

$hardenHint = New-Object System.Windows.Forms.Label
$hardenHint.Location = New-Object System.Drawing.Point(38, 272)
$hardenHint.Size = New-Object System.Drawing.Size(575, 32)
$hardenHint.ForeColor = [System.Drawing.Color]::DimGray
$hardenHint.Text = "不改的话，攻击者根本不需要那个备份文件——一行命令就能把正在用的私钥取走。改完之后它仍然能签名，但取不出来。"
$form.Controls.Add($hardenHint)

$warn = New-Object System.Windows.Forms.Label
$warn.Location = New-Object System.Drawing.Point(18, 310)
$warn.Size = New-Object System.Drawing.Size(595, 44)
$warn.ForeColor = [System.Drawing.Color]::DimGray
$warn.Text = "口令不会被保存在任何地方——这正是它安全的原因，也意味着**忘了就没了**。`r`n忘记口令 = 私钥备份打不开；若此时证书存储也丢了，所有已安装用户都得手工重装。"
$form.Controls.Add($warn)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = '确定'; $btnOk.Location = New-Object System.Drawing.Point(400, 400)
$btnOk.Size = New-Object System.Drawing.Size(95, 32); $form.Controls.Add($btnOk)
$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '取消'; $btnCancel.Location = New-Object System.Drawing.Point(505, 400)
$btnCancel.Size = New-Object System.Drawing.Size(95, 32)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel; $form.AcceptButton = $btnOk

$script:pass = $null
$script:generated = $false
$btnOk.Add_Click({
  $lblErr.Text = ''
  if ($rbGen.Checked) {
    $script:pass = New-StrongPassphrase; $script:generated = $true
  } else {
    if ([string]::IsNullOrEmpty($txt1.Text)) { $lblErr.Text = '请输入口令。'; return }
    if ($txt1.Text.Length -lt 12) { $lblErr.Text = '口令太短，至少 12 位。它是私钥的唯一保护。'; return }
    if ($txt1.Text -ne $txt2.Text) { $lblErr.Text = '两次输入不一致。'; return }
    $script:pass = $txt1.Text
  }
  $form.DialogResult = [System.Windows.Forms.DialogResult]::OK; $form.Close()
})

if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$passphrase = $script:pass

#--------------------------------------------------------------------------
# 重新导出 + 验证 + 清除旧的可解开材料
#--------------------------------------------------------------------------
if (-not (Test-Path $KeyDir)) { New-Item -ItemType Directory -Path $KeyDir -Force | Out-Null }
$newPfx = Join-Path $KeyDir ("Tessera-signing-{0:yyyyMMdd}.pfx" -f (Get-Date))

Export-WithPassphrase -Cert $cert -Path $newPfx -Passphrase $passphrase

# **先验证再删旧的。** 顺序反过来的话，一次失败的导出会同时毁掉新旧两份。
if (-not (Test-PfxOpens -Path $newPfx -Passphrase $passphrase)) {
  [System.Windows.Forms.MessageBox]::Show(
    "新的 .pfx 导出后无法用这个口令打开，已中止。`r`n旧文件一个都没动。",
    '重新保护签名密钥', 'OK', 'Error') | Out-Null
  Remove-Item $newPfx -Force -ErrorAction SilentlyContinue
  return
}

# 加固存储里那把活的私钥。**必须在 .pfx 验证通过之后**——它做完就再也导不出来了，
# 那个 .pfx 会成为唯一的备份。
$hardened = $false
$hardenNote = '（未选择加固，存储里的私钥仍可导出）'
if ($chkHarden.Checked) {
  $r = Convert-KeyToNonExportable -PfxPath $newPfx -Passphrase $passphrase -Thumbprint $cert.Thumbprint
  $hardened = $r.ok
  $hardenNote = if ($r.ok) { '已改为不可导出（仍可用于签名）' } else { "加固失败，已保持原状：$($r.reason)" }
}

$removed = @()
foreach ($n in @('Tessera-signing-password.dpapi')) {
  $p = Join-Path $KeyDir $n
  if (Test-Path $p) { Remove-Item $p -Force; $removed += $n }
}

$pk = -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.GetPublicKey()) |
             ForEach-Object { $_.ToString('x2') })

# 恢复单：**不含口令**（口令只在你脑子里/密码管理器里）。这张纸的作用是让"换台
# 机器怎么恢复"这件事在你真需要的那天有据可查，而不是靠回忆。
$sheet = Join-Path $KeyDir 'Tessera-signing-recovery-sheet.txt'
$sheetText = @"
Tessera 发布签名密钥 - 恢复单
=============================
（这张纸不含口令。口令只在你自己那里。）

主体名        : CN=$Subject
证书指纹      : $($cert.Thumbprint)
公钥 SHA-256  : $pk
有效期至      : $($cert.NotAfter.ToUniversalTime().ToString('o'))
私钥备份文件  : $(Split-Path $newPfx -Leaf)
生成时间      : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

换一台机器怎么恢复
------------------
1. 把 $(Split-Path $newPfx -Leaf) 拷到新机器。
2. 双击它，选「当前用户」，输入你的口令导入。
3. 在仓库里跑一次 npm run build:standalone，它会认出这张证书并继续用它签名。
4. 核对：仓库 modules/file_vault/ui/signer-policy.json 里的 publicKeySha256
   必须等于上面那串「公钥 SHA-256」。不相等说明导入的不是同一把密钥。

要点
----
* 口令没有任何副本存在磁盘上。忘了口令 = 这个 .pfx 永远打不开。
* 但只要证书还在本机证书存储里，就还能继续发版——.pfx 是给"本机没了"用的。
  两者同时失去才是不可挽回的，所以请把这份 .pfx 也拷一份到别的地方。
"@
[System.IO.File]::WriteAllText($sheet, $sheetText, (New-Object System.Text.UTF8Encoding($true)))

#--------------------------------------------------------------------------
# 结果
#--------------------------------------------------------------------------
$done = New-Object System.Windows.Forms.Form
$done.Text = '已重新保护'; $done.Size = New-Object System.Drawing.Size(660, 430)
$done.StartPosition = 'CenterScreen'
$done.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'
$box.Font = New-Object System.Drawing.Font('Consolas', 9)
$box.Location = New-Object System.Drawing.Point(18, 15)
$box.Size = New-Object System.Drawing.Size(605, 290)

$genLine = if ($script:generated) {
"
!! 这是你的口令，只显示这一次，现在就抄走 !!

    $passphrase

关掉这个窗口之后，任何地方都不会再有它。
"
} else { "`n口令是你自己设的，没有存在任何地方。`n" }

$box.Text = @"
私钥备份已用你的口令重新导出。
$genLine
文件            : $newPfx
已删除          : $(if($removed){$removed -join ', '}else{'（没有需要删除的旧密码文件）'})
存储里的私钥    : $hardenNote
恢复单          : $(Split-Path $sheet -Leaf)

公钥 SHA-256    : $pk
（与仓库 signer-policy.json 里钉的值一致才算对）

现在的状态
----------
* 磁盘上不再有任何能打开这个 .pfx 的东西。
* 保护不再绑定这台机器——换台电脑用同一口令照样能打开。
* 请把这个 .pfx 再拷一份到别的地方（U 盘/另一台机器）。它和口令是两半，
  分开放才有意义。
"@
$done.Controls.Add($box)

$b1 = New-Object System.Windows.Forms.Button
$b1.Text = '打开文件夹'; $b1.Location = New-Object System.Drawing.Point(18, 318)
$b1.Size = New-Object System.Drawing.Size(130, 32)
$b1.Add_Click({ Start-Process explorer.exe "/select,`"$newPfx`"" }); $done.Controls.Add($b1)

$b2 = New-Object System.Windows.Forms.Button
$b2.Text = '打印恢复单'; $b2.Location = New-Object System.Drawing.Point(158, 318)
$b2.Size = New-Object System.Drawing.Size(130, 32)
$b2.Add_Click({ Start-Process -FilePath 'notepad.exe' -ArgumentList "/p `"$sheet`"" -ErrorAction SilentlyContinue })
$done.Controls.Add($b2)

$b3 = New-Object System.Windows.Forms.Button
$b3.Text = '关闭'; $b3.Location = New-Object System.Drawing.Point(528, 318)
$b3.Size = New-Object System.Drawing.Size(95, 32)
$b3.DialogResult = [System.Windows.Forms.DialogResult]::OK; $done.Controls.Add($b3)
$done.AcceptButton = $b3

$done.ShowDialog() | Out-Null
