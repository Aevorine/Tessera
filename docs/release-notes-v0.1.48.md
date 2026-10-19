# Tessera 0.1.48

## Find things faster

- **Ctrl+F or / jumps to search.** On passwords, recovery codes, clipboard history and Devices & sync the shortcut focuses the search box of the page you are on (or of the open panel), and selects what is already typed.
- **Pick results from the keyboard.** While the cursor stays in the search box, ↑ ↓ move the current result and the list scrolls to it; Enter opens the first match. In clipboard history Enter copies the current result, so type → Enter is enough to get it back.
- **One search for Devices & sync.** A search box on the main page looks through devices (name, state, type, link), transfers (file, device, status), clipboard sync history and the functions themselves. Results are grouped, highlighted, and open the matching panel: a device opens with that device selected, a transfer opens the transfer list filtered to that file.
- **Recovery codes open the first match.** The list view selects the first matching service instead of an empty detail pane.
- **Passwords search fills the list column.**
- **Clipboard history times.** Rows show short local times (time today, month-day otherwise); the detail shows the full date and time.
- **Toolbars never clip.** When the toolbar of clipboard history, notes, recovery codes or encryption runs out of room, menus first drop their current value and then collapse to icons; hovering an icon shows its name and value.

## 查找更快

Ctrl+F 或 / 直接进入当前页（或已打开面板）的搜索框；在搜索框里用 ↑ ↓ 切换结果，Enter 打开第一条，历史记录里 Enter 直接复制。设备与同步主页新增一个搜索框，同时查设备、传输记录、同步记录与功能，结果分组高亮，点击直达对应面板。恢复码列表自动打开第一条匹配；密码页搜索框占满列宽；历史记录显示简短本地时间；工具栏放不下时先省略当前值、再收成图标，悬停显示名称。

The Android companion is rebuilt with the version bump; its behavior is unchanged from 0.1.47. Rendezvous binaries are unchanged and reused from 0.1.47.

Type checks, lint and an end-to-end run of the four search pages in the real app passed; no other tests were run for this release.
