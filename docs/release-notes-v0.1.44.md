# Tessera 0.1.44

## File shortcuts switch on reliably

- Fixes “PermissionError: [WinError 5] Access is denied” when enabling the system-wide file shortcuts. While deploying the helper, a security scanner or the search indexer could briefly hold a handle on the freshly copied `hook_agent.exe`, so the staging-directory rename was refused. Deployment now retries with backoff. If the rename keeps failing, the files are copied into place one by one, with the two key files written last. Each attempt uses a unique staging folder.

## Paste progress shows the right numbers

- In-app file manager: the dialog showed byte counts as an item count, could show a negative remaining time, and had two bars. It now shows files done/total, size done/total, current speed (2-second window), elapsed time, remaining time and the current file, with a single bar.
- Task card and dialog: while totals are still being counted, the bar and remaining time are suppressed (`1,234/5,678+`). Speed excludes scanning time. Mixed moves (some same-drive renames, some cross-drive copies) follow the bytes being copied and no longer jump to 100% early. Cross-drive moves show “Cleaning up source…” while the originals are removed.
- Partially copied bytes are rolled back when a file fails or is cancelled. Alternate data streams (for example `Zone.Identifier`) no longer inflate the count.

## Faster paste

- Scanning and copying run as a pipeline: copying starts as soon as the first files are found instead of after the whole tree has been listed.
- Thread count adapts to the drive: SSD and network transfers use up to 32 threads; when either side is a hard disk, 4 threads are used and large files are copied one at a time to avoid head seeking.
- Each file is verified with one `GetFileAttributesExW` call instead of a full open, and progress callbacks start at 4 MB. Cross-drive moves remove the originals in parallel.

## 系统级文件快捷键与粘贴

修复开启系统级文件快捷键时报「拒绝访问」（WinError 5）：部署钩子时杀毒软件或索引器短暂占用新文件，导致目录改名被拒。现在先退避重试，仍失败则逐文件复制到位。应用内粘贴进度改为显示文件数、大小、速度、已用与剩余时间；统计总量期间不显示百分比。粘贴改为边扫描边复制，并按固态盘/机械盘自动调节线程数，跨盘移动并行删除源文件。

The Android companion is rebuilt with the version bump; its behavior is unchanged. Rendezvous binaries are unchanged and reused from 0.1.43.

Only the file-operation unit tests were run. Real-device end-to-end checks were not run.
