# 剪贴板历史功能 — 需求规格说明书 v2

> 基于原始需求的整合、诊断、补全与润色。主要变更：
> 1. 修正剪贴板解析层的 Rust 代码错误 + 数据结构设计问题
> 2. 新增**隐私安全**、**数据持久化**、**快捷操作**、**配置化**四个板块
> 3. Claude Code 自动化指令部分与全局 CLAUDE.md 对齐，聚焦本项目特有的自定义需求
> 4. 剪贴板方面不再仅作"诊断→修复"，给出完整的**产品功能清单**（v1→v2 优先级）

---

## 一、剪贴板历史功能 · 完整设计

### 1.1 问题诊断：CF_HTML "乱码"根因

你粘贴的内容开头是：

```
Version:0.9
StartHTML:0000000140
EndHTML:0000016420
StartFragment:0000000176
EndFragment:0000016384
SourceURL:http://tauri.localhost/
```

**这不是乱码**——这是 Windows 剪贴板 **CF_HTML（HTML Format）** 的标准包装头。Windows 一次"复制"会同时放入多种格式：

- `CF_UNICODETEXT` → 纯文本
- `CF_HTML` → 带样式的 HTML 片段（含上述头部）
- 可能还有 `CF_BITMAP`/`CF_DIB` 等

正常粘贴时，读取端根据目标选择格式：纯文本编辑器用 `CF_UNICODETEXT`，富文本编辑器用 `CF_HTML` 并只取 **StartFragment 到 EndFragment 之间的内容**。你现在遇到的情况是：**剪贴板历史模块把 `CF_HTML` 的原始字节（含头部）当成了"纯文本"存进历史并显示**，所以你看到的是 HTML 源码而非渲染结果。

### 1.2 数据模型（存储层）

每条记录建议存"多格式 + 元数据"结构，而非单一字符串：

```json
{
  "id": "clip_20260723_001",
  "timestamp": "2026-07-23T10:30:00.000Z",
  "source_app": "来源应用名",
  "preview_format": "text/plain",

  "formats": {
    "text/plain": "纯文本内容",
    "text/html": "<已剥离 CF_HTML 头部、裁剪到 Fragment 范围的干净 HTML>",
    "image/png": "缩略图 base64 或文件路径",
    "image/png_full": "原图路径（大文件存盘引用，不嵌入 JSON）"
  },

  "metadata": {
    "char_count": 1234,
    "is_code": false,
    "has_sensitive": false,
    "checksum": "sha256_of_plaintext"
  }
}
```

**要点**：
- `source_app` 与 `formats` 同级，不是格式的一种
- 大图用**缩略图预览 + 原图文件引用**，不把几百 KB 的 base64 塞进单条记录
- `checksum` 用于去重和同步时的冲突检测

### 1.3 解析层实现

#### Electron 端（IPC 主进程）

```javascript
const { clipboard, nativeImage } = require('electron');

function captureClipboard() {
  const formats = clipboard.availableFormats();
  const record = { formats: {}, metadata: {} };

  if (formats.includes('text/plain')) {
    record.formats['text/plain'] = clipboard.readText();
  }
  if (formats.includes('text/html')) {
    // Electron 的 readHTML() 已自动剥离 CF_HTML 头部
    record.formats['text/html'] = clipboard.readHTML();
  }
  if (formats.includes('image/png')) {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      // 缩略图：最大 300px 宽
      const thumb = img.resize({ width: 300 });
      record.formats['image/png'] = thumb.toDataURL();
      record.formats['image/png_full'] = saveImageToStore(img);
    }
  }
  return record;
}
```

#### Python / pywin32 端（Windows，CF_HTML 需手动解析）

```python
import re

_CF_HTML_START_RE = re.compile(r"StartFragment:(\d+)")
_CF_HTML_END_RE = re.compile(r"EndFragment:(\d+)")

def parse_cf_html(raw_html: str) -> str:
    """从 CF_HTML 原始字符串中提取 StartFragment 到 EndFragment 的正文，
    剥离 Version/StartHTML/EndHTML/StartFragment/EndFragment/SourceURL 等包装头。
    
    CF_HTML 的 StartFragment/EndFragment 值标注的是 UTF-8 字节偏移 NOT char 索引，
    所以必须用 .encode('utf-8') 定位而不是按字符索引切。
    """
    start_match = _CF_HTML_START_RE.search(raw_html)
    end_match = _CF_HTML_END_RE.search(raw_html)
    if not start_match or not end_match:
        return raw_html  # fallback: 不认识的格式原样返回
    start = int(start_match.group(1))
    end = int(end_match.group(1))
    if start >= end or start < 0 or end > len(raw_html.encode("utf-8")):
        return raw_html
    return raw_html.encode("utf-8")[start:end].decode("utf-8", errors="replace")
```

**⚠️ 常见坑**：`StartFragment` 和 `EndFragment` 的值是**字节偏移量**（byte offset），不是字符索引。上述代码用 `.encode('utf-8')` 再切片是正确的——不要按 `len(raw_html)` 或 `raw_html[start:end]` 切。

### 1.4 显示层

| 场景 | 行为 |
|---|---|
| 历史列表（缩略视图） | 默认显示 `text/plain`（干净、不卡顿）；无纯文本时截取 HTML 前 100 字符 |
| 单条详情（展开） | 用户选择格式：纯文本 / 渲染 HTML / 图片预览 |
| HTML 渲染 | 必须用 **沙盒 iframe** 或严格白名单标签过滤（仅允许 p/span/br/a/img）—— 不能直接把整段 HTML 塞进 innerHTML，否则 Tailwind 内联样式会把布局撑坏 |
| 图片预览 | 显示缩略图，用户点开才加载原图，避免列表滚动卡顿 |

### 1.5 选中片段复制（关键交互）

需求：在历史预览中像普通文本一样用鼠标选一段，只复制这一段，不把整条记录的容器样式带出去。

**实现要点**：

1. 预览区域用 **原生可选中文本** 渲染，不要用不可选的自定义组件 —— `Selection API` 天然可用
2. 拦截 `copy` 事件，**接管剪贴板写入**，防止浏览器把外层容器属性也序列化进去

**Electron 渲染进程版**：

```javascript
document.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const plainText = range.toString();

  // 提取选中片段到干净容器
  const fragment = range.cloneContents();

  // 清理残留交互元素
  fragment.querySelectorAll('button, svg, [role="button"]').forEach(el => el.remove());

  const container = document.createElement('div');
  container.appendChild(fragment);
  const cleanHtml = container.innerHTML;

  e.clipboardData.setData('text/plain', plainText);
  e.clipboardData.setData('text/html', cleanHtml);
  e.preventDefault();
});
```

> **注意**：`cloneContents()` 返回 `DocumentFragment`，`querySelectorAll` 在其上直接可用。如果在 clone 前未标记清理目标，clone 后 fragment 内的按钮/SVG 仍会被带出——上述代码在 clone **后**清理 fragment 是正确的顺序。

**Tauri / Webview 版**（用 `navigator.clipboard.write` + `ClipboardItem`）：

```javascript
async function copySelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const plainText = range.toString();

  const fragment = range.cloneContents();
  const container = document.createElement('div');
  container.appendChild(fragment);
  container.querySelectorAll('button, svg, [role="button"]').forEach(el => el.remove());
  const cleanHtml = container.innerHTML;

  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([plainText], { type: 'text/plain' }),
    'text/html':   new Blob([cleanHtml],   { type: 'text/html' })
  })]);
}
```

**边界情况**：

- 选区跨多条历史记录：按记录分界拼接，中间加 `\n\n` 分隔，不混 DOM
- 纯文本记录（无 HTML 格式）：直接 `range.toString()` → `text/plain`，跳过 HTML 清理
- 空选区：不处理，让默认行为走

### 1.6 公式与特殊格式

| 类型 | 剪贴板中的存在形式 | 建议策略 |
|---|---|---|
| Excel 公式 | `text/plain` 通常是**计算后的值**，公式本身在 `Biff12`/`XML Spreadsheet` 专有格式中 | v1 存计算值；v2 检测来源为 Excel/WPS 时启用专有格式解析 |
| Word 数学公式 | OMML（内嵌在 CF_HTML 中）或 EMF 图片兜底 | 保留 HTML 中的 OMML 片段；提取文字描述回退 |
| 代码 | 有语法高亮的编辑器复制时一般同时写入 `text/plain` + 自定义格式 | 优先取纯文本；检测 `is_code` 标记后可选保留高亮 HTML |

> **性价比建议**：先把 `text/plain` + `text/html` + `image/png` 三种基础格式做稳，公式和代码高亮作为 v2 附加。不要一开始就追求"通吃所有格式"。

### 1.7 🆕 隐私与安全

剪贴板是密码、API Key、身份证号等敏感信息的天然泄露通道。**必须默认保护**：

| 策略 | 实现方式 |
|---|---|
| **敏感内容检测** | 正则/轻量 NLP 匹配常见模式（`password=`, `-----BEGIN.*KEY-----`, 信用卡号 Luhn 校验） |
| **自动模糊化** | 检测为敏感时存储 `text/plain` 替换为 `******`，只保留时间戳和应用来源；用户可主动"显示原文" |
| **永不记录白名单** | 用户可配置指定应用（如 `KeePass.exe`）复制的内容直接丢弃 |
| **本地优先** | 数据默认只存本地 SQLite/IndexedDB；如需云同步，**必须端到端加密**（密钥不出设备） |
| **清理策略** | 软件退出时可选自动清空历史；支持"一键清空所有" |

### 1.8 🆕 数据持久化

| 参数 | 默认值 | 可配置 |
|---|---|---|
| 最大条目数 | 500 | 100–5000 |
| 自动清理周期 | 7 天 | 1–90 天，或"永不" |
| 固定条目 | 手动固定 | 不参与自动清理 |
| 图片存储 | 缩略图 300px + 原图文件 | 关闭原图仅存缩略图 |
| 数据库 | SQLite（Electron 用 `better-sqlite3`；Tauri 用内置 SQL 插件） | — |

索引策略：`timestamp` DESC + `fts` 全文搜索。

### 1.9 🆕 快捷操作

| 操作 | 方式 |
|---|---|
| 搜索历史 | 即时过滤（全文搜索）+ 高级搜索（按应用、日期范围、格式） |
| 固定/置顶 | 星标条目不参与自动清理 |
| 批量删除 | 多选 → 删除 / 按应用一键清理 |
| 清空全部 | 危险操作，二次确认 |
| 导出 | 导出选中条目的纯文本/JSON（🟡 黄级，先备份再覆盖文件） |
| 格式切换预览 | 同一内容支持：纯文本查看 / HTML 渲染 / 原始源码 / markdown |

---

## 二、Claude Code 自动化操作指令

> 以下指令与用户级全局 `CLAUDE.md`（位于你的用户目录 `.claude/CLAUDE.md`）**保持一致但不重复**：全局文件已定义了铁律七条、工具四级阶梯、危险分级（🟢🟡🔴）、后台执行规则、失败自愈阶梯、验收闭环、日志回滚——这里只补充本项目对 Claude Code 的**定制行为**。

### 2.1 本项目对 Claude Code 的特殊要求

1. **不要等我手动运行脚本**：改完文件后默认执行 `npm run build`（本项目的构建命令），验证编译通过再报告完成，除非我明确说"先不编译"。

2. **不要问我要不要备份**：本项目的配置文件（`src/file_vault/settings/*.json`、`public/*.js`）改动前默认写 `.bak`，改完自动记日志——这是全局 CLAUDE.md 第 11 条的要求，你照做就行。

3. **优先读本项目的 `CLAUDE.md` 和 `modules/README.md`** 作为项目约定准绳，再读全局 CLAUDE.md 作为操作方式准绳——两者冲突时，**项目本地优先**（例：项目说"不要用 npm，用 pnpm"，照做）。

4. **涉及文件删除/覆盖前**，走全局的危险分级（🔴 红级），先问。特别地，**对 `node_modules/` 和 `dist/` 的删除**属于 🟡 黄级（可恢复，因为可重新生成），但 **`src/` 内文件删除仍为 🔴 红级**。

5. **本项目的 git 分支约定**：
   - 功能开发在 `feat/<name>` 分支
   - Bugfix 在 `fix/<name>` 分支
   - **绝不直接推 master 主分支**（全局 `feedback_force_push_master_hard_restriction.md` 已记录）

### 2.2 任务前置预演（对比全局规则的增强）

与全局第 5 节（危险三选一）结合，本项目对 🟡 黄级操作增加 **dry-run 模式**（可选，默认关闭）：

```
当你需要执行这批操作时，可以先输出：
  ⚡ 即将执行：<具体命令>
  📂 影响文件：<文件列表>
  ⏱ 预计耗时：<估算>
等我确认后再真正执行。如果我说"直接干"，就跳过确认。
```

### 2.3 成本控制补充

全局第 10 节已有详细省钱/提速规则，本项目补充一条：

- **对于 `file_vault` 这类有繁重测试的任务**：跑测试时，优先跑**与改动直接相关**的测试用例，而不是跑完整套测试。完整套可在 PR 前或 CI 上跑。如果全部通过要久等，全局规矩"不做无意义的测试和调试"同样适用。

---

## 三、创新功能建议（增强版）

每个配一句话的实现思路，不止列标题。

### 3.1 任务前置预演（dry-run）

- **实现**：`git diff --stat` + 文件列表 + 最小预估影响声明，确认后再真正执行
- **适用**：批量文件操作、配置修改、`git push`

### 3.2 变更差异可视化

- **实现**：代码改动自动在对话中输出 `git diff` 一段式摘要，文件改动多的只列文件名和行数

### 3.3 剪贴板语义搜索

- **实现**：SQLite FTS5 建立全文索引，支持自然语言片段搜索（"上次复那个带表格的" → `MATCH '表格'`）；也可扩展为向量嵌入搜索（用 `transformers.js` 在本地做 embedding）

### 3.4 失败模式库

- **实现**：全局 `ai/experience/pitfalls.md` 已存在——每次在这里记一条跨项目的操作踩坑记录即可，不需要另建系统

### 3.5 自动化健康检查

- **实现**：设 cron 每月扫描一次 `src/file_vault/tests/` 运行所有测试 + 检查关键路径（构建是否通过、配置文件结构是否合法），自动生成报告

### 3.6 🆕 主动学习：操作建议

- **实现**：Claude Code 检测到重复模式（如"每周三导出一份 BOM"）时，主动询问是否要写成剧本/脚本固化，不再每次手动操作

### 3.7 🆕 配置化中心

- **实现**：以上功能（dry-run 开关、存储阈值、清理周期、同步开关）集中到一个 `config.json` 中，不在 README 或对话中用自然语言约定——代码就是真相来源

---

## 四、两个关键决策点

### 4.1 速度预期：毫秒级不现实，分场景可做到很快

| 路径 | 典型耗时 | 说明 |
|---|---|---|
| L1 直接改文件 / L2 CLI 调用 | 几 ms–几十 ms | 纯 IO/计算  |
| L3 无障碍接口 / DOM 操作 | 几十 ms–几百 ms | 含一次树遍历 |
| L4 截图 → 模型分析 → 决定下一步 | **几百 ms–几秒** | 模型推理是物理瓶颈 |

**建议**：把"能用 L1/L2 解决的问题不用 L3/L4"这条写进自动化规则，不做无意义的截图分析。GUI 类操作接受"秒级"预期。

### 4.2 "危险操作无需确认"不要设为全局规则

已在 §1.7 / §2.2 / 全局 CLAUDE.md 第 5 节一致采用**三级权限 + 白名单**方案：

- 🟢 安全操作：完全不问
- 🟡 每类首次确认，同一类后续默认放行（可选 dry-run）
- 🔴 每次都问，不可跳过

**如果坚持要你认定的一些特定操作"永远不确认"**（比如 `npm run build`、删除特定缓存目录），可以在 `config.json` 里加一个 `silent_allowlist` 列表明确列出，而不是写"全局跳过所有确认"——既达到你的目的，又保留不可逆操作的安全阀。

---

## 附录：与全局 CLAUDE.md 的关系

| 话题 | 全局文件位置 | 本文档 | 关系 |
|---|---|---|---|
| 工具选择（L1–L4） | CLAUDE.md §3 | — | 全局已完整，本文不再重复 |
| 危险分级（🟢🟡🔴） | CLAUDE.md §5 | §2.2 / §4.2 | 全局定义等级，本文补充本项目特有的白名单 |
| 失败自愈阶梯 | CLAUDE.md §7 | — | 全局已完整，本文不再重复 |
| 验收闭环 | CLAUDE.md §8 | §2.3 | 全局定义通用格式，本文补充本项目验收偏好 |
| 日志与回滚 | CLAUDE.md §11 | — | 全局已完整，本文不再重复 |
| 经验库 | CLAUDE.md §9 + ai/experience/ | §3.4 | 全局定义存储格式，本文补充本项目记录范畴 |
| 本项目定制行为 | — | §2.1 | **本文独有**：build 自动触发、备份规则、git 分支等 |
| 剪贴板功能设计 | — | **第一章全部** | **本文独有** |
| 创新功能建议 | — | **第三章全部** | **本文独有** |
