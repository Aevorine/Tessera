<#
.SYNOPSIS
  导出一份**能带走**的、密码保护的签名私钥副本。

.DESCRIPTION
  跑法：`npm run signing:export`

  这是整套流程里唯一一件必须由人来做的事，因为它需要你想一个密码。别的都由
  `npm run build:standalone` 自动完成了。

  ## 为什么还需要这一份

  构建脚本已经自动导出过一份备份了，但那份是**绑定当前 Windows 账户**的
  （`-ProtectTo`）——它能救的是"证书从存储里被误删"，救不了换机器、重装系统、
  或者账户没了。这一份用密码加密，可以拷到别的机器、拷到离线介质上。

  ## 丢了会怎样

  你再也签不出能被**已安装客户端**接受的包。那些客户端里钉着旧公钥，新密钥签的
  包一律拒绝。唯一的出路是发一个钉新公钥的版本，然后挨个通知用户手动下载一次。

  所以：导出之后放到一个跟这台机器不在一起的地方。**绝不提交进仓库，绝不放进
  CI secrets**——任何能改 workflow 的人都能拿它签任意东西，这套机制就白做了。

.PARAMETER Subject
  证书主体 CN。不传就从 signer-policy.json 里读。

.PARAMETER OutPath
  导出到哪。默认放当前目录下，文件名带日期。
#>
[CmdletBinding()]
param(
  [string]$Subject,
  [string]$OutPath
)

$ErrorActionPreference = 'Stop'

if (-not $Subject) {
  $policyPath = Join-Path $PSScriptRoot '..\signer-policy.json'
  if (-not (Test-Path $policyPath)) {
    throw "signer-policy.json not found - run 'npm run build:standalone' once first."
  }
  # 显式 UTF-8：signer-policy.json 的注释是中文，而 Windows PowerShell 5.1 的
  # Get-Content 对无 BOM 文件按系统 ANSI（gb2312）解码，中文解坏后 JSON 解析直接
  # 失败，报错还指向注释中间。npm 脚本调的就是 powershell.exe（5.1）。
  $Subject = ([System.IO.File]::ReadAllText($policyPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).publisher
  if (-not $Subject) {
    throw "signer-policy.json has no publisher yet - run 'npm run build:standalone' once first."
  }
}

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq "CN=$Subject" -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  throw "no code-signing certificate with private key found for CN=$Subject on this machine."
}

if (-not $OutPath) {
  $safe = $Subject -replace '[\\/:*?"<>|]', '_'
  $OutPath = Join-Path (Get-Location) ("{0}-signing-{1:yyyyMMdd}.pfx" -f $safe, (Get-Date))
}

Write-Host "Exporting the signing key for: $Subject" -ForegroundColor Cyan
Write-Host "  thumbprint : $($cert.Thumbprint)"
Write-Host "  valid until: $($cert.NotAfter)"
Write-Host ''

$password = Read-Host -Prompt 'Password to protect the .pfx' -AsSecureString
$confirm = Read-Host -Prompt 'Confirm password' -AsSecureString

$a = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
$b = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm))
if ($a -ne $b) { throw 'passwords do not match.' }
if ($a.Length -lt 12) { throw 'use at least 12 characters - this password is the last line of defence on your signing key.' }

Export-PfxCertificate -Cert $cert -FilePath $OutPath -Password $password | Out-Null

Write-Host ''
Write-Host "Written: $OutPath" -ForegroundColor Green
Write-Host ''
Write-Host 'Put this somewhere that is NOT this machine.' -ForegroundColor Yellow
Write-Host 'Do NOT commit it, and do NOT put it in CI secrets.' -ForegroundColor Yellow
