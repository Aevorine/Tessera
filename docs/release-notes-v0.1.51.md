# Tessera 0.1.51

## Devices & sync global shortcut

- Press **Ctrl+Alt+D** while Tessera is running to bring the window forward and open Devices & sync. It also works while the application is minimized or in the tray.
- Change the binding in **Settings → Shortcuts**. Changes apply immediately, persist across restart and use the existing conflict detection and registration-status display.
- If the vault is locked, the shortcut shows the login window and retains the requested page until unlock. Existing module authentication remains in force.
- Existing global shortcut preferences are retained. If the new default collides with a previously customized global binding during migration, only the new action receives an unused fallback combination.
- The help shortcut table and question-mark quick reference display the current customized binding.

## Updated help

Refresh all six help languages with four global and five file-operation shortcuts, search navigation, remembered/default sending devices, offline-target behavior, folder-transfer scope and system-level engine Windows login startup. Remove outdated panel counts and unsupported blanket speed claims.

## 设备与同步全局快捷键

Tessera 保持运行时，按 **Ctrl+Alt+D** 可从其他应用唤起设备与同步，最小化或驻留托盘时同样可用。在 **设置 → 快捷键** 中可手动修改，保存后即时注册并保留供下次启动使用；被占用的组合会显示注册失败状态。

金库锁定时先显示登录界面，解锁后再进入所请求页面，不绕过模块验证。升级保留原有自定义全局键；若新默认键与旧键冲突，只为新增动作选择备用组合。

帮助界面和快捷键速查表会显示当前设置的键位，六种语言同步补充搜索、默认发送设备、离线目标、文件夹传输范围和系统级引擎登录自启动说明。

## Publication scope

Rebuild and sign Windows and Android packages (Android versionCode 52), version the rendezvous archives and GHCR image, and publish after public-tree/history secret scans and remote asset size/SHA-256 readback. Signing material, local key bindings, device identities, registry backups, vaults and clipboard contents remain excluded.

No automated test suite or physical desktop keyboard/device end-to-end test was run for this publication. Existing shortcut default expectations were updated without running the suite. GitHub Releases retain the newest two versions; obsolete local application outputs and staging copies are removed after publication integrity checks.
