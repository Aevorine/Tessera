# Tessera 0.1.53

## System-level file shortcuts stay on after a restart

- Root cause: the File Manager's engine **Stop** button and the **File** menu checkbox both called the same "disable" path as the Settings switch, so stopping the engine also deleted its Windows startup entry. The Settings switch also defaulted to Off whenever the status query failed or was slow, and a second backend (development or the command-line agent) could rewrite or stop the installed engine's registration.
- Now: Stop/Start only stops or starts the engine; only the Settings switch adds or removes the startup entry. The choice is stored separately, and if the startup entry disappears (cleanup tools, registry restore), the next launch restores it and starts the engine. If startup is turned off in Task Manager › Startup apps, Settings says so and offers **Turn back on** instead of silently showing Off. A source-mode backend never touches the installed app's registration. The menu checkbox now reflects the real engine state at launch.

## File Manager

- The engine status and its Start/Stop button sit on the same row as **Collapse navigation**, **Collapse file actions** and **Show text labels**.
- Drag and drop: drag rows onto a folder or onto the list to move them (same drive) or copy them (different drive; hold Ctrl to copy, Shift to move), drag rows out to Explorer or the desktop, and drop files in from Explorer. A folder cannot be dropped into itself; copying into the same folder creates a renamed copy and never offers to overwrite the original.
- Copy/Cut/Paste in the search or rename box now edit text instead of copying the selected files.
- **Undo** is enabled only when the last operation can actually be undone.

## Devices & sync: file sending no longer "sometimes fails"

- Root cause: a send was bound to one connection. If that connection dropped or was replaced mid-transfer (phone sleep, network change, the 0.1.52 fast reconnect), the whole batch failed, and a device that was reconnecting at the moment you clicked Send was silently skipped.
- Now each file waits up to 2 minutes for the device to come online and resumes from the received chunks on the new connection (up to 6 attempts). Rejections and cancellations are not retried. Measured over a throttled relay: 12 MiB dropped mid-transfer still arrived intact; a send started while the device was reconnecting completed in about 30 ms. Progress shows "Waiting for … to come online" or "Connection dropped — resuming (attempt n)".
- A dead link is noticed while idle in about 2 s between PCs (previously 17–20 s; with phones an estimated 6.4 s at most, because phones send heartbeats every 5 s to save battery — not measured on a device). It is announced at once with the reason, and the same notice turns into "Reconnected" when the link comes back. Slow links during large transfers are not dropped by mistake.

## Logs Claude Code can read

- A unified structured log (`%APPDATA%\file-vault-ui\logs\tessera-YYYY-MM-DD.jsonl`, kept for 14 days) records backend crashes and restarts, dead links with their cause, file transfer retries and results, shortcut-engine startup checks, update results, power events and interface errors.
- Query it without unlocking: `tessera logs --summary --since 1d`, or filter by time, component, level, event and regex. The read-only MCP tool `tessera_logs` exposes the same queries. See `docs/logging.md`.
- Privacy: no clipboard text, file contents, passwords or keys are written. Paths keep only the extension, and the Windows user name and computer name are replaced with placeholders. Devices are recorded by an 8-character ID prefix. The log stays on this PC.

## Other fixes

- Security Health now counts paired devices correctly (it always reported 0).
- The tray **Send clipboard** item reports how many devices received it, or why nothing was sent.
- Pausing clipboard capture from the tray while locked takes effect after unlock; tray and menu navigation requested while locked opens after unlock.
- Missing translations for shortcut-engine status, PC-cleanup error codes and the new messages were added in all six languages.
- Sending many files to a device that stays offline no longer waits two minutes per file: once one file times out, the rest of the batch is reported at once.

## 中文说明

**系统级文件快捷键开机自启动重启后变「关」已修复。** 根因：文件管理器里的「停用」按钮和「文件」菜单勾选与设置页开关走同一条「关闭」路径，停一下引擎就把开机启动项一起删了；设置页在状态查询失败或变慢时默认显示「关」；开发版或命令行后端还会改写、停掉安装版的登记。现在停用/启用只启停引擎，只有设置页开关增删启动项；你的选择单独保存，启动项被清理工具删掉后下次启动自动恢复并拉起引擎；在任务管理器「启动应用」里被禁用时，设置页如实说明并提供「重新启用」。

**文件管理器**：引擎状态和启停按钮与「收起：导航 / 收起：文件操作 / 显示文字标签」同一行；支持拖放——行拖到文件夹或列表上，同盘移动、跨盘复制（Ctrl 复制、Shift 移动），可拖出到资源管理器和桌面，也可从资源管理器拖进来；文件夹不能放进自己，拖回原文件夹复制时自动改名、不会提供覆盖原件；搜索框/改名框里的复制粘贴恢复为文本编辑；「撤销」只在真能撤销时可点。

**设备与同步发文件时好时坏已修复。** 根因：一次发送绑定在一条连接上，连接中途断开或被替换（手机休眠、换网、0.1.52 的快速接管）整批失败，点发送时恰好在重连的设备被静默跳过。现在每个文件最多等对端上线 2 分钟，并在新连接上从已收分块续传（最多 6 次）；被拒绝或取消的不重试。实测：12 MiB 传到一半断开仍完整送达；点发送时对端在重连，约 30 毫秒内完成。空闲时失效链路电脑之间约 2 秒被发现（此前 17–20 秒；手机为省电每 5 秒心跳，按算法估计最多约 6.4 秒，未在真机实测），发现即提示原因，恢复后同一条提示变为「已重新连上」。

**日志**：新增统一结构化日志（应用数据目录 `logs\tessera-日期.jsonl`，保留 14 天），记录后端崩溃与重启、断链原因、文件传输重试与结果、快捷键引擎对账、更新结果、电源事件和界面异常；`tessera logs --summary` 或 MCP 工具 `tessera_logs` 不解锁即可查询，详见 `docs/logging.md`。不记剪贴板正文、文件内容、密码和密钥，路径只留扩展名，用户名与计算机名换成占位符，只存本机。

**其他**：安全体检的已配对设备数恢复正确（此前恒为 0）；托盘「发送剪贴板」会提示发到了几台或为什么没发；锁定时在托盘点的暂停与跳转在解锁后生效；补齐六种语言缺失的文案；给一直不在线的设备发一批文件，不再每个文件各等两分钟，第一个超时后其余立即报告。

**安全加固**：AI 桌面操作在后端硬拦命令行、脚本宿主、注册表编辑器和 Tessera 自身（网页里藏的指令无法让它打开终端敲命令）；剪贴板富文本预览只保留内嵌图片和普通链接，防止 `//主机` 图片让 Windows 向外部共享发送登录哈希；防火墙提权与快捷键助手的扫描器改用 System32 绝对路径；从别的设备收到的文件带「来自网络」标记，打开时照常有 SmartScreen / 受保护视图提示；日志脱敏扩展到 MSYS / 安卓路径、配对设备名、邮箱和公网地址，搜索改为子串匹配，并有每日写入上限；开机启动项被恢复时弹系统通知，不再悄悄改回。

## Security

An independent audit covered the signing material (compared by hash only, never opened), the public tree, the full git history, both GitHub repositories and the new code. No key material, personal path or secret is in anything published. Hardening applied in this release:

- **AI desktop control:** Tessera refuses to launch command-line hosts, script hosts, the Registry Editor or Tessera itself, and refuses clicks, typing and key presses in their windows. This is enforced in the backend, not only in the prompt, so instructions hidden in a fetched web page cannot open a terminal and run commands.
- **Clipboard rich-text preview:** the preview keeps only embedded `data:` images and http(s)/mailto links. Under `file://`, a `//host/x` image or CSS `url()` would otherwise make Windows authenticate to a remote share and send the login hash.
- **Firewall elevation:** the firewall rule elevation runs `netsh` and PowerShell from System32 by absolute path, not from `PATH`. So does the file-shortcut helper's optional UI scanner.
- **Received files:** files received from other devices are marked as coming from the Internet (Mark-of-the-Web), so Windows shows the usual SmartScreen or Protected View warning when you open them.
- **Logs:** redaction covers MSYS and Android paths, paired-device names, email addresses and public IP addresses. Unparsable process output is recorded only as a length and hash, and text sent by another device is shortened and stripped of control characters. Log search uses substring matching, so a crafted pattern cannot hang the MCP server. A daily size budget applies.
- **Drag-out:** dragging out rejects network and device paths. Dropping a symbolic link back into its own folder cannot overwrite the original.
- **Restored startup entry:** when the file-shortcut startup entry is restored, a system notification says so, so a restore never happens silently.

Not changed in this release:
- Electron's open advisories need a major-version upgrade and remain a separate release.
- Protection rules for the repositories and the signing-key folder are left to the owner.

## Publication scope

Rebuild and sign Windows and Android packages (Android versionCode 54, Go core rebuilt). The rendezvous server code is unchanged; its archives are carried over under the new version. Published after public-tree and history secret scans and remote asset SHA-256 readback. Signing material, device identities, vaults and clipboard contents remain excluded.

Verification for this release covered only the new behavior: Go two-node probes for interrupted and reconnecting sends and idle dead-link detection, the real file-transfer service for drag-and-drop moves, copies and guards, and the log writer → `tessera logs` / `tessera_logs` pipeline including redaction. The in-app drag gestures, the reboot autostart path and a physical Android device were not tested end to end. GitHub Releases retain the newest two versions.
