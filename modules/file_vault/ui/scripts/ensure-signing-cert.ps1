<#
.SYNOPSIS
  确保本机有一张可用的代码签名证书，没有就造一张。输出 JSON 供构建脚本读取。

.DESCRIPTION
  由 `npm run build:standalone` 自动调用，**正常情况下不需要你手工跑**。

  幂等：已经有一张主体名匹配、带私钥、没过期的证书就直接用它，什么都不改。这一点
  很重要——每次构建都新造一张证书的话，公钥每次都变，客户端钉的那把就永远对不上。

  ## 为什么这件事可以完全自动化，而买来的证书不行

  自签名证书不需要任何人审核，`New-SelfSignedCertificate` 一条命令就出。私钥由
  Windows 证书存储保管（`Cert:\CurrentUser\My`），跟着当前用户账户走，不需要密码
  也不需要硬件令牌。所以"生成证书"这一步没有任何必须由人来做的决定。

  真正没法自动化的只有一件事：**把私钥备份到这台机器之外**。脚本会自动导出一份
  绑定当前 Windows 账户的备份（不需要密码，但也只能在这台机器的这个账户上还原），
  想要一份能带走的、密码保护的副本，跑 `npm run signing:export`。

.PARAMETER Subject
  证书主体 CN。用户在文件属性「数字签名」里看到的就是这个名字。

.PARAMETER BackupDir
  自动备份的存放目录。默认 %LOCALAPPDATA%\Ideal1 Signing。
  **刻意放在仓库外面**：放仓库里迟早会被 `git add -f` 或者某个打包步骤带进去。

.OUTPUTS
  一行 JSON：{ publisher, publicKeySha256, thumbprint, notAfter, created, backupPath }
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Subject,

  [int]$Years = 20,

  [string]$BackupDir = (Join-Path $env:LOCALAPPDATA 'Ideal1 Signing')
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 does not always auto-load the security module when invoked with
# -NoProfile from Node. Without the module, Cert:\ is still visible but the
# -CodeSigningCert dynamic parameter is missing, so a valid local certificate is
# incorrectly reported as unavailable.
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

function Get-PublicKeySha256([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert) {
  # 公钥的 SHA-256，不是 $Cert.Thumbprint。后者是整张证书的 SHA-1，而 SHA-1 的
  # 选择前缀碰撞早已被实际做出来过；而且钉公钥允许证书过期后用同一对密钥重新签发，
  # 老客户端照样认（详见 electron/updateVersion.ts 的 assertTrustedSigner）。
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash($Cert.GetPublicKey()) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

# 找一张能用的：主体名一致、有私钥、有代码签名用途、且还没过期。
# 任何一条不满足都当作"没有"，重新造一张——用一张过期的或者没私钥的证书去签名，
# 失败会发生在 signtool 那一步，报的错跟真实原因隔着好几层。
$now = Get-Date
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Subject -eq "CN=$Subject" -and
    $_.HasPrivateKey -and
    $_.NotAfter -gt $now.AddDays(30) -and
    $_.NotBefore -le $now
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

$created = $false
if (-not $existing) {
  # KeyExportPolicy Exportable：不可导出的私钥一旦这台机器坏了就彻底没了，而丢私钥
  # 的代价是所有已安装用户都要手动重装一次。可导出是为了能备份，不是为了方便。
  $existing = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$Subject" `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter $now.AddYears($Years)
  $created = $true
}

# 自动备份：绑定当前 Windows 账户，不需要密码，所以可以无人值守地做。
# 能挡住的是"证书从存储里被误删"这类事故；挡不住换机器或重装系统——那需要一份
# 密码保护的副本，见 npm run signing:export。
#
# **注意 -ProtectTo 要求域账户。** 在本机这种本地账户上它必然失败，报
# 「使用 ProtectTo 参数需要以域账户身份运行」。这是设计上的限制，不是配置错误：
# 它把私钥的访问权绑到 AD 主体上，本地账户没有可绑的对象。
#
# 所以在非域环境里，**这个自动备份是拿不到的**，下面的 catch 会把它降级成警告
# 并提醒去跑 signing:export（那条路会问你要一个密码，因此不能无人值守，但它产出
# 的副本换台机器也能用——真正的灾难恢复靠的是它，不是这里）。
$backupPath = Join-Path $BackupDir ("{0}.pfx" -f ($Subject -replace '[\\/:*?"<>|]', '_'))
if (-not (Test-Path $backupPath)) {
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
  try {
    Export-PfxCertificate -Cert $existing -FilePath $backupPath -ProtectTo "$env:USERNAME" | Out-Null
  } catch {
    # 备份失败不该让构建停下来：证书本身在存储里是好的，签名照样能进行。
    # 但也绝不静默。
    #
    # **不要用 `[Console]::Error.WriteLine(...)`**（这里原来就是那么写的）：
    # 构建脚本是用 Node 起的 PowerShell，没有附着的控制台，`[Console]::Error`
    # 此时是 **null**，于是这一行自己抛 InvokeMethodOnNull——**报错的代码把构建
    # 弄挂了**，而真正的问题（备份没做成）只是个警告。
    #
    # 这个坑在本机是必现的：下面 -ProtectTo 需要域账户，本地账户永远失败，
    # 所以每次构建都会走进这个 catch，然后每次都挂在这一行。表面现象是
    # 「签名证书拿不到」，跟备份八竿子打不着。
    #
    # Write-Warning 不依赖控制台句柄，永远可用。
    Write-Warning "could not write the automatic key backup to ${backupPath}: $($_.Exception.Message)"
    # 注意：这里不能用反引号包 npm 命令——PowerShell 的反引号是**转义符**，
    # "`n" 会变成换行，字符串还会因为末尾那个反引号直接解析失败
    # （ParserError: TerminatorExpectedAtEndOfString）。用单引号。
    Write-Warning "私钥仍然只在本机证书存储里。请尽快跑一次 'npm run signing:export' 导出一份带密码的副本。"
    $backupPath = $null
  }
}

[pscustomobject]@{
  publisher       = $Subject
  publicKeySha256 = Get-PublicKeySha256 $existing
  thumbprint      = $existing.Thumbprint
  notAfter        = $existing.NotAfter.ToUniversalTime().ToString('o')
  created         = $created
  backupPath      = $backupPath
} | ConvertTo-Json -Compress
