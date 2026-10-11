# 密码管理 v4 M1：历史版本数据模型与兼容迁移设计

日期：2026-07-17

## 1. 范围

本设计只覆盖密码管理 v4 的第一个里程碑：

- 每个密码账号保留一条当前主记录；
- 在主记录内嵌最近 5 个历史快照；
- 现有 version 1 加密密码库可直接读取；
- 后续保存时无损转换为 version 2。

本里程碑不实现 CSV 导入预览、账号匹配、列表折叠、排序设置、剪贴板清理或快捷键。这些功能将在后续里程碑复用本设计提供的数据能力。

## 2. 现状与约束

当前 [passwords.py](../../../modules/file_vault/passwords.py) 将所有 `PasswordEntry` 序列化成一个 JSON 数组，再使用现有身份主密钥体系进行 AES-256-GCM 加密。文件外层包含 `format_version`、文件密钥封装信息、随机数和密文。

现有条目包含：

- `id`
- `name`
- `url`
- `username`
- `password`
- `notes`
- `created_at`
- `updated_at`

当前 `updated()` 会用新值覆盖旧值，因此旧密码不可恢复。

设计约束：

1. 不改变现有加密边界，不把密码或历史版本拆成明文文件；
2. 不读取、打印或上传真实密码库内容；
3. 旧加密库必须能够自动读取，不要求用户手工迁移；
4. 迁移必须延迟到下一次正常保存，加载动作本身不改磁盘；
5. 历史上限固定为 5 条，避免文件无限增长；
6. 支持 Python 3.9。

## 3. 方案选择

采用“保留一条主记录 + 内嵌最近 5 个历史快照”。

未采用的方案：

- **每个历史版本作为独立 `PasswordEntry`**：需要额外的账号组标识，并会让去重、删除、列表和导出语义变复杂；
- **单独历史文件**：需要维护两份加密文件的一致性和原子更新，超出“每个账号最多 5 条历史”的实际需要。

内嵌快照不改变“一个账号对应一条主记录”的核心结构，能让后续列表和导入功能保持简单。

## 4. 数据结构

新增不可变语义的 `PasswordHistorySnapshot` 数据类：

```python
@dataclass(frozen=True)
class PasswordHistorySnapshot:
    name: str
    url: str
    username: str
    password: str
    notes: str
    updated_at: float
```

`PasswordEntry` 新增：

```python
history: List[PasswordHistorySnapshot] = field(default_factory=list)
```

每个快照记录更新前完整的用户可编辑字段和该版本原本的 `updated_at`。快照不包含：

- `id`：所有快照属于同一个主记录；
- `created_at`：账号初次创建时间只保留在主记录；
- `history`：禁止递归嵌套。

主记录序列化示例：

```json
{
  "id": "entry-id",
  "name": "GitHub",
  "url": "https://github.com",
  "username": "me",
  "password": "current-password",
  "notes": "current note",
  "created_at": 1784300000.0,
  "updated_at": 1784300300.0,
  "history": [
    {
      "name": "GitHub",
      "url": "https://github.com",
      "username": "me",
      "password": "previous-password",
      "notes": "previous note",
      "updated_at": 1784300200.0
    }
  ]
}
```

## 5. 更新行为

`PasswordEntry.updated()` 保持“返回新对象、不修改原对象”的现有约定，并执行以下步骤：

1. 使用当前主记录的用户可编辑字段及当前 `updated_at` 创建快照；
2. 把该快照放到现有 `history` 最前面；
3. 截取前 5 条；
4. 只调用一次 `time.time()`，生成包含新字段和新 `updated_at` 的主记录；
5. 保留原 `id`、`created_at`。

历史数组的位置是版本顺序的权威来源：索引 0 永远代表最近一次旧版本。`updated_at` 是事件元数据；系统时钟可能重复或回拨，所以不要求时间戳严格递增，加载时也不根据时间戳重排历史。

`new_entry()` 同样只获取一次时间，并把同一个值赋给 `created_at` 和 `updated_at`。

如果提交的所有可编辑字段与当前记录完全相同，则不创建历史快照、不刷新 `updated_at`，并返回原对象。后端 RPC 必须跳过加密文件写入，因此无变化保存不会迁移 version 1 文件。

## 6. 持久化结构与严格校验

外层 `FORMAT_VERSION` 从 1 升为 2。外层 JSON 和解密后的 JSON 都使用拒绝重复对象键的解析器：外层任意重复键返回 `password.invalid_format`；解密内容中的条目或快照出现重复键返回 `password.content_corrupted`。错误不得包含键对应的值。

外层 `format_version` 必须存在，且运行时类型必须**恰好是整数**（`type(value) is int`），只接受 1 或 2。布尔值、浮点数（包括 `1.0`/`2.0`）、字符串、null、容器、非有限数和缺失值返回 `password.invalid_format`；其他类型正确但不支持的整数返回 `password.unsupported_format_version`。

解密后的顶层必须是 JSON 数组；数组中的每一项必须是对象。

version 1 条目必须**恰好**包含八个旧字段：`id`、`name`、`url`、`username`、`password`、`notes`、`created_at`、`updated_at`。version 1 中出现 `history`（即使值为空列表）或任何未知字段时拒绝加载，避免攻击者只修改未认证的外层版本号，使 version 2 历史被静默丢弃。

version 2 条目必须包含上述八个字段；`history` 是唯一允许缺省的字段，缺省时按空列表读取。除这九个字段外不允许未知字段。每个历史快照必须恰好包含 `name`、`url`、`username`、`password`、`notes`、`updated_at` 六个字段，不允许未知字段或嵌套 `history`。

字段校验规则：

- `id`、`name`、`url`、`username`、`password`、`notes` 必须是字符串；
- `created_at`、`updated_at` 必须是有限的 JSON 数字，整数和浮点数均可，但布尔值、NaN、正负无穷和字符串均拒绝；
- `history` 必须是列表，长度在 0 到 5 之间；
- 历史数组中的每项必须通过完整快照校验；
- 加载和保存前都执行同一套结构校验；超过 5 条或其他结构错误一律拒绝，绝不在加载时静默截断或修复。

所有结构校验由显式解析函数完成，不能依赖 Python 数据类的类型注解，因为数据类不会在运行时自动检查类型。

## 7. 文件格式兼容与外部数据边界

读取规则：

- version 2：按上述 version 2 严格结构读取；
- version 1：按上述旧结构读取，并在内存中补 `history=[]`；
- 其他版本：返回 `password.unsupported_format_version`，不尝试解密或猜测格式。

保存规则：

- 所有发生实际数据变化的新保存统一写 `format_version: 2`；
- 保存前验证主记录和历史快照，非法内存对象不能写入磁盘；
- 历史快照随主记录一起进入现有加密 JSON；
- 继续使用临时文件加原子替换，保持现有崩溃安全性。

读取 version 1 时不立即重写文件。只有真正改变持久化条目集合或条目内容的操作后，文件才自然升级为 version 2。所有无实际变化的操作都必须跳过 `save_password_vault`、保持 vault 字节完全不变且不得触发迁移：精确重复的 `password_add`、字段相同的 `password_update`、删除数为 0 的批量删除、未找到重复项的去重，以及 CSV 为空或所有行均跳过。CSV 即使没有写入变化，若用户明确要求安全删除源文件，仍在成功解析并完成确认流程后删除源文件；源文件删除不算 vault 状态变化。

持久化序列化与 RPC 序列化必须分开：

- 持久化序列化包含 `history`；
- M1 的 `password_list`、`password_add`、`password_update` 响应保持现有公开形状，不返回 `history`，避免在历史查看 UI 尚未实现前扩大历史密码的暴露面；
- `password_add` 接受的键集合恰好为必需的 `name`、`url`、`username`、`password`，以及可选的 `notes`；`password_update` 额外必需 `id`。缺少必需键、提供 `history` 或其他未知键时返回 `{ "ok": false, "error": "password.invalid_request" }`，不得抛出内部 `KeyError` 或写盘；
- 更新必须以服务器已加载的主记录为基础调用 `updated()`，绝不从客户端字段重建一个 `history=[]` 的记录；
- 后续 M6 通过专用的“读取单条账号历史”接口按需返回历史，不复用列表接口批量发送全部旧密码；
- CSV 不能提供历史字段；M1 保持现有 CSV 新增/精确重复行为，新记录从空历史开始；“同网址+同用户名”的更新匹配、冲突策略和行顺序语义属于 M2/M3，不作为 M1 完成条件；
- CSV 导出永远只导出每条主记录的当前值，每个账号一行，绝不导出历史密码；
- 去重只有在当前五个用户字段和完整历史内容都等价时才删除；当前值相同但历史不同的记录必须全部保留，避免丢失独有历史。

## 8. 错误处理与安全

- 顶层、条目或历史快照违反上述结构时，统一返回 `password.content_corrupted`；
- 显式捕获并转换结构解析产生的 `KeyError`、`TypeError`、`ValueError`，错误信息不包含字段值；
- 解密标签错误仍返回 `password.key_mismatch`；
- version 1 外层包裹 version 2 内容属于损坏文件，拒绝加载且不改写文件；
- 不在日志、测试输出、异常文本中打印条目或历史内容；
- 历史版本与当前密码使用同一文件密钥和 AES-GCM 密文保护；
- 格式升级前的加密备份已保存在本机，路径记录于 [task-progress.md](../../../task-progress.md)。

## 9. 精确测试矩阵

所有解密内容结构错误均准确断言 `password.content_corrupted`；外层 JSON/版本结构错误准确断言 `password.invalid_format`；测试同时断言 vault 字节不变。

### 9.1 外层与版本

| 情况 | 期望 |
|---|---|
| `format_version` 缺失或重复 | `password.invalid_format` |
| 值为 `null`、`true`、`false`、`1.0`、`2.0`、NaN、正负无穷、字符串、数组或对象 | `password.invalid_format` |
| 值为整数 0、3 或其他未知整数 | `password.unsupported_format_version`，且不尝试解密 |
| 外层其他任意键重复 | `password.invalid_format` |

### 9.2 主记录与快照

对 version 1 主记录的八个必需字段、version 2 主记录的八个必需字段、快照的六个必需字段分别参数化执行：

- 逐个删除每个必需字段；
- 添加一个 `unexpected` 字段；version 1 还必须单独测试 `history: []`；
- 对每个文本字段分别替换为 `null`、布尔值、数字、数组和对象；
- 对每个时间字段分别替换为 `null`、布尔值、字符串、数组、对象、NaN、正无穷和负无穷；
- 把解密后的顶层值分别替换为 `null`、布尔值、数字、字符串和对象；
- 把顶层数组项或 history 数组项替换为 `null`、布尔值、数字、字符串和数组；
- 在解密后的条目和快照 JSON 中分别构造重复的 `password`、`updated_at`、`history`（适用时）和一个普通字段，验证重复键被拒绝。

version 2 的 `history` 单独测试：缺省和长度 0、5 为合法；值为 `null`、布尔值、数字、字符串、对象以及长度 6 为非法。保存前对所有能够构造的非法主记录字段、快照字段和 history 形状执行与加载端相同的参数化矩阵，确认拒绝写盘。

### 9.3 行为与迁移

1. **独立旧格式夹具**：不用新版序列化器，直接用加密原语构造只含八个旧字段、外层版本字面值为 1 的文件；加载后 `history == []`；
2. **延迟迁移**：只加载 version 1 后磁盘字节不变；有效修改并保存后外层版本为 2；
3. **无变化矩阵**：精确重复 add、同字段 update、未知 ID update/delete、删除数为 0、去重数为 0、空 CSV、CSV 全部跳过，均不调用保存、不迁移 version 1；另测按请求删除 CSV 源文件；
4. **请求边界**：按上文精确键集合测试 add/update 缺少每个必需键、提供 `history` 或未知字段时返回准确的 `password.invalid_request` 结果且不写盘；update 未提供 history 时服务器已有历史完整保留；
5. **新版往返**：含历史快照的 version 2 文件保存、加载后恢复为快照对象且字段完全一致；
6. **更新快照**：更新不修改原对象或原历史列表；主记录 ID 和 `created_at` 不变，旧字段进入 history；
7. **倒序与上限**：用确定性的模拟时钟连续有效更新 6 次，只保留最近 5 个旧版本，数组顺序正确；相同或倒退的时钟不改变数组权威顺序；
8. **创建时间一致**：新记录的 `created_at == updated_at`；
9. **伪降级防护**：保存含历史的 version 2 文件后只把外层版本改成 1，加载必须失败且文件字节不被重写；
10. **CSV M1 语义**：新账号历史为空；空文件、精确重复和跳过行不改历史、不写 vault；同账号更新匹配推迟至 M2/M3；
11. **外部边界**：列表/add/update RPC 不含 `history`；CSV 对含历史的主记录仍只导出一行当前值，导出内容不含旧密码；当前值相同但历史不同的两条记录运行去重后均保留，当前值和历史都相同才删除重复项；
12. **既有错误**：错误主密钥仍返回 `password.key_mismatch`，不受新结构解析影响。

测试使用临时目录和测试密钥，不操作真实 `modules/file_vault/data/passwords.vault`。

## 10. 完成标准

M1 只有在以下条件全部满足时完成：

- 所有上述测试通过；
- 现有密码相关测试无回归；
- Python 语法检查通过；
- 真实密码库未被测试或迁移命令修改；
- 提交中不包含用户现有的 UI 图标修改或密码库备份文件。
