# 让 Claude Code 用上 Tessera

两条路，用同一套代码：

- **`tessera` 命令** —— 你自己在终端里敲，也可以让 Claude Code 去敲
- **`tessera-mcp` MCP 服务器** —— Claude Code 直接当工具调用，不用经过命令行

装好之后，"把桌面上那个合同加密"这种话 Claude Code 可以自己完成，不必你切到界面。

---

## 一、先装

在仓库根目录：

```powershell
pip install -e .
```

装完 `tessera` 和 `tessera-mcp` 两个命令就有了。不想装也行，直接用模块形式跑：

```powershell
python -X utf8 -m modules.file_vault.agent.cli status
```

---

## 二、密码怎么给（这一节最要紧）

**任何情况下都不要把主密码写在命令行参数里，也不要发在跟 Claude 的对话里。**

- 命令行参数（argv）在 Windows 上任何一个进程都读得到，还会留在 shell 历史里
- 对话内容会进入模型上下文，并落进 Claude Code 的会话记录，之后每一轮都会被重读

所以这套工具**根本没有 `--password` 这个开关**，MCP 工具也**没有 `password` 参数**。
只有两条路：

| 场景 | 做法 |
|---|---|
| 你自己在终端里 | 什么都不用配，命令会问你一次，输入时不回显 |
| 脚本 / 定时任务 / Claude Code | 把密码写进一个只有你能读的文件，用 `--password-file` 或环境变量指向它 |

建一个密码文件（放在你自己的加密盘或权限受限的目录里）：

```powershell
Set-Content -Path "$env:USERPROFILE\.tessera-pw" -Value "你的主密码" -NoNewline
icacls "$env:USERPROFILE\.tessera-pw" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

第二行把这个文件的权限收成"只有你能读"。

---

## 三、`tessera` 命令怎么用

不需要解锁的两条：

```powershell
tessera status
tessera tools
```

需要解锁的（会问一次密码，或读密码文件）：

```powershell
tessera search 报销
tessera note list
tessera note get 12
tessera note new --title "会议纪要" --content-file .\notes.md
tessera clip list --limit 20
tessera clip search 密钥
tessera encrypt .\合同.docx
tessera decrypt .\合同.docx.ivault -o .\合同.docx
```

几个通用开关：

| 开关 | 作用 |
|---|---|
| `--password-file <路径>` | 从文件读主密码，不再交互提问 |
| `--json` | 输出 JSON 而不是给人看的文本，方便脚本处理 |
| `--data-dir <路径>` | 换一个数据目录（默认用应用自己那个） |
| `--force` | 只有 `encrypt` / `decrypt` 有：目标文件已存在时允许覆盖 |

**退出码**：`0` 成功，`2` 用法或路径问题，`3` 金库拒绝（密码错、没解锁等），`130` 你按了 Ctrl+C。
脚本可以按这个分支。

**每条命令都会重新解锁一次。** 这是刻意的：要免掉重复解锁就得有个常驻进程守着解开
的密钥，那意味着一个本机端口或命名管道，攻击面变大。要连续操作就用 `--password-file`。

---

## 四、接进 Claude Code

在仓库根目录建一个 `.mcp.json`（这个文件已被 `.gitignore` 排除，不会传上去）：

```json
{
  "mcpServers": {
    "tessera": {
      "command": "<path-to-python>/python.exe",
      "args": ["-X", "utf8", "-m", "modules.file_vault.agent.mcp_server"],
      "cwd": "<project-root>",
      "env": {
        "TESSERA_MCP_PASSWORD_FILE": "C:/Users/<username>/.tessera-pw",
        "TESSERA_MCP_ALLOW_WRITE": "1"
      }
    }
  }
}
```

或者一条命令：

```powershell
claude mcp add tessera -- python -X utf8 -m modules.file_vault.agent.mcp_server
```

（这样加的话，两个环境变量要另外配，否则只有只读工具可用。）

### 两个环境变量的作用

| 变量 | 不设时 | 设了之后 |
|---|---|---|
| `TESSERA_MCP_PASSWORD_FILE` | 需要金库的工具**一律拒绝**，并说明该怎么开 | 这些工具可用 |
| `TESSERA_MCP_ALLOW_WRITE=1` | 会改动数据的三个工具**不注册**，`tools/list` 里根本看不到 | 它们出现 |

第二条是刻意做成"看不见"而不是"看得见但会拒绝"：模型选不了一个不存在的工具，
这比在工具内部临时判断可靠。

### 有哪些工具

不需要解锁：

| 工具 | 作用 |
|---|---|
| `tessera_status` | 金库建了没、数据目录在哪、写操作开没开 |
| `tessera_pcclean_tools` | 列出电脑清理里那批小工具 |

需要解锁（只读）：

| 工具 | 作用 |
|---|---|
| `tessera_search` | 跨笔记 / 剪贴板 / 密码库搜索，只回标题不回密码明文 |
| `tessera_note_list` | 全部笔记的 id、标题、分类 |
| `tessera_note_get` | 按 id 读一条笔记的正文 |
| `tessera_clipboard_recent` | 最近的剪贴板条目 |
| `tessera_clipboard_search` | 全文搜索剪贴板 |

需要解锁 + `ALLOW_WRITE`：

| 工具 | 作用 |
|---|---|
| `tessera_note_create` | 新建一条笔记 |
| `tessera_encrypt_file` | 加密一个文件成 `.ivault` |
| `tessera_decrypt_file` | 解开一个 `.ivault` |

### 三条不会松动的规矩

1. **被判定为敏感的剪贴板条目（密码 / API Key / 卡号）永远不把正文交出去**，只报类型。
   这类内容一旦进入模型上下文就同时进了会话记录，而"看看剪贴板里有什么"这种问法
   完全没有要暴露密钥的意思。要用某一条密钥，去应用里点。
2. **密码库的明文一条都不给。** 搜索只回条目名。
3. **加密 / 解密的目标文件已存在时一律拒绝，没有可以绕过的开关。** 模型推错一个
   输出路径的代价是用户唯一那份原件被盖掉，而它不会知道自己推错了。

---

## 五、出问题时

| 症状 | 多半是 |
|---|---|
| 工具列表里只有两个 | 没设 `TESSERA_MCP_PASSWORD_FILE`（其余的需要解锁才有意义，但仍会列出）——若连只读工具都没有，是服务器没起来，看 Claude Code 的 MCP 日志 |
| 工具列表里只有 7 个，看不到建笔记 / 加密 | 没设 `TESSERA_MCP_ALLOW_WRITE=1` |
| 回答说"没有配置密码来源" | 同上第一条，密码文件路径没配或写错了 |
| 回答里带 `auth.wrong_password` | 密码文件里的内容不对（注意别把结尾的换行也算进去，程序会自动去掉首尾空白） |
| 命令行卡住不动 | 见下 |

**关于"卡住不动"**：`tessera` 在没有真控制台的环境里（服务、计划任务、某些封装）
会明确报错退出，不会死等。如果你确实遇到卡住，先确认用的是最新版本 —— 早期版本
在 Windows 上会因为 `isatty()` 对 `NUL` 设备返回真而永远等一个不会到来的按键。
