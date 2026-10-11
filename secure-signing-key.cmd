@echo off
rem ============================================================================
rem  用你自己的口令重新保护私钥备份 —— 双击即可，做一次就够。
rem
rem  做完之后：
rem    * 这台机器上不再存在任何能打开私钥备份的东西（随机密码和它的密文都会被删）
rem    * 保护不再绑定这台机器 —— 换台电脑，用同一个口令照样能打开
rem
rem  会问你要一个口令（也可以让它生成一个强口令，只显示一次）。口令**不会被保存
rem  在任何地方**——这正是它安全的原因，也意味着忘了就没了。
rem
rem  chcp 65001：否则中文在默认 GBK 控制台里是乱码。
rem  -STA：WinForms 弹窗要求单线程单元。
rem ============================================================================

chcp 65001 > nul
cd /d "%~dp0modules\file_vault\ui"

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "scripts\secure-signing-key.ps1"

if errorlevel 1 (
  echo.
  echo 出错了。上面的信息如果看不懂，把整段发给我。
  pause
)
