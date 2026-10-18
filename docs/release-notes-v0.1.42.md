# Tessera 0.1.42

## Received files within reach

- Windows: open the current received-files folder from Devices & sync, the save-location row, or the receive-complete notification.
- Android phones and tablets: open the save folder beside its location. If a file manager cannot open it, browse received files in a full-screen in-app view; tap to open and hold to share.
- Folder paths come from the current service settings. File enumeration runs off the Android UI thread; Windows folder creation uses asynchronous I/O.
- Icon buttons with accessible labels show their names on hover. Existing feature tiles, full-screen panels, unified Song/Times typography, colors and sync behavior are retained.

## 收件文件夹直达

- 电脑端：在「设备与同步」主页、接收保存位置及接收完成通知中打开文件夹。
- 手机和平板端：保存位置旁新增文件夹按钮；系统无法打开目录时，全屏显示应用内文件列表，点击打开、长按分享。
- 沿用现有统一配色、宋体与 Times New Roman 字体、主功能卡片和全屏次功能面板。

Built without running test suites or device end-to-end checks. Build and signing results do not establish real-device behavior.

The rendezvous server is unchanged; its three binary archives reuse the 0.1.41 binaries under the 0.1.42 asset names.
