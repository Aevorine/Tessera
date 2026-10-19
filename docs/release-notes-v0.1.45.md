# Tessera 0.1.45

## Explorer task card matches the app typography

- The card shown by the global `Ctrl+V`, `Delete` and `Shift+Delete` hooks now uses SimSun for Chinese text and Times New Roman for Latin letters, digits and punctuation, at 12 pt (小四). The **Cancel** and **Close** buttons use the same size.
- The card is wider (440 px at 100% scaling) and its height is computed from the actual font line height and screen DPI. Five body lines (file, progress, size, remaining time) fit in the full card and two in the compact card, so text is not clipped at 125% or 150% scaling.
- Progress content and behavior from 0.1.44 are unchanged.

## 任务卡片字体统一

资源管理器里粘贴、删除时弹出的任务卡片改为中文宋体、英文数字与标点 Times New Roman、小四字号，与应用其它界面一致；卡片按实际字体行高与屏幕缩放计算尺寸，高缩放下不截字。

The Android companion is rebuilt with the version bump; its behavior is unchanged. Rendezvous binaries are unchanged and reused from 0.1.44.

Only the task-card unit tests were run. Real-device end-to-end checks were not run.
