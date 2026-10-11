# 自动任务引擎 — PRD 拆解闭环模式（Ralph 化改进）— 设计文档

日期：2026-07-11

## 背景与目标

用户参照 "Ralph"（一种自主编码 agent 循环范式：干净上下文重启 + PRD 拆解为 user story + git/状态文件/进度笔记三层持久化记忆 + 编译测试闭环反馈）提出改进需求，目标是在 `modules/file_vault` 现有的"自动任务"功能上，**提升准确性、降低 token 消耗**。

### 现状与 Ralph 的关键差异（必须先讲清楚，否则设计会建在错误的假设上）

`task_engine.py`/`backend_server.py` 当前的自动任务引擎，实际形态和 Ralph 有本质区别：

- Ralph：每轮杀掉旧进程、起一个**全新干净上下文**的实例，靠外部文件传递记忆。
- 现有引擎：一个任务 = **一个可见的交互式 `claude` 终端会话**（`launch_in_visible_terminal`，见 `task_engine.py:117`），用户全程可见、可介入；额度用尽或需要继续时用 `-c`/`--resume` **接续同一个会话**，不是重启干净上下文。完成信号靠 Claude 自己写一个 marker 文件（`check_task_done_marker`），引擎完全不解析 Claude 的输出内容。

这个形态是团队踩过坑之后的**有意选择**：早先版本用 `subprocess.PIPE` 捕获 `claude` 的 stdout/stderr 来做自动化解析，复现了两次不可预测的死锁（管道缓冲区没人排空导致子进程阻塞），即使修了明显的漏排空 bug 后仍会复现，所以彻底放弃了"捕获输出做自动判断"，改为人盯终端 + 无捕获。

**这意味着：任何新增的"自动拆解、自动跑测试、自动读结果决定下一轮"的闭环机制，都不能重新引入 PIPE 捕获 `claude` 交互输出这条路**，否则就是重新踩一遍已经踩过的坑。本设计的可行性建立在下面这条区分之上：

- 对 **`claude` 本身**（交互式子进程）：本设计新增的路径一律用 `claude -p "<prompt>" --output-format stream-json > <文件>` 做**文件重定向**而非 `subprocess.PIPE`。文件写入不存在"没人读就阻塞"的机制，从根源上避免了这一类死锁；调用是一次性的（`-p` 非交互，跑完即退出），Python 侧等进程退出后再读文件，不存在竞争。
- 对**用户项目自身的测试/编译命令**（`npm test`/`pytest` 等，与 `claude` 无关的普通子进程）：`subprocess.run(..., capture_output=True)` 一直是安全的——之前的死锁特指"给 `claude` 交互会话挂 PIPE 又没人及时排空"这一具体场景，不适用于跑完即退出的普通测试命令。

因此新模式和现有的"可见终端 + marker 文件"模式，是 `task_engine.py` 内两条**并列、互不干扰**的执行分支，不是替换关系——默认模式继续保持现状（人盯终端，最贴合"用户想全程看着、随时插话"的场景），新模式是一个显式选择的、真正无人值守的批量交付通道。

## 新增能力：PRD 自动拆解闭环模式

任务创建界面新增一个可选项——**"自动拆解并闭环执行"**（复选框，默认关闭）。仅当自主边界选择 `isolated_full_auto` 或 `graded_auto`（需要 worktree，见下文"为什么 direct 模式不提供此选项"）时可用。

### 为什么 direct_full_auto 不提供此选项

新模式需要"每个 story 通过验证后立即提交一个小 commit"，在用户真实工作目录里原地做多次自动 commit 的风险明显高于"跑完一次性任务"；`direct_full_auto` 本来就是"直接改用户当前分支"的模式，语义上不适合叠加"自动多次提交"。因此这一新能力只在已有 worktree 隔离的两种模式下开放。

### 整体流程

```
用户任务描述（视为 PRD）
   │
   ▼
① 拆解阶段：一次性 `claude -p`（文件重定向）→ stories.json
   （story 列表 + 每个 story 的验收标准 + depends_on 依赖 + 建议 model/effort）
   │
   ▼
② 调度：DAG 拓扑排序，选"无阻塞依赖 + 解锁下游最多"的下一个 ready story
   │
   ▼
③ 执行该 story：组装 prompt = 精简记忆检索结果 + story 描述/验收标准
   一次性 `claude -p`（文件重定向，全新上下文，不 `-c`/`--resume` 接续）★
   ★ 见下方"二次创新：拟人化输入层与会话复用"一节——这一步被修正为
     "同一任务全程复用一个交互会话，像真人一样打字发送每个 story，
     必要时模拟敲 /compact 而不是重启进程"
   │
   ▼
④ 验证：跑用户提供的测试命令（capture_output，非 claude 进程，安全）
   ├─ 通过 → 小 commit（消息含 story id）→ 追加一条结构化记忆记录
   │         → story 标记 passed → 回②选下一个
   └─ 不通过 → 按"失败签名"归类；命中已知簇则把历史修复方案带入下一轮 prompt
             → 同一 story 连续失败达到阈值（默认 3 次）→ 状态 BLOCKED_NEEDS_REVIEW，
               暂停自动循环，等待用户在 UI 里人工介入
   │
   ▼
⑤ 全部 story passed → 任务转入既有 DONE_PENDING_REVIEW，
   复用现有 diff 审阅 / 合并 / 丢弃流程，不重新发明
```

这个流程把 Ralph 的四个核心思想都落到了具体机制上，同时做了针对"降 token / 提准确率"的改造，而不是照搬：

| Ralph 原始思想 | 本设计的落地方式 | 相对 Ralph 原版的改进点 |
|---|---|---|
| 干净上下文重启 | 每个 story 一次性 `claude -p`，不接续旧会话 | 同 Ralph |
| 扁平任务队列 | **DAG 依赖图 + 拓扑调度**（见下） | 避免在依赖未满足时反复尝试，省无效 token |
| 全量记忆转储（progress.txt 整份塞入） | **结构化记忆 + 规模阈值内全量、超阈值后标签匹配**（见下） | 记忆是结构化字段而非自然语言堆叠，同等信息量下 token 更少、更不易被模型误解 |
| 编译测试闭环 | 用户显式提供测试命令，一样跑完即读结果 | 增加"失败签名归类 + 熔断"，避免对同一个坑反复烧 token |

> **本表"干净上下文重启"这一行在下方"二次创新：拟人化输入层与会话复用"一节中被修正**——引入拟人化输入层后，`③ 执行该 story` 改为"同一任务全程复用一个交互会话，必要时模拟人类敲 `/compact`"，不再是每个 story 都重启一次性 `claude -p` 进程。这是在新约束（CLI 终端与 VS Code 插件都要"像真人打字提交"）下，对第一版方案的显式修正，原因和取舍见下方新章节，这里不再重复。

### 依赖图与调度

拆解阶段要求 Claude 在 `stories.json` 里为每个 story 显式给出 `depends_on`（依赖的其他 story id 列表）。Python 侧做：

1. 环检测（有环则拆解结果视为无效，整体退化为单 story 顺序执行，见"兜底"一节）。
2. 拓扑排序得到候选顺序。
3. 调度器每次选"当前 ready（依赖已全部 passed）且解锁下游数量最多"的 story——这是一个简单启发式打分，不引入额外的规划算法。

### 结构化记忆与 token 节省

记忆记录存成 `memory.jsonl`，一行一条结构化 JSON：

```json
{"story_id": "s3", "pattern": "...", "root_cause": "...", "fix": "...", "files_touched": ["a.py"], "tags": ["auth", "retry"], "timestamp": "..."}
```

组装下一个 story 的 prompt 时：

- **记录数 < 阈值（默认 30 条）**：全量注入。多数任务不会超过几十个 story，这个规模下全量注入的 token 成本本身就不高，直接引入检索基础设施属于过度设计。
- **记录数 ≥ 阈值**：用 story 自带的 `tags` 做简单关键词匹配打分，只注入 top-k（默认 5 条）最相关记录。**不引入向量数据库/embedding 依赖**——这是本设计刻意维持"轻量、不过度设计"（`docs/architecture.md` 的既定原则）的地方；如果未来实践中发现关键词匹配效果不够，再考虑引入语义检索，此处先留好扩展点（记忆记录的 schema 已经是结构化的，替换检索方式不需要改数据格式）。

相比 Ralph 原版每轮把整份自然语言 `progress.txt`/`AGENTS.md` 塞给模型，结构化记录本身信息密度更高（去掉了叙述性文字的冗余），且有明确的规模阈值控制何时该做筛选而不是无脑增长注入量。

### 模型分级路由

不新增一次独立的"复杂度分类"调用（那本身也要花 token）。而是让拆解阶段的 Claude 在生成每个 story 时**顺带给出建议的 `model`/`effort`**（复用 `task_engine.py` 已有的 `--model`/`--effort` 透传机制），执行阶段默认信任这个建议，用户可以在任务创建界面整体覆盖。简单任务用便宜/快模型，复杂任务用最强模型，路由决策"免费"搭在本来就要做的拆解调用里。

### 失败签名与熔断

第一阶段用**最简单**能生效的方案：对测试失败输出做归一化（去掉时间戳、临时文件路径等易变内容）后取哈希作为"签名"。命中已知签名 → 把对应的历史修复记录优先带入下一轮 prompt；同一 story 连续失败达到阈值（默认 3 次）→ 状态置 `BLOCKED_NEEDS_REVIEW`，暂停，等待用户人工查看（这一步复用"暂停等人"的既有理念，但触发条件是引擎自己的熔断判断，不是 Claude 主动提问）。

**不做**真正的语义聚类（embedding 相似度），原因同上——先用最简单的方案验证价值，规模/误判率真正成为问题时再升级。

### 兜底：拆解失败怎么办

拆解阶段的输出必须是合法 JSON 且通过 schema 校验（story 数组、每项有 `id`/`description`/`acceptance_criteria`/`depends_on`）。如果解析失败或校验不过：**不阻塞用户**，整个任务退化为"单一 story = 原始任务描述"直接执行，相当于关闭了拆解/调度/分级路由这几个增量收益，但保留"跑测试 → 失败签名 → 熔断"这层验证闭环。这个兜底路径应在实现和测试中显式覆盖，避免"拆解偶尔失败"变成"任务卡死"。

## 超越"两者简单拼接"的额外创新

上面的流程已经把 Ralph 的四个思想接到了现有引擎上，但这一节是专门回答"结合之外还有什么新东西"——这五点没有直接对应 Ralph 原版或现有引擎里已有的任何一块，是这次设计真正新增的机制：

### 1. 影子验收员（Shadow Verifier）——测试之外的第二道低成本闸门

`test_command` 是可选的（很多任务描述的验收标准本来就不是"跑一条命令能判断"的，比如"文案改得更自然"）。在跑真正的测试命令**之前**，先插入一次极便宜的验证：用最小的模型（如 haiku）+ 文件重定向的一次性 `claude -p` 调用，只喂"这个 story 的验收标准" + "这一轮的 diff"（不是整个仓库），让它只回答"是/否满足，一句话说明"。

- 明显不满足的直接打回重做，**不浪费一次完整测试套件的运行时间和后续 token**（尤其在测试套件较慢、或没有配置测试命令的项目里，这道闸门是唯一的自动验证）。
- 这本质上是把"自我怀疑"从"同一个大模型在长对话里自己判断"（Ralph 和现有引擎都没有的独立视角）变成一次**独立、廉价、无历史包袱**的旁观判断——独立视角比自我判断更不容易被自己的错误说服。

### 2. Token/时间预算熔断——不只看"失败次数"

现有设计的熔断只在"连续失败达到次数阈值"时触发，但有一种更隐蔽的浪费：story 每次都"看起来在推进"（不同的错误、不同的 diff），但实际上在原地打转，从未真正逼近验收标准。给每个 story 设一个**硬性 token/时间预算**（比如"这个 story 累计不超过 X 次 `claude -p` 调用 或 Y 分钟"），预算耗尽即熔断转人工，**不管当时是否处于"看起来还在推进"的状态**。这是把 Ralph 里没有的"止损"概念显式加进来——Ralph 本身依赖近乎无限的循环次数，本设计认为这在有真实 token 成本的场景下是不可接受的。

### 3. 记忆退休/压缩（Memory Compaction）——让记忆随时间收敛而不是线性膨胀

第一版方案（阈值内全量注入、超阈值标签匹配）解决了"单次注入多少"的问题，但没解决"`memory.jsonl` 会不会无限增长"。补一个后台动作：每当记忆条数达到一个更高的压缩阈值（比如 100 条），触发一次**独立的、低频的**"记忆压缩"调用——把多条描述相似、`tags` 重叠的记录，合并归纳成一条更抽象的模式记录（类似人从多次踩坑归纳出一条经验规则），旧的具体记录归档但不再参与检索。这让长期项目的记忆体积增长趋于收敛，而不是随 story 数量线性增长——是本设计中唯一显式针对"多任务、长期使用"场景的机制。

### 4. 重试多样性——同一个坑第二次换个角度，而不是重复同一条失败路径

现有失败签名机制解决了"认出同一个坑"，但重试时默认还是用同一个 model/同一种 prompt 结构，如果模型本身在某个思路上"卡住"，原地重试大概率复现同样的错误（纯粹浪费一轮）。规则：**同一 story 第 2 次重试起，强制切换 model 或调整 prompt 的切入角度**（比如换一个建议的模型别名、或把"直接修复"改成"先解释为什么上一版错在哪，再修复"）。这是把"多样性采样"这个在其他 LLM 应用里常见但 Ralph 原版没有提到的思路，引入到重试策略里。

### 5. 自动闭环 ⇄ 可见终端的双向切换——两条路径不是二选一，而是可以互相接管

前面强调新旧两条路径"并列、互不干扰"，但对用户体验来说更有价值的是：**卡在 `BLOCKED_NEEDS_REVIEW` 的 story，允许用户一键切换成现有的"可见终端"模式**，直接对那个 story 当次失败的上下文开一个真人可控的交互会话去处理（复用 `launch_in_visible_terminal` 已有的能力），处理完手动标记 story passed 后，调度器再接管继续跑后面的 story。这让"全自动"和"人工兜底"不再是任务创建时一次性的选择，而是**运行过程中可以随时按需切换的两种视角**——自动模式负责把 token 花在真正需要模型判断的地方，人工模式负责兜住自动化处理不好的边界情况，两者共享同一个任务的状态而不是相互隔离。

## 二次创新：拟人化输入层与会话复用（回应"像真人打字提交"的新约束）

用户提出新要求：不管是驱动 **Claude Code CLI 的终端**，还是驱动 **VS Code 的 Claude Code 插件**，都要"像真人在框里提出要求、提交、发送给 AI"，而不是靠命令行参数/隐藏 API 硬塞。这不只是一个体验要求，而是直接决定了 VS Code 插件这条路径**能不能自动化**——它没有任何 CLI/headless API，唯一能集成的路径就是自动化它自己的输入框。把这个约束认真对待，反而牵出了几个新的、能同时提升准确性和降 token 的机制，下面展开。

### 为什么这不是"退步"，而是打开了新设计空间

第一版方案里"每个 story 一次性 `claude -p`"是刻意的 Ralph 式选择（干净上下文、避免长会话幻觉累积）。但"像真人打字提交"这个约束意味着：既然要能在同一个终端/同一个 VS Code 窗口里持续"打字发送"，那**同一个会话天然是持续存在的**，杀掉重启反而变得不自然（也不像真人会做的事——真人不会为了"防止自己记性差"而每说一句话就把自己拉黑重新自我介绍一次，真人是靠"翻笔记本/看聊天记录"来对抗遗忘的）。于是自然浮现出一个更贴近人类实际工作方式的方案：**同一个任务全程只维持一个交互会话，遗忘问题靠"翻笔记"（结构化记忆检索，已在第一版设计里）+ 必要时"整理笔记"（原生 `/compact`）来解决，而不是靠"失忆重开"来解决**。

### 技术方案：统一的拟人化输入层

抽象出一个 `HumanLikeInputDriver` 接口（`send_message(text)` / `read_transcript()` / `is_idle()`），CLI 和 VS Code 各自实现一版，上层的调度器/story 执行逻辑完全不关心当前引擎具体是哪一个。

**CLI 终端实现 —— 已实测跑通端到端闭环**：最初设想是用 Windows Console API 的 `WriteConsoleInput` 逐字符构造按键事件写入目标控制台的输入缓冲区。实际动手验证时改用了更成熟的路线——`node-pty`（对 Windows ConPTY 的封装，VS Code 自己的集成终端也基于同一套机制），因为它是业界验证过的方案，而不是自己从头拼 `INPUT_RECORD`。前三轮测试没有跑通（详见下方"踩过的坑"），第四、五轮定位到真正原因并修好之后，**连续两次独立测试（问"hi"、问"日本首都"）都成功拿到了 Claude 的真实回复**（"Hi! How can I help you today?"、"Tokyo"），确认"发消息→提交成功→收到回复"这个最基本的闭环是通的。

跑通的关键协议（`send_message`/`is_idle` 的实际实现依据）：

1. **必须等到真正"就绪"才能开始打字**，判断标准不是"输出静默 N 秒"这么简单——早期测试因为只等 800ms 静默就开始打字，而当时 App 其实还在启动渲染中（累计字节数才 84，远不是完整界面），导致按键被送进了一个还没准备好接收输入的状态而丢失。**必须同时满足"静默 ≥1s"且"累计输出字节数超过一个门槛（约 1000+ 字节，对应完整欢迎界面渲染完成）"两个条件**才算真正就绪。
2. **打字和回车必须是两次独立的 `write()`调用，中间间隔约 300-500ms**，不能拼成一次 `"文本+\r"` 整体写入——怀疑与 `claude` 协商的终端 `bracketed paste`（`?2004h`）模式有关，一次性整段写入容易被当作"粘贴"而不是"打字后回车提交"。
3. **忙碌状态的识别**：Claude Code 的 TUI 在处理时会显示一个不断变化的"动词+…"式转圈文案（如"Ruminating…""Channelling…"——这是 Claude Code 自己的花式随机提示语，每次调用用词不同），完成时变成"`<某动词> for Ns`"（如"Worked for 9s""Churned for 7s"）。**不要匹配具体某个词**（词库会变），应该匹配结构性正则：忙碌 = `/\w+ing…/`，完成 = `/for \d+s\b/` 且随后输出静默。
4. **读取回复内容目前用的是粗暴的 ANSI 转义序列剥离**（正则删除 `\x1b[...` 控制序列），验证够用但不够干净——因为 TUI 是靠光标定位做局部重绘的，粗暴剥离会把文字之间的空格/换行搞乱（比如"Hi! How can I help you today?"剥离后挤成了"Hi!HowcanIhelpyoutoday?"）。**生产实现应该用真正的终端模拟器库维护一份虚拟屏幕缓冲区**（比如 `xterm-headless`，正确处理光标移动/清屏指令后再读取屏幕文本），而不是对原始 ANSI 流做字符串替换——这是下一步要做但目前还没做的具体优化项，不是未知问题。

**踩过的坑（供后续排查参考）**：
- 第一轮：新目录首次启动时跳出"是否信任此文件夹"确认框，把打进去的消息吞掉了——回车键被当成"确认信任"而不是"提交消息"。**注意**：后续几轮换成同一父目录下的新子目录后，这个确认框没有再出现过，怀疑信任状态是按更上层的祖先目录记忆的，具体范围规则还没有专门验证清楚，不能假设"每个新 worktree 一定会跳出来"或"一定不会"，实现时两种情况都要能处理。
- 第二、三轮：静默等待时间不够长就开始打字，加上"整段文字+回车"一次性写入，两个问题叠加导致消息没有确认提交成功。

**尚未验证、留到下一步的**：中文等非 ASCII 字符的打字/提交是否同样可靠（目前成功验证都只用了英文消息）；`/compact`/`/clear` 等 slash 命令能否用同样的"打字+回车"方式可靠触发；连续多轮对话（同一会话发第二条、第三条消息）是否稳定，目前只验证了"新会话发一条消息"这个最小场景。

**实现状态（已接入主线）**：`modules/file_vault/js/pty_driver.js`（`node-pty` + NDJSON 协议，命令：`spawn`/`send_message`/`wait_idle`/`read_screen`/`exit`）和 `modules/file_vault/human_like_driver.py`（Python 封装）已经写好、测试，并且**已经接入 `task_engine.py`/`prd_loop_runner.py`/`backend_server.py` 的实际执行流程**，不再是孤立组件：

- `task_engine.run_story_cycle_persistent(driver, story, ...)`：会话复用版本的 story 执行，通过已经 spawn 好的 driver 发消息，而不是每个 story 重启一次性 `claude -p`。模型切换用发一条 `/model <alias>` 消息实现（只在真的要换模型时才发）。
- `prd_loop_runner.step(...)` 新增可选 `driver` 参数：给了就走会话复用路径，不给就还是原来的一次性路径——完全向后兼容，两条路径共存。
- `backend_server.py` 维护一个进程内的 `_pty_sessions` 注册表（task_id → 已 spawn 的会话），`rpc_task_decompose_mode_step` 懒加载 spawn、按固定次数阈值（`COMPACT_EVERY_N_ATTEMPTS = 5`，是"上下文健康度探测"这个想法目前的简化版——固定节奏，不是真的探测漂移）触发 `/compact`，任务终止时（`DONE_PENDING_REVIEW`/合并/丢弃）关闭并清理会话。**（2026-07-12 已修复一个遗漏）**：这几条终止路径本身一直是对的，但 `serve()` 的主循环（stdin 关闭 = 后端进程退出）原本完全没有清理逻辑——任务还开着（暂停/阻塞/跑到一半）时如果直接关掉 app/后端进程，`_pty_sessions` 里存活的会话就会被跳过，其 `node.exe` 子进程（以及底下真正的 `claude` 进程）成为孤儿进程，Windows 不会因为父进程退出就自动杀掉它们。已修复：`serve()` 用 `try/finally` 包住主循环，退出前调用新增的 `_close_all_pty_sessions()` 遍历关闭所有存活会话。回归测试：`test_backend_server.py::test_closing_client_cleans_up_a_still_open_pty_session`（用 ctypes Toolhelp 快照直接验证子进程真的被杀掉，不只是断言 RPC 返回值）。

测试过程中又抓到一个真实 bug 并修复：`wait_idle` 最初拿整个会话累计输出的尾部去匹配"忙碌/完成"标记，导致一次回复完成后的标记文字会一直留在尾部窗口里、每次轮询都被重新匹配到，"最后一次看到忙碌标记"的计时器永远重置，`wait_idle` 因此永远等不到真正的"闲"，只能超时——改成只扫描"这条消息发出之后新产生的输出"才修好。先用一个不启动真实 `claude`、模拟交互式 CLI 的测试夹具（`tests/fixtures/fake_interactive_cli.py`/统一后的 `tests/fixtures/fake_claude.py`）验证了协议本身，再用修好的正式代码对真实 `claude` 完整跑通"发消息→收到正确回复→关闭会话"（问"12×12"得到"144"），最后端到端跑通了完整的 `backend_server.py` E2E 测试（decompose_mode 任务全程走会话复用路径）。**尚未验证的**：`/compact` 阈值触发这条路径本身只在单元逻辑层面测过（简单的计数器算术），没有专门用一个真正跑到 5+ 次尝试的多 story 场景做端到端验证；中文消息、`/effort` 切换也仍未验证。

**VS Code 插件实现 —— 已完整跑通端到端闭环，从全新 profile 到发消息收回复全自动**：这条路径经历了两轮调查。第一轮（见下方"第一轮踩过的坑"）确认了 CDP 机制可行，但点击/输入迟迟不成功；第二轮定位到真正原因、修好之后，**完整跑通了"启动全新隔离 VS Code → 打开 Claude Code 面板 → 发消息 → 检测到空闲 → 读到回复"全流程，且全程无人工干预**（问"15+27"，收到"Channelling…"忙碌状态与最终回复，详见下方"已确认的剩余缺陷"）。

**关键突破：找到真正的输入框所在位置**。Claude Code 面板不是普通网页 DOM 的一部分，而是一个独立的 `vscode-webview://` CDP target（在 `GET /json` 里能看到，`type: "iframe"`，URL 含 `extensionId=Anthropic.claude-code`），本身还嵌套了一层 "active-frame" 执行上下文——之前反复搜索主页面 DOM 找不到输入框，是因为它压根不在主页面的 DOM 树里，得直接连到这个 webview 自己的 CDP target 上（用 `Runtime.executionContextCreated` 事件找到正确的 execution context）。真正的输入框是 `[contenteditable="plaintext-only"]`（不是 `contenteditable="true"`——这个具体差异是之前反复找不到元素的直接原因）。定位到之后：

- **点击**：直接对这个 webview target 发送 `Input.dispatchMouseEvent`（用元素自身 `getBoundingClientRect()` 算出的局部坐标，不需要换算设备缩放比例——因为是独立 target，不是从主页面透视），`document.activeElement` 确认正确聚焦到了输入框本身。
- **打字**：只用 `Input.dispatchKeyEvent` 的 `keyDown`（带 `text` 字段）+`keyUp`，**不要**再额外发一个 `type: 'char'` 事件——两个都发会导致每个字符重复插入两次（实测"hello"变成"hheelllloo"），只发 `keyDown` 就是正确的单次插入。
- **提交**：发送 Enter 键事件（`key: 'Enter'`），输入框会清空，等同人类回车发送。

**从一个完全空白的新 profile 到能对话，还需要三步引导（这是这次最终自动化验证出来的，缺一不可）**：

1. **VS Code 自己的首次运行引导弹窗**（和 Claude Code 无关，是 GitHub Copilot 登录提示 + 主题选择 + "Build with AI Agents" 提示，一共 3 步）挡在最前面，吞掉所有输入，必须先点掉。
2. **不能靠命令面板搜索文字来打开 Claude Code 面板**：本机同时装了另一个叫"Claude Code Usage"的无关插件，命令面板模糊匹配时可能命中它的设置项而不是真正的"打开 Claude Code"命令（实测确实命中了）。改用点击活动栏（Activity Bar）图标，按 `aria-label` 精确匹配"Claude Code"且排除包含"usage"的结果，稳定可靠。
3. **打开面板后落到的是会话列表侧边栏，不是聊天输入框**：还需要再点一次"New session"才能看到真正的消息输入框。**这一步本身也曾经有 bug**——最初实现把"New session"按钮当成主页面 DOM 的一部分去搜索（跟第 2 步的活动栏图标一样处理），但实测确认它跟聊天输入框一样，本身也活在 Claude Code 自己的 `vscode-webview://` target 里，不在主页面 DOM 里。这个 bug 只在"复用一个已经有对话历史的 profile"时才会暴露（全新 profile 没有历史记录，点开面板后可能直接落在空白对话上，这一步等于没做也不会出错，所以最初的实现表面上"能跑通"，但换成复用旧 profile 立刻卡死在反复找不到输入框上）——已修复为：查真正的 Claude Code webview target 列表，在其 execution context 里按钮的 `newSessionButton_djirOA` class 精确定位再点击。

第一次尝试自动跑这三步引导时失败了，原因是固定 `sleep(1000)` 就去点，而全新 profile 第一次弹窗渲染需要的时间不确定——**改成轮询等待元素出现（最长等 8-15 秒）而不是"睡一下就点一次"**之后，全自动跑通。

**已修复的缺陷（原先记录为"已确认的剩余缺陷"，现已定位、修复并重新实测确认）**："忙闲判断"最初用的是"聊天容器渲染文本长度是否停止变化"这个启发式，被证明**会误判**——Claude Code 的忙碌提示是"某个词 + …"这种转圈文案（这次撞见了"Channelling…"），如果文案本身长度暂时没变化，长度就会"看起来"已经稳定，`wait_idle` 因此提前判定为"闲"，读到的其实还是忙碌状态而不是最终回复。**修复方式**：改成对比完整文本内容而不是只比较长度（转圈文案前面的动画符号 ✻✶✢✽ 等每一帧都不同，完整文本对比能正确识别"还在变"），并且额外加一道防御性检查——只要最近一次读到的文本还匹配 `/\w+ing(…|\.\.\.)/` 这个忙碌文案的结构性正则（和 CLI 那边 `\wing…`/`for \d+s` 是同一个思路），就不判定为"闲"，就算文本内容碰巧连续两次静止不变也不会误判。**修复后重新实测**：连续观察到"ciphering..."→"Generating..."→"Scheming..."三种不同忙碌文案都被正确识别为"还在忙"，最终正确等到真实回复（问"234×567"，正确读到"132678"）。

**生产环境建议 —— 已经落地，不再只是建议**：预先准备好一个已经完成引导的"模板" `--user-data-dir`，每个任务复制一份使用；引导只需要在搭建模板时做一次。这个模板已经真实搭建在 `modules/file_vault/data/vscode_profile_template/`（该目录已被 `.gitignore` 里的 `modules/file_vault/data/` 规则整体排除，不会进 git，308MB 左右，都是 VS Code 自身的缓存/状态文件）。

**搭建过程中一个重要的、意料之外的发现**：搭建模板时，以为还需要手动登录 Claude Code 这一步（用户账号认证），结果**完全不需要**——首次运行的引导弹窗里"Sign in"的对象是 GitHub Copilot（VS Code 自带、跟 Claude Code 完全无关的另一个产品），点"Continue without Signing In"跳过就行；Claude Code 自己的身份认证是**从这台机器已有的凭据继承来的**（跟 `claude` CLI 共享同一套认证，不绑定 VS Code 的 profile），所以一个全新、从未打开过的 profile 照样能直接对话，完全不需要人工介入登录这一步。这意味着搭建模板全程都可以自动化完成，不需要用户手动做任何登录操作。

`vscode_cdp_driver.js` 的 `launch` 命令新增了 `templateUserDataDir` 参数：如果给了这个参数，且目标 `userDataDir` 还不存在，会先把模板整个复制过去（顺带删掉复制来的 `code.lock` 文件，否则 VS Code 可能误以为这个刚复制出来的目录已经被另一个实例占用）再启动。**实测确认**：从模板复制出来的全新 per-task profile，第一次尝试就直接找到了聊天 webview（`connectToWebview` 第 1 次就成功，不像从零开始的全新 profile 那样要经历完整的三步引导轮询），整个 `launch` 只用了 36 秒。

**一个小的、非阻塞性的观察**：因为是整个目录复制，per-task profile 会连模板自己测试用的对话历史一起复制过去（这次实测里，新 profile 打开后聊天记录里还留着模板搭建时测试用的"VERIFIED"那条对话）。这不影响功能，只是历史记录不够"干净"——如果介意，可以在模板搭建完之后手动清一次 Claude Code 的会话历史，不影响这个机制本身的有效性。

**第一轮踩过的坑（供后续参考，问题已在第二轮解决）**：

1. 按 CSS class 猜测选择器（`.interactive-input-editor` 等）没找到正确元素，点到了工具栏上的一个不相关按钮——根因是压根没连到 webview 自己的 CDP target 上，见上文的"关键突破"。
2. 换成读取截图里输入框的像素坐标、按设备缩放比例（DPR 1.25）换算成 CSS 坐标再点击，点击后 `document.activeElement` 依然不是输入框本身——同样是因为点在了主页面上，而输入框在 webview 里。
3. **一个值得记录的风险发现，依然成立**：在焦点没有落到文本框的情况下继续发送按键事件，这些字符被 VS Code 当成了全局快捷键处理，其中某个键把整个聊天面板关掉了——证实了"必须先确认真正获得输入焦点，再发送文字"不是可以跳过的步骤，盲发按键在焦点不对时有实际的破坏性副作用。

### 由此解锁的新创新点

1. **会话复用 + 原生 `/compact` 代替进程重启（本轮最大的 token 优化）**：同一任务全程只维持一个交互会话，每个 story 作为这个会话里的新一轮"人类消息"通过拟人化输入层发送。会话内的多轮对话可以享受 Anthropic 的 prompt cache（5 分钟 TTL 内复用系统提示、工具定义等固定前缀的缓存），比"每个 story 都重启一次性进程、每次都要重新缴一遍固定开销"省下这部分重复计费。当"上下文健康度探测"（沿用第一版设计里的漂移探测思想：定期检查模型对当前架构的理解是否还准确）判断确有必要清空时，**不杀进程**，而是像真人一样敲一条 `/compact`（或必要时 `/clear`）消息——这是 Claude Code 自带的、专门为控制上下文体积设计的原生能力，比"杀进程+冷启动+重新灌注结构化记忆全文"更便宜，也更贴近"像真人"的新约束（真人会自己说"我们先整理一下之前聊的"，不会凭空失忆重来）。
2. **按 story 类型做双引擎路由，提升准确性**：拆解阶段现在除了给每个 story 建议 `model`/`effort`，还建议 `engine`（`cli` 或 `vscode`）。需要强 IDE 上下文的 story（跨文件重构、需要代码库符号索引/inline diff 辅助判断的改动）路由到 VS Code 插件引擎——真实 IDE 环境里模型能看到的上下文更贴近人类开发者实际工作时的视角，减少"看错文件/漏看引用"这类错误；边界清晰、自包含的小 story 路由到 CLI 引擎，起停更快，不需要占用一个 IDE 窗口。
3. **非阻塞屏幕快照代替纯 marker 文件轮询，提升准确性**：`ReadConsoleOutput`/CDP 的一次性查询能力，让引擎可以比"完全没有能见度、只能傻等 marker 文件"更早、更细粒度地判断当前状态（比如识别到权限确认对话框、识别到 Claude 提了个澄清问题），及时反应而不是干等一整轮。**明确不是**重新引入当年导致死锁的 PIPE 持续捕获——这里全部是一次性查询，用完即扔，没有"没人排空的缓冲区"这个死锁根因。
4. **分段提交，复刻真人"先说清楚要求、再补充细节"的沟通习惯**：验收标准和任务正文可以拆成两条消息依次发送（而不是一次性甩一段长 prompt），第一条发完后用 `is_idle()`/屏幕快照确认 Claude 是否已经开始跑偏理解，尽早发现理解偏差再决定是否要补一条澄清，比"一次性发完整段、等一整轮跑完才发现理解错了"更早止损，省下的是"跑错方向"这部分的无效 token。

### 新增数据结构/接口

- `stories.json` 每个 story 新增 `suggested_engine` 字段（`cli` / `vscode`），拆解阶段一并给出。
- `modules/file_vault/js/vscode_cdp_driver.js`（已实现并实测跑通，见上文）：NDJSON 协议（`launch`/`send_message`/`wait_idle`/`read_screen`/`exit`），`launch` 内部完成"起隔离 VS Code → 走三步首次引导 → 点开 Claude Code 面板 → 新建会话"全流程。
- `modules/file_vault/human_like_driver.py`：目前封装的是 `js/pty_driver.js`（CLI 引擎，已接入 `task_engine.py` 主线，见上文"实现状态（已接入主线）"）。`vscode_cdp_driver.js` 走的是同一个 NDJSON 协议风格，但**尚未**接入 `human_like_driver.py`/`task_engine.py`——它目前是独立验证过、可通过其 NDJSON 协议直接调用的组件，双引擎路由（`suggested_engine` 字段驱动选择走 CLI 还是 VS Code）还没有实现，是这之后的下一步。
- `meta.json` 新增 `session_mode: "persistent"`（区别于第一版假设的"逐 story 重启"），以及 `last_compact_at`（记录上次触发 `/compact` 的时间/story 序号，供健康度探测判断下次何时该压缩）。

### 风险与新增约束

- **（已解决）CLI 可靠提交消息**：见上文"CLI 终端实现"——两次独立真实测试确认"就绪检测（静默+最小字节数）+ 打字与回车分两次写入 + 忙闲状态正则匹配"这套协议能可靠跑通"发消息→收到回复"。
- **（已解决）VS Code 可靠提交消息 + 全自动引导**：见上文"VS Code 插件实现"——从完全空白的新 profile 到发消息收回复，全流程自动化验证通过。
- **（已修复）VS Code 侧的忙闲检测假阳性**：纯"渲染文本长度是否停止变化"的启发式在忙碌文案长度暂时不变时会误判为"已空闲"，已改成"完整文本比对 + 忙碌文案结构性正则兜底"两层修复，重新实测确认能正确识别多种不同忙碌文案（"ciphering..."/"Generating..."/"Scheming..."）并等到真实回复。
- **（已修复）"New session"点击目标位置错误**：最初把它当成主页面 DOM 的一部分搜索，实际它和聊天输入框一样活在 Claude Code 自己的 webview 里——只在复用已有对话历史的 profile 时才会暴露（全新 profile 可能直接落在空白对话、这一步等于没做也不出错），已修复为在 webview target 里按钮 class 精确查找。
- **（仍是未解决问题）CLI 侧读取回复内容的干净度**：目前用正则粗暴剥离 ANSI 转义序列，会把文字间的空格/换行搞乱，只能验证"回复里包含了某个关键词"级别的粗粒度判断，不足以拿来做需要精确文本的场景（比如把回复内容原样存进结构化记忆记录）。需要换成真正的终端模拟器库（如 `xterm-headless`）维护虚拟屏幕缓冲区再读取，这是明确的下一步实现任务，不是未知风险。
- "信任此文件夹"确认框（CLI 侧）在部分测试中出现、部分测试中没出现（怀疑与父目录是否已被信任过有关，具体范围规则未验证清楚）——driver 必须两种情况都能处理，不能假设它一定会/不会出现。
- 中文等非 ASCII 字符、VS Code 侧的连续多轮对话可靠性，仍未实测验证，是下一步需要补测的具体场景。
- **（2026-07-12 已定位并修复）`/compact`/`/model` 在 CLI 侧真实多轮场景下会挂死**：这条风险原本只是"未验证"，实测证实确实是个真 bug——`js/pty_driver.js` 的 `waitIdle()` 硬性要求先匹配到 busy/done 转圈标记（`BUSY_RE`/`DONE_RE`）才判定为闲，但 `/model`/`/compact` 这类 slash 命令是本地立即确认，根本不会经过"思考中"转圈阶段，导致 `wait_idle()` 对这类消息永远等不到"闲"，只能一直空等到 `timeout_ms`（重试换模型场景默认 120s，`/compact` 默认 60s）——由于"重试多样性"从第 2 次尝试起必然触发换模型，这个 bug 在几乎每一次失败重试上都会复现，是"自动任务无法正常使用"最主要的直接原因。已修复：`sendMessage()` 记录本次发送的是否是 slash 命令，`waitIdle()` 对 slash 命令改用"有任意回复 + 静默"这个更宽松、也更符合其"本地立即确认"本质的闲置判定，普通对话轮次的 busy/done 标记判定逻辑不变。回归测试：`test_human_like_driver.py::test_send_message_slash_command_resolves_idle_without_busy_marker`。VS Code 引擎的 `vscode_cdp_driver.js` 用的是不同机制（"文本静止 + 当前不匹配 busy 正则"，不要求先见过 busy 标记），不受此 bug 影响。
- VS Code 引擎路径要求为该任务专门起一个独立的 VS Code 窗口/profile，不能复用用户日常正在用的窗口/账号——**这不只是为了避免自动化按键和用户操作打架，更关键的是安全边界**：`--remote-debugging-port` 打开的是一个未经身份验证的本地 CDP 控制通道，对着用户真实登录的日常 profile 开这个端口，等于把其真实会话暴露给任何能连上这个端口的程序；而且实测确认，如果用户日常 VS Code 已经在跑（同一个 profile），VS Code 的单实例锁机制会导致新窗口的 `--remote-debugging-port` 参数根本不生效（请求被转发给已经在跑的旧进程，而旧进程启动时没带这个参数，调试端口不会重新生效），所以就算想用日常账号也大概率连不上。已经落地的解法是"隔离 profile + 预先搭好的已引导模板"（见上文），而不是复用真实账号。
- 键盘/按键事件注入本质上是"模拟真实用户操作"去驱动 Claude Code CLI 和 VS Code 插件，具体到 Claude Code 的使用条款是否对这类自动化有限制，需要用户自行确认这属于个人自动化用途；本设计只解决技术可行性，不代表对使用条款的判断。
- VS Code 插件目前的完成信号检测（`check_task_done_marker` 那套 marker 文件思路）是否也适用于 VS Code 引擎的工作目录，还没有验证——目前 `wait_idle` 是唯一的完成信号来源，marker 文件思路是否需要/能够移植过来，留待接入双引擎路由时再确认。
- **（2026-07-12 已定位并修复）持久 CLI 会话从未传 `--dangerously-skip-permissions`**：`run_story_cycle`（一次性路径）一直有传，但会话复用路径（`human_like_driver.HumanLikeCliDriver.spawn`/`js/pty_driver.js`）完全没有——意味着模型任何一次真实工具调用（写文件等）都会撞上没人能回答的交互式权限确认框，会话就此静默卡死，直到 `wait_idle` 超时。已修复：`pty_driver.js` 的 `spawn` 新增 `dangerouslySkipPermissions` 参数会拼接该 flag；`human_like_driver.py`/`backend_server.py` 依据 `meta["autonomy_mode"]`（与一次性路径完全相同的判断表达式）透传。VS Code 引擎目前没有对应机制（插件自身的权限/信任处理还没有针对真实会话验证过），是明确的已知缺口，不是"假设没问题"。回归测试：`test_human_like_driver.py::test_spawn_with_dangerously_skip_permissions_passes_the_real_flag`（真实验证 argv 落地，不只是 Python 层声称传了）。
- **（2026-07-12 已定位并修复，真实环境实测坐实）CLI 侧信任对话框分段渲染竞态 + ANSI 剥离把空格挤没导致正则永远不命中**：真实环境（配置了 17 个 MCP server/5 个 hook）里，`claude` 首次启动时的信任确认对话框会分两段渲染（先出说明文字，隔一段时间才出"Enter to confirm"选项行），原 `spawn()` 只在第一次静默期后检查一次，经常在选项行还没渲染出来时就误判"已就绪"，导致后续真实消息被静默丢进一个还开着的 Y/N 选择框（只认 Enter/数字键，不认自由文本），下一次 Enter 反而把对话框的默认选项当成"确认"点掉，用户消息从未真正发出——这一步用隔离复现脚本坐实，且证实与语言无关（中文、英文都触发）。第一版修复（onData 反应式重试确认 + `_waitForReady` 拒绝在检测到对话框时判定就绪）本身逻辑没错，但用真实 CLI 复测仍然失败——根因是**第二个、更隐蔽的 bug**：`stripAnsi` 对分开重绘的文字片段会把空格整个挤掉（这本身是设计文档早就记录过的已知局限，例子是"Hi! How can I help you today?"被挤成"Hi!HowcanIhelpyoutoday?"），但当时只把这个局限当成"读回复内容不够干净"的问题，没意识到它同样会让**用来匹配对话框/完成标记的正则失效**——`CONFIRM_PROMPT_RE`（原 `/enter to confirm/i`）和 `DONE_RE`（原 `/for \d+s\b/`）都要求字面空格，但真实渲染出来的是"Entertoconfirm"/可能出现的"for9s"，永远不匹配。两个正则都改成 `\s*`（零或多个空白）后，用真实 `claude` CLI 重新测试：中文消息完整送达并收到正确回复（问东京是哪国首都，正确答"日本"），`wait_idle` 在 10 秒内正确判定为闲（此前一直空等到超时）。回归测试：`test_human_like_driver.py::test_spawn_survives_a_split_rendered_trust_dialog`（fixture 特意模拟无空格的挤压格式，而不是理想化的带空格格式——这正是第一版修复的测试为什么"看起来通过了"却在真实 CLI 上完全不生效的原因）。
- **（2026-07-12 部分修复，仍有未解释的残留问题）VS Code 引擎的自动引导序列浪费大量时间预算**：真实测试发现 `_bootstrapToChat` 无条件跑三次"关闭首次引导弹窗"点击尝试（每次找不到就等满 8000ms 超时），但只要 `userDataDir` 是从模板复制来的或本来就存在（生产环境的唯一使用方式），这三次点击**必然**是空跑，白白浪费掉 24 秒——叠加 Claude Code 面板自身嵌套的"active-frame" webview 需要的真实初始化时间，导致完整流程在预算耗尽前来不及等到 webview 完全就绪（通过手动、不赶时间的点击复测确认了点击机制本身没问题，纯粹是时间预算不够）。已修复：`launch()` 计算 `skipOnboardingDismiss`（`userDataDir` 已存在，或提供了有效的 `templateUserDataDir`，两者之一即为真——这覆盖了生产环境的唯一实际用法），为真时跳过整个 Step 1；同时把 webview-attach 重试循环的预算从 60000ms 独立提升到 90000ms（`WEBVIEW_ATTACH_TIMEOUT_MS`）。**但**：应用这个修复后的第二次真实端到端测试遇到了一个不同的、尚未解释的问题——VS Code 主进程在启动约 6 分钟后自行发起了一次干净关闭（`extension host exited with code 0`，日志里找不到任何明确的关闭触发点，中间有 5 分钟完全没有日志活动），驱动进程随后卡在一个没有超时保护的等待上，需要手动杀掉。不确定是本机环境干扰（本机同时有用户自己的 VS Code 实例、大量扩展和 MCP server 在跑）还是驱动本身的问题，**没有进一步排查**——记录在这里作为下一次迭代的明确起点，而不是当作"已解决"。下一步排查建议：(a) 给 `_connectToWebview`/`launch` 里所有 `fetch`/CDP 请求加显式超时（目前完全没有，任何一次网络调用卡住都会导致整个驱动进程无限期挂起，这本身就是独立于"VS Code 为什么关闭"之外的一个真实健壮性缺口）；(b) 在一台没有额外 VS Code 实例/扩展干扰的机器上复测，排除环境干扰这一变量。

## 数据结构变更

### 新增文件（每个任务目录内，与现有 `meta.json.enc`/日志同级）

| 文件 | 内容 | 是否加密 |
|---|---|---|
| `stories.json` | 拆解产物：story 列表，含 `id/description/acceptance_criteria/depends_on/suggested_model/suggested_effort/suggested_engine/status` | 是，复用 `task_store.py` 现有的单 blob AES-256-GCM 模式 |
| `memory.jsonl` | 结构化记忆记录，见上 | 是，同上 |

### `meta.json`（现有加密 blob）新增字段

| 字段 | 说明 |
|---|---|
| `decompose_mode` | bool，是否启用本设计描述的新模式 |
| `test_command` | 用户在任务创建时显式提供的测试/编译命令（可留空） |
| `current_story_id` | 当前正在跑的 story id |
| `failure_streak` | 当前 story 的连续失败计数，达到阈值触发熔断 |
| `story_attempt_count` | 当前 story 累计尝试次数，达到"重试多样性"规则（第 2 次起换 model/角度）的判断依据 |
| `story_budget_spent` | 当前 story 已消耗的调用次数/时间，达到预算即熔断（与 `failure_streak` 是两条独立的熔断触发条件） |
| `memory_record_count` | `memory.jsonl` 当前条数，达到压缩阈值时触发一次记忆压缩 |
| `session_mode` | `"persistent"`——标记这个任务的会话按"拟人化输入层 + 会话复用"一节所述持续存在，不逐 story 重启 |
| `last_compact_at` | 上次通过拟人化输入层模拟发送 `/compact` 的时间/story 序号，供上下文健康度探测判断下次何时该压缩 |

现有字段（`status`/`worktree_path`/`autonomy_mode` 等）不变，`decompose_mode=false` 时行为与现状完全一致。

## 新增/变更的 RPC

| 方法 | 说明 |
|---|---|
| `task_create` | 新增可选参数 `decompose_mode`、`test_command` |
| `task_get_stories(task_id)` | 返回 `stories.json` 内容供 UI 渲染看板 |
| `task_get_memory(task_id)` | 返回 `memory.jsonl` 供 UI 展示"这个任务学到了什么" |
| `task_story_retry(task_id, story_id)` | `BLOCKED_NEEDS_REVIEW` 时用户人工介入后手动重试该 story |
| `task_story_takeover(task_id, story_id)` | "自动闭环 ⇄ 可见终端"切换：把指定 story 转交给 `launch_in_visible_terminal`，用户处理完后手动标记 passed，调度器继续 |

其余现有 RPC（`task_list`/`task_review_diff`/`task_merge`/`task_discard` 等）语义不变，`decompose_mode` 的任务最终同样落在 `DONE_PENDING_REVIEW`，走同一套审阅/合并/丢弃路径。

## UI 改动

- **TaskListScreen**：`decompose_mode` 的任务卡片新增进度徽标，如"3/8 story 完成"。
- **TaskDetailScreen**：新增一个"Story 看板"标签页——按 `pending/ready/running/passed/failed/blocked` 分列展示 story；点开单个 story 可看到它那一轮的 prompt、diff、测试输出摘要（归一化后的，不是原始超长日志）、写入的记忆记录。`BLOCKED_NEEDS_REVIEW` 的 story 高亮显示 + "重试"按钮（调用 `task_story_retry`）。

## 与 `core/` 的集成

- 沿用 `core.logging.get_logger` 记录调度决策（选中哪个 story、为什么、记忆检索命中了哪几条、选了哪个 engine）。
- 用户项目的测试命令通过与 `core.proc.run_command` 同样的思路调用（`capture_output=True` 的普通 `subprocess.run`，这类调用不涉及 `claude` 交互进程，不受本文开头提到的死锁约束）。
- CLI 引擎的拟人化输入最终没有用最初设想的 `WriteConsoleInput`/`ReadConsoleOutput`（Windows Console API + `ctypes`），而是改用了 `node-pty`（见上文"CLI 终端实现"的实测结论）——`human_like_driver.py` 通过 `subprocess.Popen(["node", "js/pty_driver.js"])` 调用，NDJSON 协议。VS Code 引擎的 CDP 自动化脚本 `js/vscode_cdp_driver.js` 同样遵循 `modules/README.md` "多语言模块"约定，同一套 NDJSON 协议风格，但目前是独立可调用的组件，还没有被 `human_like_driver.py` 统一封装成同一个接口——双引擎路由（`task_engine.py` 不关心具体引擎，只面向统一接口编程）是尚未做的下一步，不是已完成的现状。

## 范围之外（本次不做）

- 真正的向量检索/embedding 记忆库（先用规模阈值 + 标签匹配，规模问题真正出现再升级）。
- 语义级失败聚类（先用归一化文本哈希）。
- 自动推断用户项目的测试命令（不同语言/框架差异太大，第一阶段必须用户显式提供，留空则跳过测试闭环、退化为跑完即等人工审阅）。
- 多 story / 多任务并行执行（沿用现有"同一时间只跑一个 RUNNING 任务"的约束，不新增并行 worktree）。
- 修改现有默认模式的任何行为——`decompose_mode` 默认关闭，是纯新增分支，不影响现状用户体验。
- 独立的"复杂度分类"模型调用（分级路由复用拆解阶段的建议，不额外花 token）。
- 记忆压缩的合并算法只做"简单聚类 + 一次 LLM 归纳调用"，不做更复杂的层次化摘要或多轮迭代压缩。
- 重试多样性只做"换 model / 换 prompt 切入角度"两种变化，不引入采样温度调节或多候选并行生成再择优（后者的 token 成本本身就违背本设计的省 token 目标）。
- 影子验收员不覆盖"需要真正运行环境才能判断"的验收标准（比如性能基准）——这类仍然依赖 `test_command`，影子验收员只兜底"没有测试命令，或测试命令覆盖不到的主观标准"这一类场景。
- 不做"完整解析 Claude Code/VS Code 插件内部对话协议"——拟人化输入层只做"发消息 + 读取表面文本/状态"这一层，不逆向实现一个完整的客户端协议。
- 不支持 `WriteConsoleInput`/CDP 之外的自动化后端（比如前台 `SendKeys` 模拟）——只作为设计里提到的备选思路，不在本轮实现。
- VS Code 引擎不复用用户日常窗口，因此也不做"检测并接管用户已经开着的 VS Code 窗口"这类更复杂的场景，第一阶段只支持为任务专门新起窗口。

## 风险与未决问题

- 拆解阶段的 JSON 输出格式依赖 prompt 里的 few-shot/schema 约束，需要在实现前先用真实 `claude -p` 调用验证输出稳定性，而不是凭猜测定 schema。
- "用户项目测试命令"这件事第一阶段必须用户显式填写，UI 上要给清晰引导（允许留空并明确告知留空的后果：跳过自动验证闭环）。
- 失败签名归一化的具体规则（去掉哪些内容算"易变"）需要在实现阶段用几个真实失败样本反复调整，避免把"同一个坑"误判成"从未见过"或反过来。
- 需要评估：一次性 `claude -p` 调用（无交互权限确认）配合 `--dangerously-skip-permissions` 是否在所有已支持的自主边界组合下都安全——这一点应延续现有引擎已经做过的判断，不在本设计里重新讨论。
- 影子验收员本身也可能误判（假阳性放行、假阴性打回）。因为它用的是最小模型 + 极小上下文，误判成本远低于跑一次完整测试套件，属于可接受的权衡，但需要在实现后观察真实误判率，必要时调整"多严格才打回"的判断口径。
- 记忆压缩调用本身也要花一次 token，但低频触发（默认 100 条才触发一次）+ 换来的是后续每个 story 注入量的持续下降，需要在实现后用真实数据验证这笔"投入"确实能被"收益"覆盖，而不是想当然。
- 重试多样性"换 model"这一步要确保不会误换成一个用户明确不想用的模型（比如任务创建时用户手动指定了固定 model 覆盖建议值的情况下，重试多样性应该只切换"prompt 切入角度"，不覆盖用户的显式模型选择）。

## 验证方式

- 单元测试（比照现有 `tests/test_task_engine.py` 的 mock 思路）：mock `claude -p` 的文件重定向输出（用假脚本替代真实 CLI），覆盖拆解 JSON 解析成功/失败两条路径、DAG 环检测、调度器选择逻辑、失败签名匹配、熔断阈值触发（含失败次数和 token/时间预算两条独立触发路径）、重试多样性的 model/角度切换逻辑、记忆压缩阈值触发。
- `test_task_store.py` 风格的往返测试：`stories.json`/`memory.jsonl` 的加密写入/读取。
- `human_like_driver.py`（CLI 引擎）：用一个模拟交互式 CLI 的测试夹具（`tests/fixtures/fake_interactive_cli.py`）跑通了 4 个单测（不需要真的起 `claude` 会话），随后又用正式代码对真实 `claude` 做了端到端确认（见上文）。
- `vscode_cdp_driver.js`：**没有走"假 HTML 页面模拟 webview"这条路**，而是直接对真实、隔离的 VS Code + 真实已装的 Claude Code 插件做了端到端验证（见上文"VS Code 插件实现"）——因为 webview 的两层嵌套 execution context、`contenteditable="plaintext-only"` 这类具体结构，很难在一个手搭的假 HTML 页面里准确复现，真机验证反而更直接可信。目前没有不依赖真实 VS Code 的单元测试覆盖这个脚本，这是一个已知的测试空白（真机验证的可重复性依赖本机环境，不适合放进 CI）。
- 手动验证：用一个小型玩具仓库跑一次完整的 PRD 拆解闭环，人工确认 story 拆解合理性、执行顺序、记忆记录内容、最终 diff 质量、影子验收员的判断是否合理，`BLOCKED_NEEDS_REVIEW` 熔断触发后"人工介入"与"一键切换可见终端接管"两条路径都可用；额外手动验证拟人化输入层在真实 CLI 终端和真实 VS Code 插件上逐字符输入中文任务描述、`/compact` 触发、双引擎路由是否都按预期工作（中文输入、`/compact`、双引擎路由这三项截至目前仍未验证，见风险清单）。

## 实施建议（供后续 writing-plans 参考）

建议分阶段交付并逐阶段手动验证（已完成的阶段标注了状态）：

1. ✅ 拆解阶段（`claude -p` 文件重定向 + JSON schema 校验 + 兜底退化逻辑）——已实现并测试。
2. ✅ 调度器（DAG 校验 + 拓扑排序 + 就绪队列选择）——已实现并测试。
3. ✅ 执行 + 验证闭环（一次性 story 执行 + 测试命令调用 + commit）——已实现并测试（`run_story_cycle`）。
4. ✅ 失败签名 + 记忆记录 + 熔断——已实现并测试。
5. ✅ UI（Story 看板 + 新 RPC）——已实现（`task_decompose_mode_step`/`task_get_stories`/`task_get_memory`/`task_story_retry` + `StoryBoard.tsx`）。
6. ✅ `human_like_driver.py` 的 CLI 实现（改用 `node-pty`，不是最初设想的 `WriteConsoleInput`/`ReadConsoleOutput`）——已实现、测试，并已接入 `task_engine.run_story_cycle_persistent`/`prd_loop_runner.step`/`backend_server.py` 的会话复用 + `/compact` 主线。
7. ✅ VS Code 引擎的 CDP 自动化脚本（`vscode_cdp_driver.js`）——已实现并端到端验证通过（含全新 profile 的自动首次引导）。
8. ✅ VS Code 侧忙闲检测的假阳性——已修复并重新实测确认（见上文）。
9. ✅ VS Code 已引导模板 profile——已实际搭建在 `modules/file_vault/data/vscode_profile_template/`，`launch` 新增 `templateUserDataDir` 参数支持"复制模板再启动"，实测从模板复制出的全新 per-task profile 一次成功、36 秒完成，不再需要每次都走三步引导轮询。
10. **尚未做**：VS Code 引擎接入 `human_like_driver.py`/双引擎路由——`vscode_cdp_driver.js` 目前是独立可用的组件，还没有被统一封装进 `task_engine.py` 面向的那个通用驱动接口，也还没有让调度器真的按 `suggested_engine` 字段在两个引擎之间路由；这一项应该同时把 `templateUserDataDir` 的路径接成配置项（比如放进 `meta.json` 或模块级配置），而不是每次调用方手写路径。
11. **尚未做**：CLI 侧回复文本的干净读取（改用真正的终端模拟器库）、中文输入验证、`/compact`/`/model` 在真实多轮场景下的可靠性验证。
