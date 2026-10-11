@echo off
rem ============================================================================
rem  发布签名密钥 —— 双击这个文件就行，不用开终端、不用切目录。
rem
rem  它会弹一个框让你输两次密码，然后自动准备好签名证书、导出带密码保护的
rem  私钥备份（.pfx），并把这把钥匙的身份信息显示出来（可另存为 txt）。
rem
rem  ## 为什么要有这个 .cmd
rem
rem  命令行版是 `npm run signing:key`，但 npm 必须在有 package.json 的目录下跑。
rem  在别处敲会得到：
rem      npm error code ENOENT ... Could not read package.json
rem  ——一个跟签名毫无关系、也完全看不出该怎么办的错。这个批处理用 %~dp0 定位到
rem  自己所在的目录，再进到 ui/ 去，所以放在哪、从哪双击都不会错。
rem
rem  ## 编码
rem
rem  先切到 UTF-8 代码页（chcp 65001），否则上面这些中文注释和 PowerShell 打回来
rem  的中文提示在默认的 GBK 控制台里会是乱码。> nul 是为了不让 chcp 自己那行
rem  "Active code page: 65001" 冒出来。
rem ============================================================================

chcp 65001 > nul
cd /d "%~dp0modules\file_vault\ui"

rem -STA：WinForms 要求单线程单元。powershell.exe 默认就是 STA，显式写出来是为了
rem 万一将来改用 pwsh（7 默认 MTA）——那时不加这个参数，弹框会直接失败。
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "scripts\signing-key-gui.ps1"

if errorlevel 1 (
  echo.
  echo 出错了。上面的信息如果看不懂，把整段发给我。
  pause
)
