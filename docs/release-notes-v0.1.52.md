# Tessera 0.1.52

## "Backend process restarted unexpectedly" fixed

- Root cause: the encrypted clipboard, notes, activity, AI-history and speed-test databases were each shared by several threads (clipboard listener, maintenance, batch tasks, requests from the window) without a lock. Concurrent use corrupted the SQLite statement state and eventually the process heap (Windows exception 0xc0000374), so the backend crashed and the vault had to be unlocked again. Every connection is now serialized, and each storage operation runs atomically.
- A single response that cannot be encoded (for example a lone UTF-16 surrogate from the clipboard or a file name) no longer ends the backend's main loop; only that request fails.
- If the backend ever exits unexpectedly again, the exit code, uptime and the Python stack of every thread are written to `logs/backend-exits.jsonl` in the application data folder, and the tray no longer offers "Lock vault" for a vault that is already locked.

## Devices & sync: sub-second recovery

- When a paired device reconnects over a new path (Wi-Fi change, wake from sleep, app restart), the old dead connection is replaced immediately. Previously the simultaneous-dial rule could keep the dead connection and refuse the new one until the heartbeat timed out (measured 36.5 s → 4.3 ms).
- Every clipboard send is followed by a liveness check with an RTT-adaptive timeout (700 ms – 3 s). A silent link is dropped and redialed at once, and the latest copy is resent on the new connection (copy during an outage: delivered 0.7 s after the link returns, previously 2.2 s; status no longer shows Connected while nothing gets through).
- Idle dead-link detection after the second missed heartbeat: 32 s → 20 s. Network-change probes use the same adaptive timeout instead of a fixed 4 s.
- Measured with two real nodes over loopback through a packet-dropping relay; connection setup (≈10 ms) and clipboard delivery (p95 ≈0.6 ms) are unchanged.

## 修复「后端进程意外重启，请重新解锁」

根因：剪贴板、笔记、操作记录、AI 对话、测速五个加密数据库的连接被剪贴板监听、定时维护、批量任务和界面请求等多个线程同时使用且没有加锁，并发访问会打乱 SQLite 语句状态，最终损坏进程堆（Windows 异常 0xc0000374），后端崩溃后只能重新解锁。现在每个连接的访问都串行化，每次存储操作整段原子执行。

单条无法编码的响应（例如剪贴板或文件名里的孤立 UTF-16 代理字符）不再让后端主循环退出，只让这一条请求失败。今后若后端再意外退出，退出码、存活时长和各线程 Python 调用栈会写入应用数据目录下的 `logs/backend-exits.jsonl`；托盘也不再对已锁定的金库显示「锁定金库」。

## 设备与同步：一秒内恢复

已配对设备换网、休眠唤醒或重启应用后从新路径重连时，立即替换失效的旧连接；此前互拨规则可能保留失效连接、拒绝新连接，直到心跳超时（实测 36.5 秒 → 4.3 毫秒）。每次发送剪贴板后按往返时间自适应（700 毫秒至 3 秒）确认链路，连不通立即换路重连并在新连接上补发最新内容（断线期间复制的内容在链路恢复后 0.7 秒送达，此前 2.2 秒），连不通时不再显示「已连接」。空闲时失效链路检测从 32 秒缩短到 20 秒。连接建立（约 10 毫秒）与剪贴板送达（p95 约 0.6 毫秒）不变。

## Security

DOMPurify 3.4.16 → 3.4.17 (critical advisories GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f). Tessera's only use, the clipboard rich-text preview, does not enable the affected SAFE_FOR_TEMPLATES, IN_PLACE or xhtml parser modes, so it was not exploitable; the patch is applied anyway. Electron's open advisories are fixed only in a later major version and remain for a separate upgrade.

DOMPurify 升级到 3.4.17（修复三条严重级通告）。Tessera 只在剪贴板富文本预览里使用它，且未启用受影响的 SAFE_FOR_TEMPLATES、IN_PLACE 或 xhtml 解析模式，原本不可利用，仍按补丁升级。Electron 的未决通告只在更高的大版本中修复，留待单独升级。

## Publication scope

Rebuild and sign Windows and Android packages (Android versionCode 53, Go core rebuilt). The rendezvous server code is unchanged; its archives are carried over under the new version. Published after public-tree and history secret scans and remote asset SHA-256 readback. Signing material, device identities, vaults and clipboard contents remain excluded.

Verification for this release covered only the new behavior: the real clipboard storage under four concurrent threads (0 errors, previously 315 in 6 s), the real backend process surviving a lone-surrogate response, and the cross-device latency scenarios above. No full test suite and no physical Android device test were run. GitHub Releases retain the newest two versions.
