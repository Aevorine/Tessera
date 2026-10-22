# Tessera 0.1.50

## System-level file engine startup

- Fix Windows login startup when the engine's Run command exists but Task Manager has disabled its startup approval.
- Explicitly enabling the system-level engine now enables both the Run command and its Windows startup approval. Disabling it removes the command and records disabled approval.
- Report startup as enabled only when the Run command exists and Windows has not disabled it.
- Create missing registry keys when enabling the engine. Continue to use the existing stable helper runtime, independent of the main application window.
- Respect an existing disabled startup entry during ordinary application startup; re-enable it only through an explicit enable action.

## 系统级引擎开机启动修复

修复文件管理器系统级引擎“启动命令已注册，但 Windows 启动项仍被禁用”的情况。开启引擎时，同时登记启动命令并启用 Windows 启动项；关闭时删除命令并记录禁用状态。状态查询同时检查启动命令和 Windows 的启用状态，不再把“命令存在”当成“下次登录一定会启动”。

引擎在登录 Windows 后从稳定目录独立后台启动，不需要先打开 Tessera 主窗口。普通启动时保留系统中的禁用选择；用户明确开启引擎时才重新启用。

## Publication and scope

- Windows portable and installer packages are rebuilt and signed with the existing publisher key. Android is rebuilt with versionCode 51; its interface behavior is unchanged. Rendezvous archives and the multi-architecture GHCR image are versioned with this release.
- Public source excludes local startup-registry backups, machine paths, credentials, signing keys, vault data, clipboard contents and private build receipts.
- The affected machine's startup approval was restored in a separate local repair; no machine-specific registry data is included here.
- No automated test suite, Windows reboot/sign-in acceptance test or physical multi-device test was run for this publication. Build, secret-scan, signature and remote artifact-integrity evidence is recorded separately.
- GitHub Releases retain the latest two versions. Old local application builds and release staging copies are removed after publication and integrity checks.
