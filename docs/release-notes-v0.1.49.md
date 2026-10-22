# Tessera 0.1.49

## Default sending device

- Devices & sync remembers the last single-device or multiple-device selection across page changes and application restarts.
- Choose a default sending device in the sending toolbar. It takes priority when the page opens; you can still change targets for an individual send.
- Files, folders, drag-and-drop and manual clipboard sends use the same selected targets. Clipboard history sends no longer broadcast to every online device.
- Automatic clipboard sync uses only the configured default device. Clearing the default restores the existing per-device clipboard policies.
- An offline target stays selected. Reconnection makes it usable again without choosing it again. Content is neither redirected to another device nor queued for later delivery.
- Folder transfers preserve their existing directory-transfer behavior. This release does not add automatic folder watching.

## 默认发送设备

设备与同步会记住上次选择的单台、多台发送模式和设备，切换页面或重启应用后仍保留。可在发送工具栏指定默认发送设备；再次打开页面时优先选中它，也可临时更换本次发送目标。

文件、文件夹、拖放和手动发送剪贴板共用当前选择的设备。发送剪贴板历史记录时也只发送给所选设备。开启自动剪贴板同步并设置默认设备后，自动同步只发送给该设备；清除默认设备后恢复原有的逐设备同步策略。

目标离线时保留选择，重新连接后可直接发送。离线期间不改发给其他设备，不积压待补发内容。本版没有新增文件夹后台监控。

## Security and release scope

- Update markdown-it to 14.3.3 for the reported parser denial-of-service fixes.
- Build the shared Go core and rendezvous binaries using Go 1.27.3, addressing GO-2026-6809. See the [official Go advisory](https://pkg.go.dev/vuln/GO-2026-6809).
- Signing keys, local device preferences, clipboard contents, vaults, credentials, machine paths and local build receipts are excluded from the public source snapshot.
- Publication requires secret scans and signed artifact integrity checks. No automated test suite or physical multi-device end-to-end test is included in this release run.
- GitHub Releases retain the latest two versions. Local obsolete application outputs and build backups are removed after new asset verification.
