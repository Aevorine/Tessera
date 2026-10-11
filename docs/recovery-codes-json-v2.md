# 恢复码 JSON 导出格式 v2 — 规格与技术指标

> 记录的是**已实现的行为**，不是提案。改动 `modules/file_vault/recovery_codes.py`
> 里的导出/解析逻辑时，这份文件要跟着改。
>
> 这里说的「恢复码」是第三方服务（GitHub、Google 等）的二次验证备用码，**不是**
> Tessera 自己那把主恢复密钥（`identity.py` 的 `SLOT_RECOVERY`）。两者除了名字
> 像，没有任何关系。

## 一、为什么要有 v2

v1 是一个裸数组，每个元素只有 `service`/`accountLabel`/`sourceFileName`/`exportedAt`
和码表。两个实打实的问题：

**1. 导出再导入会丢数据。** v1 把 `used`/`usedAt` 写进了文件，但解析器
（`parse_json_groups`）只读 `code`。于是「导出一份备份、再导回来」这个最普通不过
的动作，会把所有「已用」标记全部复活成未用。用户手里那份清单会显示一堆其实已经
作废的码可用，而他发现这件事的时刻，正是账号被锁、急着找一个能用的码的时刻。

**2. 没有版本号、没有校验、没有 id。** 文件被改过一个字符，或者哪天格式演进了，
都没有任何东西能告诉读的人「这份不对劲」。

同一类错误在 `diff_full_backup` 里还有第二处：它只比码的集合、不看「用过没有」，
所以「文件说已用、本地说可用」会被判成 `identical`（界面显示「无需处理」），用户
就继续相信那个其实已经烧掉的码还能用。也已修正。

## 二、结构

```json
{
  "format": "tessera-recovery-codes",
  "formatVersion": 2,
  "exportedAt": 1785939042.016,
  "appVersion": "0.1.5",
  "encrypted": false,
  "codesRedacted": false,
  "checksum": "sha256:9f2a…",
  "stats": { "groupCount": 3, "codeCount": 48, "unusedCount": 41 },
  "groups": [
    {
      "id": "3f2a8c14-…",
      "service": "GitHub",
      "accountLabel": "工作账号",
      "sourceFileName": "github-recovery-codes.txt",
      "note": "主账号，换手机前先看这里",
      "lowStockThreshold": 3,
      "reviewIntervalDays": 180,
      "firstImportedAt": 1785939042.016,
      "lastUpdatedAt": 1785939042.016,
      "lastCheckedAt": 1785939042.016,
      "remainingCount": 15,
      "contentChecksum": "sha256:1b7e…",
      "codes": [
        { "index": 0, "code": "a1b2c-d3e4f", "used": false, "usedAt": null, "suspect": false }
      ],
      "importHistory": [
        { "action": "import", "timestamp": 1785939042.0, "changeSummary": "首次导入16个密钥" }
      ]
    }
  ]
}
```

字段名统一用小驼峰，跟 `to_rpc_json()` 以及所有 RPC 一致（**存储层**用的是蛇形，
两者是不同的东西，不要混）。

几个容易踩的点：

- **`exportedAt` 一次导出只盖一个时间戳**，不在每组里各盖一次。v1 是后者，导致
  同一批数据每次导出、甚至同一次导出的不同组，时间都不一样，文件之间没法比对。
- **`suspect`** 是 OCR 易混字符的提示（`0/O`、`1/l/I`），只做标记不做拒绝——码本身
  完全可能真的包含这些字符。
- **`remainingCount`** 是派生值，导入时不读它，以 `codes` 为准。

## 三、校验

两层，各管各的事：

| 层 | 字段 | 覆盖范围 | 对不上时 |
|---|---|---|---|
| 整份 | `checksum` | 规范化后的整个 `groups` 数组 | 预览里报「文件被改动过」，仍允许导入 |
| 每组 | `contentChecksum` | 该组的 service/accountLabel/codes | 这一组判为损坏并隔离，其余组照常导入 |

**规范化的定义**（改一个字都会让所有既有文件的校验失效）：

```python
json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
```

三个参数缺一不可：`sort_keys` 让键序不影响结果，紧凑分隔符让缩进不影响结果，
`ensure_ascii=False` 让中文服务名按 UTF-8 参与计算而不是变成 `\uXXXX`。合起来的
效果是**校验算的是内容、不是字节**——用户拿编辑器重排过缩进的文件仍然被认成完好，
否则这个校验只会制造假警报。

逐组校验值复用金库存储层的 `_content_checksum()`，只有一份实现。

> **`checksumOk` 的三态**：`true` / `false` / `null`。`null` 表示这份文件根本没带
> 整体校验值（v1 就没有），**不是**「校验没过」。界面上必须分开处理，否则每打开一份
> 旧导出都会弹一次假警报，真警报也就没人看了。

## 四、加密形态

`encrypted: true` 时外层仍是可读的 JSON（认得出这是什么、用什么参数加的），内层
密文是完整的 v2 信封：

```json
{
  "format": "tessera-recovery-codes",
  "formatVersion": 2,
  "encrypted": true,
  "exportedAt": 1785939042.016,
  "appVersion": "0.1.5",
  "cipher": "AES-256-GCM",
  "kdf": { "algorithm": "scrypt", "n": 131072, "r": 8, "p": 1, "salt": "b64…" },
  "nonce": "b64…",
  "ciphertext": "b64…"
}
```

- 密码**独立于金库的 IMK**：泄露一份导出文件不该连带能开活库，反之亦然。
- 信封里**不写 `stats`、不写服务名**——「我在哪些网站有账号」本身就是需要保护的
  信息。代价是输入密码前预览不出规模，这个交换是值得的。
- KDF 参数跟着文件走：导出文件可能躺在只读介质上，永远没有机会被重新封装，所以
  「当年用的是什么参数」只有它自己记得住。
- **只接受我们自己写得出来的两个 `n`（2¹⁴ / 2¹⁷）。** 导入文件是不可信输入，照着
  它声称的数字去跑 scrypt，等于让一个字段就能点爆内存（`n=2⁴⁰` 要 1 TB）。

## 五、版本兼容

| 文件形态 | 读 | 写 | 说明 |
|---|---|---|---|
| v1 裸数组 | ✅ | ❌ | 用户机器上就躺着这样的旧导出。既然 v1 当年确实把 `used` 写进了文件，现在读回来是白捡的 |
| v2 明文信封 | ✅ | ✅ | 默认读法 |
| v2 加密信封 | ✅ | ✅ | 需要密码 |
| `formatVersion > 2` | ❌ | — | **明确报错，不猜着解析**：猜错等于把一份更新的备份当成损坏数据丢掉，而用户以为自己已经恢复过了 |

## 六、导入语义

无损导入走 `recovery_codes_json_import_preview` / `..._confirm` 两步（预览是纯粹的
试运行，一个字节都不落盘）。两步之间**刻意不缓存明文**：确认时重新读文件、重新
解密。代价是加密文件多跑一次 scrypt，换来的是后端内存里不会挂着一份用户随时可能
已经取消掉的明文恢复码。

差异四态复用完整备份那套 `diff_full_backup`：

| 状态 | 含义 | 可选策略 |
|---|---|---|
| `local_only` | 只有本地有 | —（不动） |
| `backup_only` | 只有文件里有 | `use_file`（默认） |
| `identical` | 码和已用状态都一致 | —（无需决策） |
| `conflict` | 两边都有但不一样 | `keep_local`（默认）/ `use_file` / `merge` |

**`merge` 时 `used` 取或**——两边任何一边说用过就是用过。这是唯一安全的方向：把一个
已经用掉的码当成可用的，会让人在真正需要的时候拿着一串废码被锁在门外。

默认值偏保守：覆盖和合并都要用户主动选，默认值不替人做出会丢数据的决定。

按文本走的旧入口（`recovery_codes_import_preview`）仍然认得 v2 文件，但**是有损的**
——`ParsedGroup` 只装得下码。它存在的意义是让一份 v2 文件被拖进「导入文件」时至少
把码导进来，而不是甩一句「格式不对」。

## 七、技术指标

| 项目 | 值 | 依据 |
|---|---|---|
| 格式标识 | `tessera-recovery-codes` | |
| 当前版本 | 2 | v1 只读，`>2` 拒绝 |
| 摘要算法 | SHA-256 | |
| 对称加密 | AES-256-GCM，nonce 12 B | 与金库信封同一套原语 |
| KDF | scrypt N=2¹⁷, r=8, p=1，salt 16 B | OWASP 推荐下限；单次派生约 128 MiB 内存 |
| KDF 参数白名单 | {2¹⁴, 2¹⁷} | 防止恶意文件触发内存耗尽 |
| 导出密码下限 | 8 字符 | 与完整备份一致 |
| JSON 导入文件上限 | **4 MiB** | 实测 100 服务 × 16 码的明文 v2 导出约 90 KiB，留四十倍余量 |
| 纯文本导入上限 | 1 MiB | 沿用既有 `MAX_IMPORT_FILE_SIZE` |
| 每组导入历史上限 | 50 条 | 沿用 `MAX_IMPORT_HISTORY` |
| 损坏降级粒度 | 单组 | 一条坏记录不拖垮整份文件 |
| 幂等性 | 同文件重复导入 → `identical`，零写入 | |
| 落盘 | 临时文件 + `os.replace` 原子替换 | 沿用 `save_recovery_codes_vault` |
| 分片 | 按组切，**绝不把同一组的码拆到两个文件** | 任何一片丢了都会变成一份看起来完整、实际缺码的清单 |

### 安全侧的默认值

| 行为 | 默认 | 理由 |
|---|---|---|
| 导出是否加密 | **是** | 把「明文落盘」设成默认，等于让最不安全的结果成为不做选择时的结果 |
| 明文导出 | 需勾选确认 | 一句红字可以被无视，一个必须点的勾不能 |
| 打开导出对话框 | 强制重新验证身份 | 与「导出完整备份」同一道门槛：都会把整套恢复码带离这台机器 |
| 「只导未用」 | 返回副本 | 就地过滤等于一次导出把本地的已用记录全抹掉 |
| 脱敏导出 | 与加密互斥 | 一个是「给人看」，一个是「存起来」；同时要求两者说明调用方没想清楚要什么 |

## 八、相关代码

| 位置 | 职责 |
|---|---|
| `modules/file_vault/recovery_codes.py` | 格式定义、导出、解析、校验、选择/分片 |
| `modules/file_vault/backend_server.py` | `recovery_codes_export_json` / `..._json_import_preview` / `..._json_import_confirm` |
| `modules/file_vault/ui/src/shared/ipcTypes.ts` | `RecoveryCodesJsonMeta` / `JsonImportDiffItem` |
| `modules/file_vault/ui/src/components/RecoveryCodesScreen.tsx` | 导出选项对话框、导入预览与决策 |
| `modules/file_vault/tests/test_recovery_codes.py` | 格式层用例 |
| `modules/file_vault/tests/test_backend_server.py` | RPC 层用例 |
| `modules/file_vault/ui/tests/recoveryCodesJsonExport.test.mjs` | 界面不变量 |
