# Tessera 0.1.46

## Notes: import files and folders that stay on disk

- **Folder import works again.** The file list in the folder-import dialog stayed blank because its scroll container mounted after scanning finished, so the virtualized list never measured it; the confirm button was also pushed out of view. The list now renders every file (with its subfolder) and the confirm button is always visible.
- **Import button next to New note.** Import files, import a folder and the import mode are one click away, not only inside the Actions menu.
- **Open the original file (default).** An imported `.txt`/`.md` file is no longer copied: the note is the file. Saving writes back to the same location, keeping the file's encoding (UTF-8, UTF-8 with BOM or GBK) and line endings (CRLF or LF), through a temporary file in the same folder that replaces the original. Renaming the note renames the file. Edits made in another editor are picked up and recorded in the note's timeline as "Changed outside".
- **Linked folders.** Linking a folder adds all its text and Markdown files, sorted into categories by subfolder. Files added to the folder later appear automatically when the window regains focus and every minute while it is in front; files changed outside are refreshed, and files deleted outside move the note to the recycle bin. A new note created in a linked folder's category is written as a file in that folder. Permanently deleting a note from a linked folder sends its file to the Windows Recycle Bin; unlinking a folder keeps the existing notes.
- **Copy mode is still available.** Import → Import mode → Copy into the notes library keeps the previous behavior (encrypted copy, original file untouched). Files over 8 MB are always copied, because linked notes are edited as a whole.

## 笔记：导入文件与文件夹

修复「从文件夹导入」弹窗文件列表空白、确认按钮被挤出视野的问题；「新建笔记」旁新增「导入」按钮。导入默认改为「打开原文件」：笔记就是本地文件，保存后原位置的文件同步更新，编码与换行保持不变；可关联整个文件夹，之后新增的文件自动出现并按子文件夹分类。可切换回「复制到笔记库（加密保存）」。

The Android companion is rebuilt with the version bump; its behavior is unchanged. Rendezvous binaries are unchanged and reused from 0.1.45.

The existing notes and backend test suites (314 tests) and an end-to-end run of the import flows in the real app (16 checks) passed.
