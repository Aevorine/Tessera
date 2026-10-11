# 自动任务执行引擎 — 设计文档

日期：2026-07-09

## 背景与目标

用户希望在 `file_vault` 之外新增一种能力：提出一个软件开发需求后，系统能自动分析目标、制定计划，并在无需人工干预的情况下驱动 Claude Code CLI 完成环境检测、方案设计、代码实现、编译、调试、测试、优化、文档生成与最终验证；缺信息/缺权限时暂停并说明，补充后从中断处继续；在 Claude Code 订阅额度耗尽导致中断时，自动保存任务状态，并支持额度恢复后自动或手动续跑。

访问这个功能要走与 `file_vault` 完全相同的登录门禁（指纹 / TOTP / 邮箱 / 恢复密钥），且要求"加解密速度快"。

## 架构决策：不新建顶层模块，扩展 file_vault

`modules/README.md` 的惯例是"新场景 = 新文件夹，模块间不互相 import"。本次是一次**有意的例外**：

- 需求要求"同一个登录会话，不用重复验证"，且 IMK（身份主密钥）解锁后只活在发起登录的那个 Python 进程内存里。
- 若做成独立的 `modules/auto_task/`，要么各自独立登录（体验割裂、且违背"同一个界面"的要求），要么把加密/身份会话代码提升到 `core/`（改动面更大，且两个 Electron 窗口仍是两个进程，无法真正共享内存中已解锁的 IMK）。
- 把自动任务执行做成 `file_vault` 现有 Electron 应用内的新屏幕（与"密码管理""设置"平行），是唯一能做到"同一进程、同一次登录、IMK 复用、零额外 KDF 开销"的方案。

因此新增内容全部落在 `modules/file_vault/` 内部，不新建顶层模块文件夹。

## 新增文件

| 文件 | 职责 |
|---|---|
| `modules/file_vault/task_engine.py` | 任务编排：worktree 生命周期、spawn `claude` CLI 子进程、解析 `stream-json` 事件、状态机流转 |
| `modules/file_vault/task_store.py` | 任务状态/日志的加密读写，复用 `crypto.py` 的 AES-256-GCM 原语与已解锁的 IMK |
| `modules/file_vault/backend_server.py` | 新增 RPC 方法（见下） |
| `modules/file_vault/ui/src/components/TaskListScreen.tsx` | 任务列表 + 新建任务 |
| `modules/file_vault/ui/src/components/TaskDetailScreen.tsx` | 单个任务的实时日志、确认交互、审阅/合并 |
| `modules/file_vault/scripts/task_watcher.ps1` | 独立于 Claude Code 会话运行的额度恢复探测脚本 |

`MainScreen.tsx` 新增一个"自动任务"入口，与现有"密码管理""设置"入口平行。

## 任务生命周期与状态机

```
QUEUED → RUNNING → { WAITING_INPUT ⇄ RUNNING } → DONE_PENDING_REVIEW → (MERGED | DISCARDED)
                  → QUOTA_BLOCKED → (QUEUED | RUNNING)（续跑，见下方并发规则）
                  → FAILED → 重试（开新 claude 调用）→ (QUEUED | RUNNING) | DISCARDED
```

### 自主执行边界三种模式的精确定义

三种模式的差异**只在于要不要隔离 + 权限确认怎么跳过**，worktree 的创建规则和收尾动作因模式而不同，明确如下：

| 模式 | 是否建 worktree | 权限跳过方式 | `DONE_PENDING_REVIEW` 时的收尾动作 |
|---|---|---|---|
| 隔离 worktree + 全自动（默认） | 是，新分支 `task/<task_id>` | 整体 `--dangerously-skip-permissions` | 显示 worktree 相对目标分支的 `git diff`，两个动作：**合并到主分支**（`git merge`/`cherry-pick` 后删除 worktree）/ **丢弃**（直接删除 worktree 和分支） |
| 直接原目录 + 全自动 | 否，直接在用户当前签出的分支上操作 | 整体 `--dangerously-skip-permissions` | 任务开始前记录一次 `git rev-parse HEAD` 基线；结束后显示相对基线的 `git diff`（改动已经真实发生在工作区），两个动作：**确认保留**（无操作）/ **撤销改动**（`git checkout -- .` 回到基线，未跟踪的新文件单独列出请用户确认是否删除） |
| 分级自动 | 是，与"隔离 worktree + 全自动"相同 | 不整体跳过；转发 Claude Code 自身的权限确认事件到 UI——安全类操作（读文件、常规编辑、跑测试）自动确认，危险类操作（删除、force push、安装依赖、任意 shell）触发 `WAITING_INPUT`，在 UI 显示具体操作详情等用户点确认 | 与"隔离 worktree + 全自动"相同 |

执行流程：

1. 新建任务时用户手动选择目标目录（本地 git 仓库路径），填写任务描述，选择自主执行边界（默认：隔离 worktree + 全自动）与 engine（默认：Claude Code CLI；VS Code 插件选项见下）。
2. 按上表规则决定是否创建 `git worktree`。
3. 组装 prompt，`spawn`：
   ```
   claude -p "<prompt>" --output-format stream-json --cwd <worktree_path 或原目录>
   ```
   是否附加 `--dangerously-skip-permissions`、以及权限确认事件如何路由，按上表模式执行。
4. 解析 `stream-json` 逐行事件（"需要澄清"/"额度耗尽"/"正常完成"具体对应哪些事件类型和字段，需要在实施阶段先实测 `claude --output-format stream-json` 的真实输出格式后再落成精确匹配规则，这里只定义状态机层面的行为）：
   - 工具调用/文本内容 → 追加写入加密日志容器，同时通过既有的 progress 通知机制推给渲染进程。
   - 识别到"需要澄清"信号，或"分级自动"模式下识别到危险操作权限确认事件 → 状态置 `WAITING_INPUT`，暂停，在 UI 显示原始问题/操作详情。
   - 用户在 `TaskDetailScreen` 填写回答/点击确认 → 调 `task_answer_prompt` RPC → `claude --resume <session_id> -p "<回答>"` 继续。
   - 识别到额度耗尽的错误特征 → 状态置 `QUOTA_BLOCKED`，把 `session_id`、最后进度摘要、`pending_followup_prompt`（默认"继续"）写入加密的 `meta.json`，子进程退出。
   - 子进程异常退出（非零退出码）且不属于"额度耗尽"或"正常完成"任何一种已识别信号 → 状态置 `FAILED`，把捕获到的错误摘要写入 `meta.json` 的 `error_summary` 字段。`FAILED` 时若存在 worktree（隔离/分级模式）则**不自动清理**，留作事后排查；直接原目录模式下改动本来就已发生在工作区，同样原样保留不回滚。`TaskDetailScreen` 显示错误摘要 + 完整日志，提供两个动作：**重试**（`task_retry` RPC，开启全新 `claude` 调用，不用 `--resume`，因为原 session 可能已损坏；按并发规则进入 `QUEUED` 或 `RUNNING`）/ **丢弃**（复用 `task_discard`，行为与对应模式下 `task_discard` 已定义的丢弃动作一致——按模式清理 worktree 或撤销改动）。
   - 正常收敛（Claude Code 自认为完成）→ 状态置 `DONE_PENDING_REVIEW`。
5. `DONE_PENDING_REVIEW` 的收尾动作按上表模式执行。
6. 任务内部的自检/修复循环由 Claude Code 自身完成（这是它本来的能力），`task_engine` 不额外实现"重新分析-重新修复"逻辑；只有用户在 UI 里点"继续迭代"才会追加新一轮 `--resume` + 新指令（对应"直到我说修复OK/完成/结束任务"的要求）。

同一时间只允许一个任务处于 `RUNNING`，其余排队（`QUEUED`），避免多个 `claude` 子进程抢占同一份 Claude Code 额度。`task_create` 新建任务同样遵守此规则（有任务在跑时新任务直接进 `QUEUED`，不立即 spawn）。这条约束对所有触发续跑的路径统一生效：`task_resume`（不论是 watcher 自动调用、解锁自检批量调用、还是用户手动点"立即重试"/`task_retry`）在真正 spawn 子进程前，都先检查是否已有任务处于 `RUNNING`——有则只把目标任务的状态从 `QUOTA_BLOCKED`/`FAILED` 改回 `QUEUED`，排到队尾等当前任务结束后再自动启动；没有才直接转 `RUNNING` 并 spawn。解锁自检"逐个尝试 `task_resume`"因此实际效果是：至多一个进入 `RUNNING`，其余全部进入 `QUEUED` 排队，不会出现并发的 `claude` 子进程。

## 数据模型与加密

路径：`modules/file_vault/data/tasks/<task_id>/`

- `meta.json.enc`：任务描述、目标目录、engine/自主边界设置、当前状态、`session_id`、worktree 分支名（若有）、`pending_followup_prompt`、`last_checkpoint_summary`、`blocked_at`、`error_summary`（`FAILED` 时）。整体 AES-256-GCM 加密（单 blob 模式，与 `passwords.py` 的密码库存储方式一致）。
- `log.ivault`：Claude Code 输出事件的完整记录，复用 `container.py` 现成的分块容器格式（4MB chunk、流式追加友好）。

密钥模型与 `file_vault` 完全一致：登录时已解锁的 IMK 常驻进程内存；每个任务创建时生成一个随机 File Key，用 IMK 包裹一次（普通 AES-GCM，不再跑 Scrypt）；日志/元数据的每次读写都是纯 AES-256-GCM，没有额外 KDF 开销——这就是"加解密速度快"的来源，慢的 Scrypt 只发生在登录那一次。

## 中断/恢复协议

`meta.json` 中 `QUOTA_BLOCKED` 状态记录：

```json
{
  "status": "QUOTA_BLOCKED",
  "session_id": "...",
  "last_checkpoint_summary": "...",
  "pending_followup_prompt": "继续",
  "blocked_at": "2026-07-09T..."
}
```

**关键约束**：IMK 只在已解锁的 `backend_server.py` 进程内存里存在，且该进程随 Electron 应用一起启停——这是 `file_vault` 本来的安全设计（不做无人值守的后台常驻解密服务，否则未登录状态下也有明文密钥常驻内存，等于绕开了整套登录门禁）。因此 `task_watcher.ps1` 能不能"自动续跑"，取决于 file_vault 应用当时是否已经打开并解锁：

- **应用已打开且已解锁**：`task_watcher.ps1` 默认每 30 分钟（可配置）对所有 `QUOTA_BLOCKED` 任务做一次轻量探测：`claude -p "ping" --output-format json`。探测成功 → 调用 `backend_server.py` 新增的 `task_resume` RPC，带上 `session_id` + `pending_followup_prompt`，自动续跑对应任务，全程无需人工介入。探测失败（仍是额度错误）→ 什么都不做，等下一轮。
- **应用未打开/未解锁**：`task_watcher.ps1` 探测到额度恢复后，无法调用 RPC（backend 不在），改为发一条 Windows 系统通知提醒用户打开并解锁 file_vault。用户下次解锁成功的那一刻，`backend_server.py` 在完成解锁后自动检查所有 `QUOTA_BLOCKED` 任务并逐个尝试 `task_resume` 一次（这一步不需要用户额外点击，属于"解锁即续跑"的启动自检），失败则回落到 `QUOTA_BLOCKED` 继续等下一次探测/手动重试。
- 用户也可以在 `TaskDetailScreen` 里对 `QUOTA_BLOCKED` 任务随时点"立即重试"手动续跑，不依赖 watcher 脚本或应用是否曾经关闭过。

## 新增 RPC 方法（`backend_server.py`）

| 方法 | 说明 |
|---|---|
| `task_create(target_dir, description, engine, autonomy_mode)` | 创建任务、按模式决定是否建 worktree、spawn 子进程 |
| `task_list` | 返回所有任务及状态摘要 |
| `task_cancel(task_id)` | 取消一个还在 `QUEUED` 中未开始的任务 |
| `task_get_log(task_id, offset)` | 增量读取解密后的日志 |
| `task_answer_prompt(task_id, answer)` | `WAITING_INPUT` 时提交回答/确认，`--resume` 续跑 |
| `task_resume(task_id)` | `QUOTA_BLOCKED` 时手动、被 watcher、或解锁自检调用续跑 |
| `task_retry(task_id)` | `FAILED` 时开启全新 `claude` 调用重试（不复用旧 `session_id`） |
| `task_review_diff(task_id)` | 返回 diff 摘要（隔离模式下相对目标分支；直接原目录模式下相对开始前基线） |
| `task_merge(task_id)` / `task_discard(task_id)` | 隔离模式：合并到主分支或丢弃 worktree；直接原目录模式：确认保留或撤销改动 |

## UI

**TaskListScreen**：任务卡片列表（名称/目标目录/状态徽标：排队中/执行中/等待你确认/额度耗尽/失败/待审阅/已合并/已丢弃），"新建任务"弹窗（目标目录选择器、任务描述、engine 选择、自主执行边界选择）。

**TaskDetailScreen**：实时日志流；`WAITING_INPUT` 时顶部出现输入框显示 Claude Code 的原始问题；`DONE_PENDING_REVIEW` 时显示 diff 摘要 + 合并/丢弃按钮；`QUOTA_BLOCKED` 时显示"等待自动探测恢复" + "立即重试"按钮。

**engine 选择中的 VS Code 插件选项**：明确标注为"手动接管模式"。Claude Code 的 VS Code 插件目前没有可编排的无头/远程控制接口，选中后模块只会打开 VS Code 到目标目录并预填一份任务简报文件，之后由用户自己在 VS Code 里手动继续——不是自动模式。真正无人值守的路径只有 Claude Code CLI 一条。

## 范围之外（本次不做）

- 任务并发执行（一次只跑一个）
- 取消一个正在 `RUNNING` 的任务（`task_cancel` 只能取消尚未开始的 `QUEUED` 任务；要中止正在跑的任务，只能等它自然收敛到某个终态）
- 固定项目下拉列表（每次任务手动选目录）
- VS Code 路径的自动化（只做手动打开 + 预填简报）
- 重新实现 Claude Code 自身的规划/编码/测试/调试能力——`task_engine` 只负责下发、监控、暂停恢复、加密存档
- 多用户/多设备同步
- watcher 脚本的额外通知渠道（微信/邮件提醒等）

## 验证方式

- `modules/file_vault/tests/test_task_engine.py`：mock `claude` 子进程（用一个假的 stream-json 输出脚本代替真实 CLI），验证状态机在 QUEUED→RUNNING→WAITING_INPUT→RUNNING→DONE_PENDING_REVIEW 以及 QUOTA_BLOCKED→RUNNING 两条路径上的流转正确。
- `modules/file_vault/tests/test_task_store.py`：加密写入/读取 `meta.json.enc` 与 `log.ivault` 的往返测试，确认与已有 `crypto.py`/`container.py` 兼容。
- `tsc --noEmit` 确认新增 UI 组件类型正确。
- 手动验证（无法自动化的部分）：真实创建一个任务，观察 worktree 是否正确创建、`claude` CLI 是否被正确 spawn、日志是否实时显示、`WAITING_INPUT`/合并/丢弃流程是否可用。额度耗尽与 watcher 脚本的自动续跑，需要真实等到额度耗尽时手动确认一次。

## 实施建议（供后续 writing-plans 参考）

- 第一步应先手动跑一次 `claude -p "..." --output-format stream-json` 拿到真实事件样本，再去实现 `task_engine.py` 里"需要澄清/额度耗尽/正常完成"的精确匹配规则，避免凭猜测的字段名返工。
- 建议按"后端状态机 + RPC" → "UI 两个屏幕" → "watcher 脚本与解锁自检" 三个阶段交付并逐阶段手动验证，而不是一次性整体实现——涉及的活动部件较多（任务引擎、加密存储、10 个新 RPC、2 个新 UI 屏幕、1 个外部脚本）。
