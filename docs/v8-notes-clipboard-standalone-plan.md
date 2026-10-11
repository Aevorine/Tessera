# v8 技术方案与原理：递归分类 / 字体 / 位置记忆 / 大文件 / 图标标签 / 置顶拖拽 / 独立 EXE

**状态：阶段 1–7 代码全部完成（2026-07-27）。阶段 7 的产物构建必须在 Windows 上执行，见 `docs/standalone-exe-release.md`。**

## 已完成（阶段 7：独立 EXE + 签名更新）

| 阶段 | 内容 | 主要改动 |
|---|---|---|
| 7a | 资源解析层 + 数据目录迁移 | `runtime_resources.py`（dev/`_MEIPASS` 分流）；`data_dir.py`（LOCALAPPDATA + 跨进程锁 + SQLite backup API + 白名单 + 原子改名 + 完成标记 + keyring 预检 + 绝不删旧目录）；`backend_server` 接入 |
| 7b | 两个冻结目标 + 打包 | `packaging/file_vault_backend.spec`（one-file）、`packaging/file_hook_worker.spec`（one-dir）；`electron-builder` extraResources 改打冻结产物；`main.ts` 已打包模式不再从 PATH 找 python，也不再写死仓库数据路径 |
| 7c | Ed25519 签名验证 | `updateManifest.ts`（原始字节验签、严格解析、拒绝重复键/未知字段、资产名安全检查、轮换链验证）+ `updateService.ts`（GitHub 严格校验、重定向落点校验、流式哈希、下载上限、公钥环原子持久化） |
| 7d | 独立 runner + 回滚 | `updateRunner.ts`（等主进程退出、二次校验、版本化保留旧 EXE、原子替换、健康回执、超时回滚）+ `updateInstaller.ts`（按哈希部署 runner 到稳定目录、`PORTABLE_EXECUTABLE_FILE` 解析） |
| 7e | 设置页更新区 | preload 四个不带路径/URL 参数的 IPC；设置页版本/自动检查开关/手动检查/立即更新/进度/失败原因；六语言 |
| 7f | 发布工具链 | `generate-update-key.mjs`、`sign-manifest.mjs`、`build-standalone.mjs`；版本 0.1.0；`docs/standalone-exe-release.md` |

**单元测试抓到的一个致命 bug**：`verifyDetachedSignature` 里用 `require('node:crypto')` 取 `createPublicKey`——ESM 下 `require` 不存在，抛出的 `ReferenceError` 被 catch 吞掉，于是**每一次验签都静默返回 false**。后果不是"不安全"而是"更新完全用不了"，但它的表现（所有更新都报签名无效）极易被误诊成密钥配错，进而诱使人去放宽验签——那才是真正危险的地方。改成顶层静态 import，测试第一条就是它。

**验证**：24 个签名/轮换用例全过（含篡改字节、未知签名者、重复键、路径穿越资产名、断链、keyId 冲突）；18 个迁移用例全过（含"WAL 里未 checkpoint 的数据也要搬到"）；`pytest` 987 passed；electron/ 与所有改动过的 src 文件 `tsc --noEmit` 通过；六语言 key 一致。

## 已完成（阶段 6：性能加固）

| 阶段 | 内容 | 主要改动 |
|---|---|---|
| 6a | 大文件 FTS 只索引前 2MB | `_FTS_INDEX_MAX_BYTES = 2MB`；新增 `_bounded_content` 对三种存储形态（disk_plain / encrypted_db / 分段）统一做有界读取；`_truncate_to_bytes` 按字节截断且不切出半个字符；`note_get` 回传 `fts_truncated` / `fts_indexed_bytes`，详情页顶部标注提示 |
| 6b | 位置记忆加固 | `positionMemory` 加进程内缓存（不再每次 `getPosition` 都 parse 整份状态）；新增 `applyScrollRatio` 走 `view.requestMeasure()`，修掉 3 处「dispatch 之后立刻读 scrollHeight」 |
| 6c | 性能回归基准 | 新增 `tests/test_notes_large_note_perf.py`：断言读段/写段/统计段数/分类摘要在 4 倍数据量下不退化成 O(N) |

**这一阶段改掉的两个真实缺陷**（都不是新写的代码，是既有实现里的）：

1. **超限笔记的正文基本搜不到**。原实现里超过 8MB 的笔记只把 `preview`（几百字符的开头摘要）写进 FTS。改成索引真正的前 2MB 之后，阈值降低了，但超限笔记实际可搜的内容多了三个数量级。同时超限时的读取也改成有界——原来走 `_normalize_note_row` 会把整篇（可能几百 MB）读进内存再丢掉绝大部分。

2. **恢复滚动位置「时灵时不灵」，笔记越大越不灵**。三处代码在 `view.dispatch()` 之后同步读 `scrollDOM.scrollHeight`。CodeMirror 把 DOM 读写分成 measure/update 两个阶段，此刻拿到的是**上一次布局**的高度；文档刚被整篇替换时旧布局往往是空的，`scrollHeight - clientHeight ≤ 0`，算出来的 scrollTop 就是 0。改用 `view.requestMeasure()` 在布局完成后的读阶段取高度。用它而不是 `setTimeout`/`rAF` 猜延迟：猜的延迟在慢机器或大文档上仍会偏早，且没有任何信号告诉你偏早了。

**关于性能测试为什么不断言绝对毫秒数**：绝对耗时取决于跑测试的机器，那种断言注定变成随机失败然后被加 skip。改成断言**复杂度**——同一操作在 4 倍大的笔记上不该慢 4 倍。当大规模一侧本身低于 2ms 时直接判定通过：在 4MB 数据上做一遍 O(N) 的读取/解密绝不可能在 2ms 内完成，所以「低于 2ms」和「是常量时间」在这里等价，只是更抗噪的表述。

**遗留大笔记的迁移**：确认已由 `open_segment_session` 的惰性转换覆盖（`count == 0` → `_convert_legacy_note_to_segments`），不需要额外的后台迁移。代价是老的大笔记第一次打开时要现付一次转换，这一点在 `_EAGER_SEGMENT_THRESHOLD_BYTES` 的注释里已有说明（新导入的大笔记在导入阶段就转好，不会有这个问题）。

## 已完成（阶段 4–5：递归分类补完）

| 阶段 | 内容 | 主要改动 |
|---|---|---|
| 4a | 路径校验 + 父路径自动补建 | 新增 `notes/category_paths.py`（纯字符串逻辑，零内部依赖）：严格校验（禁空段、单段 60 字、深度 16 层、整路径 255 字）、祖先拆解、带层级边界的子孙判定、子树 rebase、循环检测。`create_category` 幂等补建每一级父分类 |
| 4b | 两种删除语义 + 子树重命名/移动 | `category_impact` 影响范围预览；`delete_category(mode='promote'\|'cascade')`；`rename_category` 一个事务内前缀替换 `categories.name` 与 `notes.category` 并重建 FTS；新增 `idx_notes_category` 索引 |
| 4c | RPC + 前端确认框 | `note_category_impact` / `note_category_rename`；分类管理行加重命名按钮；删除时弹框列出「N 个子分类、M 篇笔记」并给两个语义按钮 |
| 5 | 分类器路径分段打分 + 回溯重分类 | `classify` 按 `/` 拆段打分（叶子满权重、父段 ×0.25）；`reclassify_preview` / `reclassify_apply` 两步式，带乐观并发校验 |

**验证结果**：`tsc --noEmit` 通过；eslint 0 warning；六语言 i18n key 一致；`pytest` 959 passed（同样的 2 个 Windows 专属失败）；新增 72 个用例（`test_category_paths.py` 25、`test_notes_category_tree.py` 22、`test_notes_classifier_paths.py` 10、`test_notes_reclassify.py` 15）。

**一处刻意的破坏性契约变更**：`delete_category` 原本只删 `categories` 表那一行、完全不碰笔记（表注释里写明的设计）。那在扁平分类下说得通，但多级分类下会留下一批指向已不存在路径的笔记——它们在分类树里既不属于任何节点、又不是未分类，用户在 UI 上根本点不到，等于凭空消失。现在必须显式选 promote 或 cascade，两种都不留悬空引用。旧测试 `test_delete_category_removes_only_the_catalog_entry_not_note_data` 已按新契约重写并注明原因。

**测试抓到的一个崩溃点**：`reclassify_apply` 的入参是预览列表经过前端（用户可剔行）再传回来的，原实现直接 `change.get(...)`，一个非字典元素就能让整个 RPC 抛 `AttributeError`。已加 `isinstance` 守卫 + 回归测试。

## 已完成（阶段 1–3）

| 阶段 | 内容 | 主要改动 |
|---|---|---|
| 1a | labelMode 偏好层（全局默认 + 区域覆盖） | 新增 `ui/src/lib/labelMode.tsx`，挂在 `AppShell` 的 provider 里 |
| 1b | `ActionButton`（图标 + 文字 + Tooltip 三合一） | 新增 `ui/src/components/ActionButton.tsx`；替换掉剪贴板行内 7 个按钮和笔记批量操作 6 个按钮的裸 `aria-label` |
| 1c | IconToolbar 接入 labelMode + 显隐强制联动 | `IconToolbar` 新增 `labelRegion` 参数（6 个调用点全部更新）；`toggleGroup` 与 `changeCategoryTreeOpen` 无条件同步文字模式 |
| 2 | 置顶拖拽排序 | `pin_order REAL` 列 + 迁移 + 部分索引；`move_pinned` / `fetch_pinned_ordered` / `renumber_pinned`；`clipboard_move_pinned` / `clipboard_list_pinned` RPC；前端 `@dnd-kit` + 拖拽把手 |
| 3 | 字号档位 | `--app-font-size` CSS 变量 + `ui/src/lib/fontSize.ts`；设置页新增「外观」区（字号档位 + 按钮显示方式全局默认）；docx 导出显式声明 Times New Roman / SimSun / 小四 |

**验证结果**：`tsc --noEmit` 通过；eslint 全部改动文件 0 warning；六语言 i18n key 一致性检查通过；`pytest` 887 passed（2 个失败是 Linux 沙箱下的 Windows 专属 API，与本次改动无关）；新增 `tests/test_clipboard_pin_order.py` 17 个用例全过。

**实现期间发现并修掉的一个真实 bug**：`move_pinned` 最初直接采信调用方传入的 `before_id` / `after_id` 确实相邻，取 `(before + after) / 2`。当两者之间其实还夹着别的项时，每次拖拽都算出**同一个中点**，多项挤在相同的 `pin_order` 上，排序退化成未定义。修法是从数据库现查真实相邻项（`_pin_order_bounds`），让「插到某一项正上方」成为唯一权威语义。回归测试见 `test_non_adjacent_neighbor_hints_still_produce_distinct_orders`。

## 已确认的决策（2026-07-27）

## 已确认的决策（2026-07-27）

| # | 分叉点 | 决定 |
|---|---|---|
| 1 | 剪贴板行内 7 个操作按钮 | **图标 + Tooltip，受统一的「纯图标 / 图标+文字」开关控制**；开文字模式时换行成 2 行，不做 ⋯ 溢出菜单 |
| 2 | 标签模式偏好粒度 | **全局默认 + 区域可覆盖**（未覆盖时跟随全局） |
| 3 | 显隐图标 ↔ 标签模式联动 | **永远强制覆盖**：点「显示」→ 图标+文字，点「隐藏」→ 纯图标+悬停，不管用户手动设过什么 |
| 4 | 置顶拖拽实现 | **`@dnd-kit`**；数据层 `pin_order REAL` 稀疏分数，拖一次只 UPDATE 一行，精度耗尽时重编号 |
| 5 | 删除含子分类的分类 | **弹确认框当场选**：列出「N 个子分类 / M 篇笔记」，给「子类提升到父级」和「删整棵子树」两个按钮 |
| 6 | 大文件 FTS 索引 | **只索引前 2MB**，UI 明确标注「本篇仅索引前 2MB」 |
| 7 | 新建分类后回溯重分类 | **手动触发 + 先预览再应用**：列出「哪几篇会从 X 改到 Y」，确认后才写入 |
| 8 | 字号档位 | **小四（12pt = 16px，默认）/ 四号（14pt ≈ 18.67px）两档** |

决策 2 与 3 的交互需要注意：区域覆盖是「记住用户在该区域的显式选择」，而显隐联动是**无条件写入**该区域的覆盖值——即联动本身会创建/改写一条区域覆盖，而不是绕过它。这样两条规则不冲突。

先说结论：你列的 9 项需求里，**3 项已经实现**（位置记忆、导入自动分类、字体族），**4 项是半成品需要补完**（递归分类、大文件分段、工具栏两态、字号档位），**2 项完全没做**（置顶拖拽排序、真正的独立 EXE）。下面逐条给现状 → 原理 → 方案 → 待你定的分叉。

---

## 一、递归分类（可持续下钻）

### 现状
`modules/file_vault/notes/storage.py`：

- `categories` 表是**扁平**的 `(id, name, scope, keywords, created_at)`，`UNIQUE(name, scope)`。
- `notes.category` 是**自由文本单值**，schema 注释里已经写明设计意图："允许写成 `工作/项目A` 这种带斜杠的路径形式，前端按 `/` 切分渲染成树"。
- 前端 `NotesScreen.tsx` 已有 `buildCategoryTree()`、`CategoryManagerTreeLevel`、按 `depth * 16px` 缩进渲染，树也能折叠（`ideal1-notes-category-tree-open`）。

也就是说**多级已经能用了**，但只是"能显示"，缺的是"能安全地管理"。

### 原理：物化路径（Materialized Path）而不是邻接表
两种建模方式的取舍：

| | 邻接表 `parent_id` | 物化路径 `工作/项目A/需求` |
|---|---|---|
| 取整棵子树 | 递归 CTE，N 次索引查找 | 一次 `LIKE '工作/项目A/%'` 索引前缀扫 |
| 移动/重命名子树 | 改 1 行，但要级联维护 | 一条前缀替换 UPDATE 批量改完 |
| 层级深度 | 无限 | 无限（受字符串长度约束） |
| 完整性保证 | 外键 + 级联，数据库帮你兜 | 全靠应用层校验 |
| 单个分类名含 `/` | 允许 | **禁止**（分隔符冲突） |

这个项目选物化路径是对的：`notes.category` 本来就是自由文本，改成外键要动 FTS 索引、批量移动、导入分类器全部链路。物化路径的代价只有"应用层要自己保证不变量"，而这正是当前缺的部分。

### 待补的 6 个缺口
1. **父路径自动补建**：创建 `A/B/C` 时幂等 upsert `A`、`A/B`，否则树里会出现"有子无父"的悬空节点。
2. **删除语义没定义**——这是最容易出数据事故的地方，三种可能，需要你选（见下方问题）：
   - 只删本级，子分类**提升到父级**（`A/B/C` → `A/C`）
   - 删**整棵子树**（连带子分类下的笔记一起变成未分类 / 一起进回收站）
   - 非空分类**拒绝删除**，先让用户搬空
3. **重命名 / 拖拽移动子树**：一个事务里两条前缀替换 —— `categories.name` 和 `notes.category` 各一条，形如
   `UPDATE ... SET name = :new || substr(name, :oldLen+1) WHERE name = :old OR name LIKE :old||'/%'`，
   然后 `reindex_notes_fts_bulk()` 重建受影响笔记的 FTS 行（`category` 是 FTS 的一列，不重建搜索会搜到旧路径）。
4. **加索引** `CREATE INDEX idx_notes_category ON notes(category)` —— 前缀 `LIKE 'A/%'` 才能走索引；现在没有这个索引，笔记多了以后每次筛选都是全表扫。
5. **名称校验**：禁 `/`、禁空段（`A//B`）、禁首尾空格、单段长度上限、**深度上限**（建议 16 层，防止路径长度爆炸和 UI 缩进溢出）。
6. **循环检测**：拖拽移动时禁止把 `A/B` 移进 `A/B/C`（自己的子孙里），否则前缀替换会产生无限自嵌套路径。

---

## 二、字体：中文宋体 + 英文/标点 Times New Roman

### 现状：**已经实现**
`ui/src/index.css`：
```css
--font-sans: 'Times New Roman', 'SimSun', '宋体', serif;
font-size: 16px; /* 小四 (12pt) @ 96dpi */
```

### 原理：CSS 字体回退是**按字形逐字符**的，不是按整段
浏览器渲染每个字符时，沿 `font-family` 列表从左到右找**第一个包含该字形的字体**。Times New Roman 有拉丁字母和半角标点、**没有 CJK 字形**；所以：

- `Hello, world.` → Times New Roman（它有这些字形，第一顺位命中）
- `你好，世界。` → Times 没有，回退到 SimSun（宋体）

这恰好就是你要的效果，**不需要写任何 `unicode-range` 规则**。

### 待补
1. **字号档位**：现在 16px 硬编码。改成 CSS 变量 `--app-font-size`，设置页给两档：小四 = 12pt = 16px，四号 = 14pt ≈ 18.67px。落 localStorage，同 `displayMode` 那套模式。
2. **编辑器和导出要单独设**：CodeMirror 默认 monospace，`docx` 导出走 `docx` 库的 run 属性 —— 这两处不继承 `--font-sans`，得显式指同一套字体族，否则"应用里是宋体、导出成 docx 变了别的字体"。
3. **中文标点归属**：`，。；：「」、` 这些在 Unicode CJK 标点区，Times New Roman 基本不含，会正确落到 SimSun。如果你要求"**所有**标点都用 Times"，需要 `@font-face` + `unicode-range: U+3000-303F, U+FF00-FFEF` 强制指向 Times —— 但 Times 里这些码位大面积缺字，结果是显示成豆腐块。**建议不做**，保持现在的"中文标点跟中文一起用宋体"。
4. 检查 `@fontsource-variable/geist` 是否还在被引用 —— 装了但如果被某处 `font-family` 用上，会破坏上面的回退链。

---

## 三、位置记忆（自动跳回上次阅读/编辑位置）

### 现状：**已经实现且实现得不错**
`ui/src/lib/positionMemory.ts`：光标字符偏移 + 滚动占比 + `segmentOrdinal`（大文件分段）+ 双缓存自愈（主记录损坏回退快照）+ 最近 5 条历史回溯 + 300 篇 LRU 淘汰。

### 原理：为什么是 ms 级
1. **不走后端 RPC**。localStorage 是渲染进程内的同步 KV，读一条是**微秒级**，所以"算出目标位置"这一步的开销可以忽略，跳转和首帧渲染在同一帧内完成。
2. **存字符偏移而不是像素**。像素值会因为字号设置（Ctrl+滚轮缩放）、窗口宽度变化在两次会话之间对不上；字符偏移是文档的内在坐标，跟渲染无关。
3. **滚动存占比而不是绝对值**。同理，占比能自动适配当前的渲染高度。

### 待加固的 3 点
1. **parse 成本随笔记数线性增长**：现在每次 `getPosition()` 都 `JSON.parse` 整个 300 篇的对象。虽然仍是 ms 内，但可以改成模块级内存缓存 + 写时增量落盘，把 parse 从"每次读"降到"每次会话一次"。
2. **localStorage 会丢**：它绑在渲染进程的 profile 上，清缓存/换数据目录就没了。可选：异步双写到后端 `settings` 表（不阻塞 UI，只在 localStorage 未命中时兜底）。
3. **恢复时序**：按 `scrollRatio` 定位必须等 CodeMirror 完成首次 layout（否则总高度是 0，算出来的位置全错）。要用 `view.requestMeasure()` / `requestAnimationFrame`，**不能用 `setTimeout` 猜延迟** —— 这是这类 bug 最常见的成因。

---

## 四、大文件 ms 级显示与编辑

### 现状：**核心机制已实现，遗留数据未迁移**
- `notes/segmented_content.py`：UTF-8 安全切段，目标 256KB / 硬上限 512KB，优先在换行处切。注释里记录过一次真实优化：80MB 笔记首次打开曾耗 50 秒，其中 80%+ 是 2700 万次逐字符 `str.encode()`，改成"整串 encode 一次 + 在 bytes 里找切点"解决。
- `note_content_segments` 表 + `open_segment_session` / `note_content_segment_get` / `note_content_segment_put` RPC。
- 前端 `@tanstack/react-virtual` 虚拟滚动。

### 原理：三层配合，让开销与文件大小解耦
1. **分段存储 → 时间复杂度 O(1) 而非 O(N)**。正文永不整体组装，一次只取一个 ordinal 的 256KB。单次 RPC 的传输量、SQLCipher 的解密量、JSON 序列化量都是**常量**，跟文件是 1MB 还是 1GB 无关。这是"ms 级"能成立的根本原因。
2. **虚拟滚动 → DOM 节点数恒定**。只为视口内的行建 DOM，浏览器的 layout/paint 成本也变成常量。
3. **乐观并发（CAS）→ 编辑不读写全文**。`note_content_segment_put` 带 `expected_revision`，写入时比对版本号，避免"读全文 → 改 → 写全文"这种与大小成正比的模式。

### 待补的 4 个缺口
1. **遗留笔记还在老存储上**。`storage.py` 注释明说 "Legacy rows keep their original body until a later, verified migration"。所以老导入的大笔记**现在仍然慢**。需要：一次性带校验的后台迁移，或"首次打开时惰性转换 + 进度提示"。
2. **首次导入的成本没解决**。`split_text` 快了，但入库仍是 N 条 INSERT + N 次 FTS 索引。80MB 文件 ≈ 320 段。建议：导入放后台任务队列 + 进度条；**FTS 只索引前 N MB**（对一个 80MB 文件做全文索引，索引体积和写入耗时的代价远超检索收益）。
3. **跨段编辑的边界行为**没定义 —— 一次编辑正好横跨两段（比如粘贴一大段、或在段边界删除换行）时怎么合并/重切段。
4. **缺性能回归测试**。"ms 级"必须有可测的定义，建议写进 `tests/`：用脚本生成固定大小的 10MB/100MB/500MB 文件，断言 ①打开到首帧 P95 < 100ms ②按键到字符上屏 P95 < 16ms（一帧）③滚动帧率不掉帧。没有基准的话，任何一次重构都可能悄悄把性能改回去。

---

## 五、图标 vs 图标+文字 两态（你明确要选项的两处）

### 现状
- **笔记工具栏**：`IconToolbar.tsx` **已经有**这个开关 —— 右端一个 `Captions` 图标切换 `showLabels`，每个按钮都包了 Tooltip，状态按 `ideal1-icon-toolbar-labels-<storageKey>` 持久化。
- **剪贴板每条记录的行内按钮**：`ClipboardScreen.tsx` 第 990-1040 行左右，一排 `<Button variant="ghost" aria-label={...}>` **只有 `aria-label`，既没有 Tooltip 也没有文字**。`aria-label` 只给屏幕阅读器，鼠标用户什么都看不到 —— 这就是你说"我怎么能进行选择呢"的直接原因。
- **笔记页也有 25 处 `aria-label`**，其中一部分不在 IconToolbar 里，同样没有可视标签。

### 方案（三种，需要你选，见下方问题一）
抽一个共用的 `ActionButton`（icon + label + tooltip 三合一），把所有裸 `aria-label` 按钮换掉，读同一份偏好。区别在于**偏好的粒度**：

- **A｜全局一个开关**：剪贴板行、笔记行、工具栏共享一个 `LabelModeProvider`（复用 `displayMode.tsx` 的 context 模式）。最简单、最一致，代价是不能"工具栏显文字但行内只显图标"。
- **B｜按区域独立**：剪贴板行、笔记行、各工具栏各自一个开关，沿用现在 `storageKey` 的做法。最灵活，代价是开关变多、用户要分别设置。
- **C｜全局默认 + 区域覆盖**：一个全局默认值，某个区域可以显式覆盖（未覆盖时跟随全局）。最贴合使用习惯，实现成本最高。

另外行内按钮还有个独立问题：一条记录有 7 个操作（AI 润色、局部复制、快速转换、置顶、隐藏、编辑、删除），**全部显示文字会把行撑爆**。所以对"行内"这一处，还有第四种可选形态：**图标常显 + 溢出收进 `⋯` 下拉菜单（菜单项天然带文字）**。

---

## 六、显隐图标与标签模式的联动

你的要求：点"显示行/列"的图标 → 强制切到`始终显示图标+文字`；点"隐藏" → 强制切回`纯图标+悬停提示`。

### 方案
在 `changeCategoryTreeOpen(open)` 这类显隐 handler 里同时调 `setShowLabels(open)`，两个状态一起持久化。技术上很简单（约 10 行）。

### 需要你定的语义（见下方问题二）
如果用户手动改过标签模式，之后再点显隐图标，要不要**覆盖**他的手动选择？
- **强制联动**：永远覆盖，行为绝对可预测，但会"抢"用户的手动设置。
- **黏性覆盖**：一旦用户手动动过标签开关，显隐图标就不再改它。更尊重用户，但行为不那么一目了然。

---

## 七、置顶内容拖拽排序

### 现状：**完全没有**
`clipboard_history` 表只有 `is_pinned`，没有排序列。前端 `sortEntries()` 是纯 `b.id - a.id`，注释还特意解释了"不用 is_pinned 加权，因为置顶排最前只应该在'只看置顶'视图里成立"。

### 原理：稀疏分数排序（Fractional / Gap Indexing）
朴素做法是存整数 `position = 0,1,2,3...`，但把第 10 项拖到第 2 位要 UPDATE 9 行 —— 一次拖拽写整表。

稀疏分数的做法：
1. 加一列 `pin_order REAL`，置顶时给 `min(现有) - 1024`（新置顶排最前）。
2. 拖到 A 和 B 之间 → `pin_order = (A.pin_order + B.pin_order) / 2`，**只 UPDATE 一行**，与列表长度无关。
3. **精度耗尽**：IEEE 754 双精度反复对折约 50 次后两个相邻值会相等。所以要检测 `|A - B| < ε`，触发一次该区间的整段重编号（按 1024 步长重排）—— 这是罕见路径，正常使用几乎不会命中。

备选方案：**LexoRank 字符串**（如 `aaa` / `aab` 之间插 `aaam`），无精度上限，但实现和调试复杂度明显更高。对单机剪贴板置顶这个量级（几十到几百条），REAL + 重编号兜底完全够，**推荐 REAL**。

### 待你定：拖拽的前端实现（见下方问题三）
- **原生 HTML5 `draggable`**：零依赖，代码量小，但键盘不可用、触控板/触屏体验差、拖拽时的占位动画要自己写。
- **`@dnd-kit`**：约 +30KB，自带键盘拖动（可访问性）、平滑占位动画、触控支持、虚拟列表适配。

另外还要定：排序**只在"只看置顶"视图生效**（跟现有注释的设计意图一致），还是置顶项在**所有视图**都按手工序排在最前。

---

## 八、独立可执行文件

### 现状：**现在的 EXE 不是独立的**
`electron-builder.json5` 注释写得很明白：

> The Python backend is **not bundled/frozen** — this build depends on the end user's own system Python (3.9 + cryptography/pyotp/qrcode/keyring/Pillow/pywin32 already installed).

`extraResources` 只是把 `.py` **源码**复制进去，靠目标机自带 Python 去跑。换台没装 Python 的电脑直接起不来。

### 方案：就是你贴的那份 File Vault 独立 EXE 设计文档
关键技术点和原理：

1. **两个 PyInstaller 冻结目标，而不是一个**
   - `file_vault_backend.exe` 用 **one-file**：整个解释器 + 依赖打成一个文件，启动时解压到临时目录。后端只启动一次，一次性解压成本可接受。
   - `file_hook_worker` 用 **one-dir**：全局快捷键（Ctrl+V / Delete / Shift+Delete）是**高频**调用，one-file 每次调用都要重新解压一遍解释器，延迟不可接受。one-dir 直接执行已展开的文件。
   > 这是整份设计里最重要的一个判断：**打包形态要按调用频率选，不是全项目统一。**

2. **`runtime_resources` 解析器替代 `__file__`**：冻结后 `__file__` 指向 `_MEIPASS` 临时目录而不是源码树。统一一个解析层：开发模式 → 源码树，冻结模式 → `_MEIPASS` 或稳定 hook runtime 目录。

3. **数据目录迁到 `%LOCALAPPDATA%`**，不再写死 源码树里的固定路径。迁移的技术要点：
   - 用 **SQLite backup API** 而不是裸拷文件 —— 裸拷 `.db` 会漏掉 WAL/SHM 里未 checkpoint 的事务，得到一个损坏或缺数据的副本。
   - 跨进程迁移锁 + 写临时目录 → 校验 → 原子改名 → 写完成标记。任一步失败可重试，**不删旧目录**。
   - 迁移后做**真实的密钥读取和身份解锁预检**，失败就保留旧目录 —— keyring 服务名跟 Windows 用户绑定，光文件搬对了不等于能解锁。

4. **稳定的全局快捷键运行时**：portable EXE 的 `resourcesPath` 是**每次启动都变的临时解压目录**，绝对不能写进开机自启动的 Run 项。所以要按内容哈希把 hook agent 部署到 `%LOCALAPPDATA%\Ideal1 File Vault\FileHook\runtime-<digest>`，Run 项只指这个稳定路径。升级顺序：部署新 bundle → 验证 → 停旧 agent → 起新 agent → 原子换 Run 项，任一步失败全部回滚。

5. **更新机制 —— 为什么信任根是 Ed25519 签名清单，而不是 HTTPS**
   HTTPS 只证明"这份文件确实从 github.com 下载的"，不证明"是持有发布私钥的人发布的"。仓库被接管、CI 被注入、Actions 权限被滥用，HTTPS 全都拦不住。签名清单能：客户端用**硬编码的公钥**验签，私钥放在 CI 拿不到的独立签名环境。SHA-256 在这套体系里只负责"下载没损坏"，不承担身份认证。
   两个容易踩的实现细节：
   - **必须对原始 UTF-8 字节验签，再 parse JSON**。先 parse 再重新序列化会改变字节（键序、空格、Unicode 转义），签名必然失败或被绕过。
   - **密钥轮换要用链式证书**：每份证书由**上一把**私钥签名，声明下一把公钥。这样跳过了好几个版本的老客户端，仍能从它内置的初始公钥一路验到当前密钥。

6. **更新落地用独立 runner 进程**：正在运行的 EXE 不能替换自己。所以在主程序退出**之前**，把 runner 复制到 `%LOCALAPPDATA%\...\updates\runner-<digest>` 并校验，再启动它 —— 它必须在主 EXE 退出、portable 外层启动器清理临时资源之后依然存活。新版本以 `--post-update-health` 启动，只有"后端起来了 + 窗口建好了 + 数据目录可读"三项都满足才写健康回执；超时或缺回执 → runner 自动恢复旧 EXE 并重启。

### 工作量提示
这一项的工作量**大于前面七项之和**。建议单独开一个分支、单独一轮验收，并且放在最后做 —— 前七项都是在现有 dev 模式下能验证的功能改动，打包会引入一整套新的失败模式（hidden import 漏收集、原生库找不到、非 ASCII 路径、Defender 误报）。

---

## 九、导入自动分类

### 现状：**已经实现**
`notes/classifier.py`：纯离线规则打分 —— 分类名出现在标题 +3、出现在正文 +1、关键词在标题 +2、在正文 +1，取前 20000 字做摘要，全部候选得 0 分就返回 `None`（保持未分类，不硬猜）。

**你的"后面新增的分类也能自动分类"这条要求已经满足了**，而且是刻意设计的：候选列表由调用方从 `categories` 表 + 已被笔记使用的分类动态收集，所以用户新建的任何分类**下一次导入自动成为匹配目标，零代码改动**。这也是为什么它被拆成独立模块而不是写成一串 if/elif。

### 配合递归分类要改的地方
1. **路径分段打分**：递归分类下候选名是全路径 `工作/项目A`，现在的 `name_l in title_l` 要求文件名里出现完整的 `工作/项目A` 字符串，几乎不可能命中。要改成按 `/` 拆段打分：**最后一段（叶子名）权重最高，父段给较低权重**。
2. 可选增强：把已分类的笔记当训练集做 TF-IDF 最近邻，让"语义相近但没提到分类名"的文件也能中。**要不要做需要你决定** —— 会引入新依赖或自己实现向量化，与项目"deliberately dumb and offline"的现有取向有冲突。
3. **回溯重分类**：新建分类后，是否批量对已导入的旧笔记重跑一次分类器？

---

## 十、建议的实施顺序

按"风险 × 依赖 × 体感收益"排：

| 阶段 | 内容 | 理由 |
|---|---|---|
| 1 | 五、六（图标标签 + 显隐联动） | 纯 UI，无数据迁移，你的体感最直接 |
| 2 | 七（置顶拖拽） | 一列 schema + 一个组件，独立、可单独验收 |
| 3 | 二（字号档位） | 小改动，顺手做完 |
| 4 | 一（递归分类补完） | 有数据迁移和不变量校验，需要仔细测 |
| 5 | 九（分类器路径分段） | 依赖阶段 4 的路径规范 |
| 6 | 三、四（性能加固 + 遗留数据迁移） | 需要先建性能基准才能验证，工作量中等偏大 |
| 7 | 八（独立 EXE + 更新） | 工作量最大，引入全新失败模式，单独分支单独验收 |
