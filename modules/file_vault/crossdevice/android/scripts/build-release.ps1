<#
  签名构建：从 Windows 凭据管理器取口令，只放进本进程环境交给 gradle 子进程，结束即清除。
  凭据管理器里没有时 gradle 退回 properties 里的口令（旧配置）。
#>
param([string[]]$Tasks = @('assembleRelease'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credman.ps1')
$store = [TesseraCredMan]::Read($TesseraStoreTarget)
$key = [TesseraCredMan]::Read($TesseraKeyTarget)
try {
  if ($store) { $env:TESSERA_ANDROID_STORE_PASSWORD = $store; $env:TESSERA_ANDROID_KEY_PASSWORD = $(if ($key) { $key } else { $store }) }
  Write-Output ("signing passwords from: {0}" -f $(if ($store) { 'Windows Credential Manager' } else { 'properties file (legacy)' }))
  Push-Location (Join-Path $PSScriptRoot '..')
  try {
    # Kotlin 编译放进本进程：否则会留下一个继承了口令环境变量的编译守护进程
    & .\gradlew.bat @Tasks --no-daemon -q '-Pkotlin.compiler.execution.strategy=in-process'
    $code = $LASTEXITCODE
  } finally { Pop-Location }
} finally {
  Remove-Item Env:TESSERA_ANDROID_STORE_PASSWORD, Env:TESSERA_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
  $store = $null; $key = $null
}
exit $code
