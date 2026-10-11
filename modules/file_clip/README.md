# file_clip — 高性能文件复制/剪切/粘贴

与 Windows 系统剪贴板完全互通：资源管理器里 Ctrl+C / Ctrl+X 的文件，用本模块高速粘贴；
本模块 copy/cut 的文件，资源管理器里 Ctrl+V 也能贴出来。

## 用法（从项目根目录）

```powershell
python -X utf8 modules/file_clip/cli.py copy <路径...>     # 复制到剪贴板（=Ctrl+C）
python -X utf8 modules/file_clip/cli.py cut <路径...>      # 剪切到剪贴板（=Ctrl+X）
python -X utf8 modules/file_clip/cli.py paste <目标目录>    # 高速粘贴（=Ctrl+V）
python -X utf8 modules/file_clip/cli.py status             # 看剪贴板上有什么
python -X utf8 scripts/run.py run file_clip                # 同 status
```

paste 选项：

- `--on-conflict rename|skip|overwrite`：重名处理，默认 rename（自动改名保留两者，
  生成「名字 (2)」，与资源管理器"保留两者"一致）。
- `--threads N`：并行线程数，默认自动（CPU 核数×2，上限 16）。

## 删除

```powershell
python -X utf8 modules/file_clip/cli.py delete <路径...> --yes       # 高速永久删除
python -X utf8 modules/file_clip/cli.py delete <路径...> --recycle    # 删到回收站（可恢复）
python -X utf8 modules/file_clip/cli.py delete <路径...> --gui        # 弹进度小窗（永久删除先弹确认）
```

- 永久删除：多线程并行 `DeleteFileW` + 自底向上清目录，快；不可恢复，故 CLI 需 `--yes`、GUI 先弹红色确认框。
- 回收站删除：整批交给系统 `SHFileOperation`，可恢复，但系统本身有固定开销，明显慢于永久删除（详见「性能设计」一节）。
- 实测（本机，1 万个 4KB 文件永久删除）：**3.7s（2733 文件/秒）** vs Remove-Item 9.0s、cmd rd 4.1s。

## 后台热键版（在资源管理器里直接按 Ctrl+V）——C 版钩子

```powershell
python -X utf8 modules/file_clip/setup_integration.py start   # 启动 C 钩子代理（无窗口）
python -X utf8 modules/file_clip/setup_integration.py stop    # 停止
```

键盘钩子用 **C 编写**（`c/hook_agent.c`，gcc 编译）：低级键盘钩子会让全系统每次按键都经过
本进程，早期 Python 版会因 GIL/GC/控制台暂停把系统按键卡住（资源管理器未响应）——C 版
回调是微秒级纯 Win32、无控制台窗口，从根上消除卡顿。

启动后在资源管理器/桌面按 Ctrl+V，由高速引擎接管；操作在 0.3 秒内就做完（绝大多数
情况——单文件/小批量通常几毫秒到几十毫秒）**完全不弹窗**，静默完成，跟原生一样"瞬间搞定"
的感觉；超过 0.3 秒还没完（大文件/海量小文件）才弹**进度小窗**，实时显示 MB/s，成功停留
1.2 秒展示最终速度后自动关，出错或取消不管多快都会弹窗保持打开（错误不能因为快就被吞掉）。
Ctrl+C/Ctrl+X 照常用系统的。右键菜单粘贴/删除同样走这条路径（pythonw 启动，无黑框）。
命令行想看小窗加 `--gui`。

同一个 C 钩子还接管资源管理器文件列表里的**删除键**：

- **Delete** → 高速删到回收站（可恢复）；
- **Shift+Delete** → 高速永久删除（先弹红色确认框）。

只在真正的资源管理器窗口（CabinetWClass/ExploreWClass）+ 焦点在文件列表区时接管；桌面、
重命名框、地址栏、搜索框里按 Delete 一律放行（删字符 / 走系统）。接管后由
`cli.py delete-selection <hwnd>` 用 COM 取当前选中项再高速删除，弹删除进度小窗。

### 右键菜单第一层可见（可选，默认不开）

Win11 默认把第三方右键菜单项折进「显示更多选项」里，本模块的菜单项要点开才看得到。
默认**不改**这个行为（保留 Win11 原生右键菜单，不打扰）；想让「高速粘贴/高速删除」在
第一层直接可见，手动执行：

```powershell
python -X utf8 modules/file_clip/setup_integration.py menu-classic-on   # 切经典菜单
python -X utf8 modules/file_clip/setup_integration.py menu-classic-off  # 恢复 Win11 默认
```

原理：写一个空 CLSID 键（`{86ca1aa0-...}\InprocServer32`，只 HKCU）切回 Win10 经典
右键菜单。切换需重启一次资源管理器生效（两个命令都会自动重启，已打开的文件夹窗口会重开）。

### 原生工具栏 + 右键菜单图标行的「粘贴/删除」按钮（默认开启）

资源管理器工具栏、以及 Win11 右键菜单顶部图标行上的「粘贴」「删除」原生按钮，
**没有官方接口可以安全替换**——要做到"点它就走高速引擎"，做法是：一个常驻的 PowerShell
子进程（`c/ui_scan_agent.ps1`）用 UI Automation 周期性扫描当前前台资源管理器窗口
（以及弹出的右键菜单），把"粘贴/删除"按钮的屏幕坐标写进一个临时文件；C 钩子
（`WH_MOUSE_LL`）每 150ms 读一次这份坐标缓存，鼠标左键按下时只做「坐标是否落在缓存矩形
里」这种最轻量的判断——不在钩子回调里做任何 UIA/COM 调用（那些调用可能要几十上百毫秒，
放进钩子会拖慢全系统鼠标响应，这是绝对不能碰的红线）。命中后还会用 `IsWindow` + 窗口
类名兜底校验一次，防止缓存过期后误吞到不相关的点击（比如窗口已经关了）。命中就吞掉点击、
拉起跟 Delete 键/Ctrl+V 一样的高速引擎；不命中一律放行给系统原生处理。

鼠标点删除按钮固定按「回收站」语义（可恢复，跟 Delete 键一致）；按住 Shift 点删除按钮
才走永久删除，和原生 Explorer 的 Shift 语义保持一致。

不往 explorer.exe 注入任何代码（那是之前 Python 全局键盘钩子的做法，会导致未响应/崩溃，
坚决不用）。

**开关**：

```powershell
python -X utf8 modules/file_clip/setup_integration.py native-buttons-off  # 关掉，退回纯键盘版
python -X utf8 modules/file_clip/setup_integration.py native-buttons-on   # 重新开启（默认状态）
```

**验证到什么程度、还差什么**：UIA 扫描能正确从真实资源管理器窗口里精确定位到「粘贴」
「删除」按钮并算出正确坐标——这部分已经用真实窗口自动化验证过。鼠标钩子的坐标命中→吞
点击→拉起对应引擎这条逻辑本身也经过代码走查，和已经跑通的键盘钩子是同一套模式。
但"鼠标真的点在真实按钮上，钩子真的吞到、真的弹出粘贴/删除"这个**完整链路的实机点击**，
这次没能在开发环境里跑通自动化验证到底（UI 自动化在沙盒工具环境里对"当前哪个窗口是
前台"这件事跟真实桌面看到的不一致，属于测试环境的限制，不代表逻辑有问题，但也没法
以此为证据宣称"验证通过"）——**这一步需要你自己动手点一下确认**。如果点了没反应，
大概率是这次没走通的那类问题，执行 `native-buttons-off` 退回纯键盘版（Ctrl+V /
Delete / Shift+Delete 依然生效，这些已经过实测），并告诉我具体现象，好继续排查。

右键菜单图标行的识别比工具栏更难：菜单是弹出即可能消失的临时窗口，扫描代理靠高频轮询
（~120ms）探测"菜单刚出现"再立刻扫它的按钮，存在"用户点得比扫描还快"的时间竞争，
可靠性天然低于工具栏（工具栏窗口一直在，不存在这个竞争）。命中失败（没赶上）会安全地
放行给系统原生处理，不会误吞更不会崩溃。

> 注：hotkey_agent.py（Python 钩子）已保留但**不再推荐**，它是"资源管理器未响应"的根因；
> 生产路径请用 C 版（setup_integration.py 的 start/install 已默认指向它）。

键盘钩子安全设计：只拦截「前台是资源管理器/桌面 + 剪贴板上是文件 + 焦点在文件列表区」的
纯 Ctrl+V；重命名框、地址栏里贴文字一律放行；钩子内任何异常一律放行按键；解析不出目标
文件夹时自动把 Ctrl+V 还给系统正常粘贴。

## 系统集成（右键菜单 / 桌面快捷方式 / 开机自启）

```powershell
python -X utf8 modules/file_clip/setup_integration.py install     # 一键装上
python -X utf8 modules/file_clip/setup_integration.py uninstall   # 一键卸干净
python -X utf8 modules/file_clip/setup_integration.py status      # 查看安装状态
```

装上后新增右键菜单：文件夹空白处/文件夹图标/桌面的「file_clip 高速粘贴」，
任意文件/文件夹上的「file_clip 高速删除（永久）」和「file_clip 删到回收站」
（都支持多选，自动汇成一批只弹一个窗）；桌面快捷方式和开机自启都指向 C 版钩子代理
（默认带原生按钮接管，见上一节）。全部只写当前用户（HKCU），install 会现场用 gcc
编译 C 代理，uninstall 后系统恢复原样（含关掉原生按钮接管、恢复经典菜单设置）。

## 性能设计

- 单文件走 `CopyFileExW`（Windows 内核级拷贝，保留属性与修改时间）；
- 海量小文件线程池并行（ctypes 调用释放 GIL，真并行）；
- ≥256MB 的文件用 `COPY_FILE_NO_BUFFERING` 无缓冲直写，完成即落盘；
- 同盘剪切 = `MoveFileExW` 改名，不搬数据，任意规模瞬间完成；跨盘剪切 = 拷贝校验成功后才删源；
- 内部统一 `\\?\` 扩展路径，不受 260 字符路径长度限制；
- 每个文件拷完做大小校验；单文件失败不中断整体，最后汇总报告。

实测（本机 C 盘 SSD，2026-07-17）：2GB 大文件 175 MB/s（Copy-Item 163 MB/s）；
1 万个 4KB 小文件复制 6.7s/1490 文件秒（Copy-Item 12.1s/827，robocopy /MT:8 10.6s/946）；
1 万个 4KB 小文件永久删除 3.7s/2733 文件秒（Remove-Item 9.0s/1111，cmd rd 4.1s/2453）。

### 点一下按钮/按一下键为什么感觉"快"——不只是引擎快

早期版本引擎本身很快，但点一次粘贴/删除的**整个体验**并不快：单文件粘贴的真实引擎耗时
通常 <10ms，可实测点击到窗口消失要 4.4 秒——几乎全部是「拉起 pythonw 子进程＋import
＋COM 解析目标窗口＋tkinter 建进度窗」这类固定开销，外加原来固定 3 秒的"展示结果"停留。
现在的做法（见"后台热键版"一节）：先在后台跑引擎，0.3 秒内做完就完全不弹窗、不付
tkinter 那份成本，直接感觉"瞬间搞定"；跑得久才弹窗，弹窗后停留时间也从 3 秒砍到 1.2 秒。
同样的单文件粘贴/删除，实测从 4.4s 降到 0.5s 左右。

**回收站删除本身有 Windows 系统级的固定开销**，这是数据说话：直接调引擎测，永久删除
1 个文件 3ms，回收站删除 1 个文件 390-530ms——**回收站删除比永久删除慢 100-115 倍**
（批量到 2000 个文件时差距收窄到 2-4 倍，因为固定开销被摊薄了）。这是系统 `SHFileOperation`
API 本身的成本（Explorer 自己拖文件进回收站也有这个延迟），不是本模块引擎写得慢——
真正在乎速度、不需要"可恢复"的场景，请用 Shift+Delete（永久删除）或右键的
「file_clip 高速删除（永久）」，那条路径快得多，几毫秒到几十毫秒量级。

## 测试

```powershell
python -X utf8 modules/file_clip/tests/run_tests.py   # 功能自测（10 用例，含 SHA-256 校验）
python -X utf8 modules/file_clip/tests/bench.py       # 性能实测（约 2 分钟，需 C 盘 5GB 空闲）
```

## 已知边界

- 目录符号链接（symlink）不复制链接本身，会按普通条目处理失败并记入报告（罕见场景）；
- 剪切粘贴成功后剪贴板自动清空（与资源管理器行为一致）；
- Ctrl+C 中断 paste：正在拷的文件由系统自动清掉半成品，已拷完的保留。
