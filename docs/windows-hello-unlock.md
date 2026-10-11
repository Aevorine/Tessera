# Windows Hello 解锁 — 模态、超时分层与取消协议

> 记录的是**已实现的行为**，不是提案。改 `modules/file_vault/c/fingerprint_verify.c`
> 或 `fingerprint.py` 的进程管理时，这份文件要跟着改。
>
> 起因是一个「登录页彻底卡死」的故障：提示「指纹验证超时」，但页面上什么都点不动
> ——既点不了「重新用 Windows Hello 解锁」，也切不到其他解锁方式。

## 一、必须先知道的一件事：验证期间应用窗口是被系统禁用的

`IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, …)` 的语义是
**对那个 hwnd 模态**。凭据 broker 会在验证期间禁用该窗口——实测 `IsWindowEnabled(hwnd)`
返回 `False`，界面上任何东西都收不到点击。

这本身是正常且符合预期的（Chrome 的 WebAuthn 也一样）。但它有两个直接推论，写代码时
必须记住：

1. **界面上画的「取消」按钮不是模态期间的逃生门。** 它和登录页在同一个被禁用的窗口
   里，那时候点不到。真正的逃生门是下面的「自动尝试用短预算」。
2. **凭据界面没有正常收场时，窗口会被留在禁用态。** 这就是故障的后半段。

## 二、根因（A/B 实测）

同一个宿主窗口、同样不去碰传感器：

| | 旧版 | 现版 |
|---|---|---|
| 25 秒内自己结束 | **否** | 是（8 秒截止，8.0 s 退出） |
| 验证期间宿主窗口 | `enabled=False` | `enabled=False`（模态，正常） |
| **进程结束后宿主窗口** | **`False` — 永久禁用** | `True` — 恢复 |

三条叠加成了用户看到的现象：

**① 辅助程序是一个不泵消息的 STA。** `RoInitialize(RO_INIT_SINGLETHREADED)` 进了
单线程套间，然后用 `Sleep(100)` 轮询 `get_Status`，全程不派发消息。STA 不 dispatch
就服务不了 broker 的跨套间回调，于是状态永远停在 `Started`，验证永远不完成。

**② 辅助程序是被强杀的。** 原来 Python 侧用 `subprocess.run(timeout=120)`，到点直接
终止进程。broker 没有机会撤销模态，宿主窗口保持禁用——**而且不会自己恢复**。

**③ 没有取消通道。** 单飞槽位在整个 120 秒里锁着，任何重试只会拿到
`auth.fingerprint_verification_in_progress`；那把锁没有超时、没有任何 RPC 能撤销。

顺带一提，`IAsyncInfo::Cancel()` 本身**会永久阻塞**（探针实测：`Cancel() entering`
之后再没有 `returned`）。它是一次跨套间调用，而 broker 可能需要我们的 STA 先 dispatch
才肯回答——一个正阻塞在出站调用里的 STA 不 dispatch。所以 `Cancel()` 必须发到工作
线程上，主线程继续泵消息。

## 三、辅助程序协议

```
fingerprint_verify.exe <hwnd_hex> [--timeout-ms=N]     验证
fingerprint_verify.exe --modalities                    枚举传感器
```

- **提示语**：验证模式下从 stdin 读第一行（UTF-8）。走 stdin 而不是 argv，是为了
  避开 Windows argv 的中文编码问题。
- **取消通道**：提示语之后 stdin 保持打开。写一行 `CANCEL`，**或者直接关闭管道
  （EOF）**，都表示撤销。EOF 也算取消是有意的：父进程都没了，没人接收结果，而把一个
  模态凭据框留在一个孤儿窗口上是最坏的结果。
  - 推论：**调用方在验证结束前绝不能关 stdin。** 这正是不能再用
    `subprocess.run(input=…)` 的原因——它写完立刻关管道。
- **stdout / 退出码**：`Verified`(0) / `Canceled`(1) / `Error: <detail>`(2)。
- 辅助程序**自带截止时间**，到点自己 `Cancel()` + `Release` + `RoUninitialize` 后
  正常退出，不再等着被父进程杀。

两个实现上的坑，都留了注释在源码里：

- stdin 走**原始句柄**（`ReadFile`）而不是 CRT 的 `stdin`。监听线程会在读上阻塞整个
  验证过程，而阻塞在 CRT 流里的线程持有该流的锁；`main()` 返回时 `exit()` 的流清理
  要拿同一把锁，进程于是永远退不出。实测过：所有收尾步骤在 4313 ms 全部打完，
  `return exitCode` 也到了，进程就是不退。
- 收尾用 `ExitProcess` 而不是 `return`：监听线程可能还停在一个永远等不到下一个字节的
  `ReadFile` 上，而该写的东西都已经 flush 过了。

## 四、超时分层

**必须严格递增**，只有最内层先到点，错误码才指向真正的原因。旧代码只有两层
（Python 120 s、桥接层 180 s），辅助程序自己没有截止时间，于是每一次失败都长得
一模一样：「Python 把它杀了」——既分不清是用户没碰传感器还是验证框根本没弹出来，
又恰好是把窗口留在禁用态的那条路径。

| 层 | 预算 | 说明 |
|---|---|---|
| 辅助程序自己 | 手动 **90 s** / 登录页自动 **25 s** | 自行 Cancel + 正常退出，窗口一定被恢复 |
| `fingerprint.py` 的 `proc.wait()` | 上一层 + 5 s | 仅当辅助程序连自己的截止都没兑现时才强杀 |
| `pythonBridge.ts` 静默超时 | 180 s | 见 `SILENT_TIMEOUT_OVERRIDES` |

**为什么自动尝试要单独给一个短得多的预算**：登录页挂载即自动发起一次验证，而验证
期间整个窗口是禁用的——这意味着每次打开应用都先把登录页锁住一次。提示框万一没浮到
最前面（多显示器、远程桌面、前台被别的窗口抢走），用户面对的就是一个彻底点不动的
页面。25 秒之后自动放行并落到密码，代价从两分钟降到二十几秒。

预算由渲染进程通过 `unlock_fingerprint` 的 `timeout_seconds` 传入，后端夹取到
`[5, 90]`，看不懂的输入回落默认值（**不是**「不限时」）。两个方向都要夹住：太大等于
把窗口锁得比后端上限还久；0 或负数等于验证框刚弹出来就被撤掉，用户永远验不成。

## 五、取消与自愈

| 机制 | 值 / 行为 |
|---|---|
| `unlock_fingerprint_cancel` RPC | 同步、毫秒级；不要求已解锁或已建库（登录页和首次运行向导都要能调） |
| 协商取消 | 往辅助程序 stdin 写 `CANCEL`；**实测端到端 141 ms** |
| Python 侧协商宽限 | 4 s，超时才强杀（那条路径可能留下禁用窗口） |
| 辅助程序侧取消宽限 | 2 s（等状态变成终态） |
| 消息泵轮询 | 50 ms |
| 单飞槽位自愈阈值 | 105 s（= 90 + 5 + 10） |
| `release_verification_slot()` | **幂等**，重复调用或槽位已被回收都是静默无操作 |

槽位改成自愈是因为它在 stdin 线程上抢、在批处理线程上放：任何一条没走到 `finally`
的路径都会让它永久锁住，之后每一次「重新用 Windows Hello 解锁」都只会拿到一个用户
既看不懂、也无论如何都消不掉的错误，只能重启应用。

Electron 主进程在每次指纹相关 RPC 结束后无条件调用 `win.setEnabled(true)` +
`win.focus()`。正常情况下这是纯粹的无操作；它存在是为了那些没能正常收场的情况——
而能调 `EnableWindow` 的只有主进程，从渲染进程那一侧无论如何都救不回来。

## 六、构建

`fingerprint_verify.exe` 被 `.gitignore` 的 `*.exe` 挡在仓库外，由
`ui/scripts/build-file-hook.mjs` 在 `prebuild` 阶段按 mtime 决定是否重编。

**`-mwindows` 不能少**：少了它 gcc 会链接成控制台子系统程序，Windows 于是给它分配
一个控制台窗口——表现为验指纹时闪出一个黑框。判据不是「看不看得见窗口」，而是产物的
PE 子系统必须是 `WINDOWS_GUI(2)`：

```powershell
$b=[IO.File]::ReadAllBytes($exe); $pe=[BitConverter]::ToInt32($b,0x3C)
[BitConverter]::ToUInt16($b,$pe+0x5C)   # 2=GUI 3=CUI
```

Python 侧另外还带 `CREATE_NO_WINDOW`，兜的是「用户机器上躺着一个旧的 CUI 版 exe」。

## 七、相关代码

| 位置 | 职责 |
|---|---|
| `modules/file_vault/c/fingerprint_verify.c` | 消息泵、自带截止、取消协议、模态收尾 |
| `modules/file_vault/fingerprint.py` | 进程管理、三层预算、自愈槽位、`cancel_active_verification()` |
| `modules/file_vault/backend_server.py` | `unlock_fingerprint` / `unlock_fingerprint_cancel` |
| `modules/file_vault/ui/electron/main.ts` | hwnd 注入、`setEnabled(true)` 兜底 |
| `modules/file_vault/ui/src/components/UnlockTabs.tsx` | 自动尝试的短预算、超时后自动落到密码 |
| `modules/file_vault/tests/test_fingerprint.py` | 契约用例（假 Popen） |
| `modules/file_vault/ui/tests/unlockFactorBusyState.test.mjs` | 界面不变量 |

真机验证（需要真实 Hello 硬件、会弹系统提示框）不进测试集——CI 上一样都没有。
