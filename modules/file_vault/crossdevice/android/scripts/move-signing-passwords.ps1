<#
  一次性迁移：把 android-keystore.properties 里的明文 storePassword / keyPassword 移进 Windows 凭据管理器，
  先用 keytool 确认口令真能打开密钥库和密钥，再从文件里删掉这两行。全程不打印口令。文件里没有口令时改为交互输入。
  用法（自己在终端里跑，需要 JAVA_HOME 或 PATH 里有 keytool）：
    pwsh -File modules\file_vault\crossdevice\android\scripts\move-signing-passwords.ps1
#>
param([string]$PropsPath = $env:TESSERA_ANDROID_KEYSTORE_PROPS)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credman.ps1')
if (-not $PropsPath) { $PropsPath = [Environment]::GetEnvironmentVariable('TESSERA_ANDROID_KEYSTORE_PROPS', 'User') }
if (-not $PropsPath) {
  $keyDir = [Environment]::GetEnvironmentVariable('TESSERA_SIGNING_KEY_DIR', 'User')
  if ($keyDir) { $PropsPath = Join-Path $keyDir 'android-keystore.properties' }
}
if (-not $PropsPath -or -not (Test-Path -LiteralPath $PropsPath)) { throw '找不到 android-keystore.properties：设置 TESSERA_ANDROID_KEYSTORE_PROPS 或用 -PropsPath 指定' }

$keytool = if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
  Join-Path $env:JAVA_HOME 'bin\keytool.exe'
} else { (Get-Command keytool -ErrorAction SilentlyContinue).Source }
if (-not $keytool) { throw '找不到 keytool：设置 JAVA_HOME 或把 JDK 的 bin 放进 PATH（用来核对口令，文件未改动）' }

$lines = [IO.File]::ReadAllLines($PropsPath)
# 按 java.util.Properties.load 的规则取值：键区分大小写、同键以最后一行为准、值尾部空白保留、反斜杠转义还原
function ConvertFrom-JavaEscape([string]$v) {
  [regex]::Replace($v, '\\(u[0-9a-fA-F]{4}|.)', {
    param($m) $c = $m.Groups[1].Value
    switch -CaseSensitive ($c) { 't' { "`t" } 'n' { "`n" } 'r' { "`r" } 'f' { "`f" }
      default { if ($c.Length -eq 5) { [string][char][Convert]::ToInt32($c.Substring(1), 16) } else { $c } } }
  })
}
function Get-PropValue([string]$name) {
  $raw = $null
  foreach ($l in $lines) {
    if ($l -cmatch "^[ \t\f]*$name(?=[ \t\f=:]|$)[ \t\f]*(?:[=:][ \t\f]*)?(.*)$") { $raw = $Matches[1] }
  }
  if ($null -eq $raw) { return $null }
  # 行尾奇数个反斜杠 = 续行：脚本不拼接多行，宁可停下也不存错
  if (([regex]::Match($raw, '\\*$').Length % 2) -eq 1) { throw "$name 用了续行符，请手动改成一行后再跑（文件未改动）" }
  ConvertFrom-JavaEscape $raw
}
$store = Get-PropValue 'storePassword'
$key = Get-PropValue 'keyPassword'
$storeFile = Get-PropValue 'storeFile'
$alias = Get-PropValue 'keyAlias'
if (-not $storeFile -or -not $alias) { throw 'properties 里缺 storeFile 或 keyAlias（文件未改动）' }
# 与 build.gradle.kts 的 file() 一致：相对路径按 app 模块目录解析
if (-not [IO.Path]::IsPathRooted($storeFile)) { $storeFile = Join-Path (Join-Path $PSScriptRoot '..\app') $storeFile }

function Read-Secret([string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  $p = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringUni($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p) }
}
if (-not $store) { $store = Read-Secret '密钥库口令 (storePassword)' }
if (-not $key) { $key = Read-Secret '密钥口令 (keyPassword，直接回车 = 与密钥库口令相同)'; if (-not $key) { $key = $store } }
if (-not $store) { throw '没有拿到密钥库口令' }

# 用口令真开一次密钥库并取出私钥（生成一份丢弃的证书请求）：口令经环境变量交给 keytool，不出现在命令行
$env:TESSERA_MIGRATE_SP = $store
$env:TESSERA_MIGRATE_KP = $key
try {
  & $keytool -certreq -alias $alias -keystore $storeFile -storepass:env TESSERA_MIGRATE_SP -keypass:env TESSERA_MIGRATE_KP *> $null
  if ($LASTEXITCODE -ne 0) { throw '这组口令打不开密钥库或密钥（文件与凭据管理器都未改动）' }
} finally {
  Remove-Item Env:TESSERA_MIGRATE_SP, Env:TESSERA_MIGRATE_KP -ErrorAction SilentlyContinue
}

[TesseraCredMan]::Write($TesseraStoreTarget, 'tessera', $store)
[TesseraCredMan]::Write($TesseraKeyTarget, 'tessera', $key)
if ([TesseraCredMan]::Read($TesseraStoreTarget) -cne $store -or [TesseraCredMan]::Read($TesseraKeyTarget) -cne $key) { throw '写入凭据管理器后读回不一致，文件未改动' }
$store = $null; $key = $null

$kept = @($lines | Where-Object { $_ -cnotmatch '^[ \t\f]*(storePassword|keyPassword)(?=[ \t\f=:]|$)' })
$removed = $lines.Count - $kept.Count
if ($removed -gt 0) {
  $tmp = "$PropsPath.tmp"
  [IO.File]::WriteAllLines($tmp, $kept)
  Move-Item -LiteralPath $tmp -Destination $PropsPath -Force
}
Write-Output "口令已核对能打开密钥库，并存进 Windows 凭据管理器（$TesseraStoreTarget / $TesseraKeyTarget）；从 properties 删掉 $removed 行明文口令。"
