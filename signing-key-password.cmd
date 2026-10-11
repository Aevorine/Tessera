@echo off
rem ============================================================================
rem  取回私钥备份 (.pfx) 的密码 —— 双击即可。
rem
rem  密码不以明文保存。它用 Windows 的 DPAPI 加密，只有你这个 Windows 账户在这台
rem  机器上能解开；文件夹被整个拷走也没用。这个脚本负责把它解出来给你看。
rem
rem  **请把取到的密码抄一份到离线的地方。** DPAPI 绑定本机 + 本账户，机器坏了或
rem  系统重装之后它就永远解不开了，而那时 .pfx 也跟着报废。
rem
rem  chcp 65001：否则下面的中文和 PowerShell 打回来的中文在默认 GBK 控制台里是乱码。
rem  -STA：WinForms 弹窗要求单线程单元。
rem ============================================================================

chcp 65001 > nul
cd /d "%~dp0modules\file_vault\ui"

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "scripts\signing-key-password.ps1" -Reveal -Gui

if errorlevel 1 (
  echo.
  echo 取不到密码。上面的信息如果看不懂，把整段发给我。
  pause
)
