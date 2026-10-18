# Tessera 0.1.43

## Clipboard history: copy and preview together

- Click a desktop history entry to copy its stored content and immediately show it in the right pane. Works for both pinned and virtualized history lists.
- Image thumbnails follow the same action; the full-size image viewer remains available from the detail pane.
- Enter and Space activate a focused history row. Nested controls retain their own keyboard behavior.
- The row action copies without switching to the previous app. The explicit Paste action retains its existing behavior.
- Existing text, HTML/RTF and image clipboard handling is reused. Copy failures are reported without discarding the selected preview.
- Unified typography, colors, full-height workbench, snippets, selection and trash actions are preserved.

## 历史记录：单击复制并预览

点击电脑端历史记录的文字或图片，在复制内容的同时更新右侧详情；置顶列表与普通列表行为一致。右侧保留显式「粘贴」和原图查看入口，勾选、菜单及回收站操作保持原有行为。

The Android companion is rebuilt with the version bump; its behavior is unchanged. Rendezvous binaries are unchanged and reused from 0.1.42.

No test suites or real-device end-to-end checks were run. Build and signature checks do not establish user-path behavior.
