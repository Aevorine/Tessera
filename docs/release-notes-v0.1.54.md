# Tessera 0.1.54

## Electron 45

- The desktop app now runs on Electron 45.2.3 (Chromium 156, Node 24.22.2), up from 41.10.7. This clears the open Electron security advisories.
- Build tools updated: undici, fast-uri, vite and minimatch are past their advisories. `npm audit` reports 0 vulnerabilities.
- Electron 44 replaced the clipboard API with an asynchronous model. Tessera's clipboard reading, writing and cross-device sync were moved to it (`electron/clipboardIO.ts`) without changing behavior:
  - Rich text keeps HTML and RTF.
  - Images from other apps are recognized.
  - Password-manager copies are still never synced.
  - Content received from another device is not sent back.
- Measured in the real Electron 45 runtime against the Windows clipboard: reads take 1.4–1.9 ms and a change check takes 0.26–1.1 ms.

## AI desktop actions ask first

- Before the AI opens an app, clicks, types, fills in a field or presses a key, Tessera shows what it wants to do and waits for you: the app or target program, the text, the key. You can choose **Allow**, **Allow all this turn** or **Deny**.
- Text the AI wants to type is shown in full, so nothing can hide past the visible part.
- Esc, closing the dialog, or 120 seconds without an answer counts as **Deny**. The AI is told the step was not approved. The chat keeps waiting while you decide.
- Reading windows and scrolling do not ask.
- The dialog appears on any screen, and the taskbar button flashes when Tessera is in the background.
- Instructions hidden in a fetched web page can no longer operate the computer on their own.

## Opening programs from the File Manager asks first

- Double-clicking a file that would run immediately asks first. This covers .exe, .bat, .cmd, .ps1, .vbs, .js, .py, .msi, .msix, .lnk, .url and similar types.
- The check is enforced in the main process, so a compromised page cannot skip it.
- Ordinary documents open as before.

## Android signing passwords out of plain text

- The Android build reads the signing passwords from environment variables. `scripts/build-release.ps1` takes them from Windows Credential Manager (encrypted for your Windows account), passes them only to that build, and clears them afterwards.
- Run `modules/file_vault/crossdevice/android/scripts/move-signing-passwords.ps1` once. It first checks with `keytool` that the passwords really open the keystore and the key, moves them from `android-keystore.properties` into Credential Manager, reads them back, and only then removes the plain-text lines. It never prints a password and stops without changing anything if a check fails.
- Until you run it, the old file-based setup keeps working.

## 中文说明

**Electron 45**：桌面端从 Electron 41.10.7 升到 45.2.3（Chromium 156、Node 24.22.2），清掉 Electron 的安全通告；构建工具 undici、fast-uri、vite、minimatch 升过修复版，`npm audit` 0 个漏洞。Electron 44 把剪贴板改成异步模型，Tessera 的剪贴板读写和跨设备同步已迁过去、行为不变：富文本保留 HTML 与 RTF，别的程序复制的图片照常识别，密码管理器复制的口令照样不同步，收到的内容不会再发回去。在真实 Electron 45 与 Windows 剪贴板上实测：读取 1.4–1.9 毫秒，变化检测 0.26–1.1 毫秒。

**AI 桌面操作先问你**：AI 要打开应用、点击、输入、填写或按键前，Tessera 会显示它要做什么（应用或目标程序、要输入的全文、按键），等你选「允许」「本轮全部允许」或「拒绝」；按 Esc、关掉对话框或 120 秒没回答都算拒绝，AI 会收到「未获允许」；你考虑期间对话一直等着。读取窗口和滚动不问。对话框在任何页面都会出现，Tessera 在后台时任务栏按钮会闪。网页里藏的指令再也不能自己操作电脑。

**文件管理器打开程序前先问**：双击会直接运行的文件（.exe、.bat、.cmd、.ps1、.vbs、.js、.py、.msi、.msix、.lnk、.url 等）先确认再运行，确认在主进程里做，页面被攻破也绕不过；普通文档照常打开。

**安卓签名口令不再明文**：安卓构建从环境变量读口令，`scripts/build-release.ps1` 从 Windows 凭据管理器取出（按你的 Windows 账户加密）、只交给这一次构建、结束即清除。运行一次 `modules/file_vault/crossdevice/android/scripts/move-signing-passwords.ps1`：先用 `keytool` 核对口令真能打开密钥库和密钥，再把 `android-keystore.properties` 里的口令移进凭据管理器、读回一致后才删掉明文行；任何一步不对就停下、什么都不改，全程不打印口令。迁移前旧配置照常可用。

## Publication scope

Rebuild and sign the Windows and Android packages (Android versionCode 55). The Go core is unchanged, so the 0.1.53 AAR is reused. The rendezvous server is unchanged, so its archives are carried over under the new version. Published after secret scans of the public tree and history and remote SHA-256 readback. GitHub Releases keep the newest two versions.

Verification covered only the new behavior:
- Clipboard round trips in the real Electron 45 runtime: text/HTML/RTF, an image placed by another program, the password-manager marker, a received image, and fingerprint changes.
- The AI confirmation path through the real backend protocol: deny means nothing runs, allow runs once, allow-all covers the rest of the turn, a timeout denies, reads do not ask, expired answers are rejected, the chat stays alive while waiting, and the full text reaches the dialog.
- The confirmation dialog in the real Electron 45 app: it appears with the details and closes on Deny.
- Signing-password precedence and Credential Manager round trips, and the migration against a throwaway keystore: wrong passwords and line continuations stop it with nothing changed; escapes and trailing spaces are stored exactly.

Not tested: the native Windows dialog for opening programs by eye (its call was checked), and a physical Android device.
