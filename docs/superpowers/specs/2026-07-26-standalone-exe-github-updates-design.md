# File Vault 独立 EXE 与 GitHub 更新设计

**状态：用户确认，安全加固后待最终设计审查**

## 目标与验收

Ideal1 File Vault 发布为 Windows x64 单文件便携 EXE：目标电脑无需安装 Python、Node.js、pip 包或其他运行环境即可登录、读写数据和使用 Ctrl+V/Delete/Shift+Delete 全局功能。更新源为 `OWNER/REPO`（发布前在 updateService.ts 里填成自己的仓库） GitHub Releases。

1. 一个 `Ideal1 File Vault-Windows-<version>.exe` 可在没有 Python、源码树和开发环境变量的 Windows x64 用户配置中运行。
2. 数据稳定保存在 `%LOCALAPPDATA%\Ideal1 File Vault\data`，不依赖 源码树里的固定路径；旧数据迁移可重试且不丢失。
3. 设置页提供自动检查开关、手动检查、版本/状态和“立即更新”；自动检查只查元数据，绝不静默下载或替换。
4. 客户端只接受 `OWNER/REPO`（发布前在 updateService.ts 里填成自己的仓库） 的正式 Release，且必须通过内置 Ed25519 公钥验证更新清单签名；SHA-256 仅用于下载完整性。
5. 更新后新版本必须报告健康状态，否则自动恢复旧 EXE 并重启。
6. 发布版本生成 EXE、签名更新清单和 GitHub Release；没有签名私钥时发布失败，不产生客户端会接受的不可信更新。

## 独立运行时

Electron 保留为桌面壳，已打包模式绝不从 PATH 查找 Python。构建阶段生成两个 PyInstaller 冻结目标：

- `file_vault_backend.exe`：后端、Python 解释器和所有依赖，使用 one-file。
- `file_hook_worker` one-dir bundle：`hook_cli`、依赖和原生资源，供高频全局快捷键调用，避免每次按键解压 one-file。

二者作为 `extraResources` 放入外层 Electron portable EXE；外层仍是用户下载的唯一 EXE。开发模式继续运行源码解释器。

冻结配置显式收集 keyring 后端、pywin32、cryptography/sqlcipher 原生库、WebSocket、指纹 C 助手、C hook agent 与可选 UIA 脚本。统一 `runtime_resources` 解析器取代直接依赖源码 `__file__`：开发模式指向源码树，冻结模式指向 PyInstaller `_MEIPASS` 或稳定 hook runtime。

### 稳定的全局快捷键运行时

portable EXE 的 `resourcesPath` 是临时解压位置，不能用于开机自启动。应用会将 C hook agent、one-dir worker、指纹/可选 UIA 资源作为内容哈希 bundle 原子部署到 `%LOCALAPPDATA%\Ideal1 File Vault\FileHook\runtime-<digest>`。

Run 项只指向稳定 bundle。升级流程为：部署并验证新 bundle → 停止旧 agent → 启动新 agent → 原子更新 Run 项。任一步健康检查失败均恢复旧 Run 项和旧 agent。旧 bundle 在下一次成功启动后按保留上限清理，不立即删除。

## 数据目录与迁移

环境变量 `IDEAL1_FILE_VAULT_DATA_DIR` 优先；已显式指定时绝不自动迁移。否则使用 LocalAppData 路径：

1. 新目录已有身份库则直接使用。
2. 需要迁移时取得跨进程迁移锁，并要求旧实例关闭；不在旧后端写入时直接复制数据库。
3. 仅迁移允许清单中的身份、数据库、用户配置和附件；不迁移 VS Code 模板等开发资产。
4. SQLite 先 checkpoint，再用 SQLite backup API 得到一致副本；不直接裸复制 WAL/SHM。
5. 写入临时目录、校验、原子改名并写完成标记；失败可重试，不覆盖已有目标，也不删除旧目录。
6. 同一 Windows 用户下继续使用原 Credential Manager/keyring 服务名；迁移后执行真实密钥读取和身份解锁预检。预检失败保留旧目录并显示恢复说明。

## 更新机制

Electron 主进程提供 `updateService`：

- 请求 GitHub latest Release，只接受非 draft、非 prerelease、精确匹配 `v<严格 semver>` 且高于本机版本的 tag。
- 只接受唯一且精确命名的 EXE、`update-manifest.json`、`update-manifest.sig`；拒绝畸形资产、超大下载、非 GitHub 下载重定向和非文本说明。
- manifest 是未重新格式化的原始 UTF-8 字节，客户端必须先对该原始字节做 detached Ed25519 验签、再解析 JSON；schema 严格禁止未知字段与重复键，版本、资产名、大小、哈希、发布日期、说明、`signerKeyId` 均只能出现一次且必须完整。客户端用受信公钥环验证签名；签名失败、签名者不受信或未配置公钥时拒绝更新。
- 发布私钥位于独立且受人工审批保护的签名环境（本机离线密钥/HSM/不可由仓库工作流修改的签名服务）。GitHub Actions 仅构建并上传**已签名**资产，不能读取或任意使用私钥。
- 密钥轮换使用附加的严格 `key-rotations.json` 索引及逐项 detached 签名证书。每份原始 UTF-8 证书唯一包含连续 `sequence`、`previousSignerKeyId`、`nextSignerKeyId`、32 字节 Ed25519 `nextPublicKey` 与生效时间，并只能由 `previousSignerKeyId` 的私钥签名。客户端从硬编码或已原子持久化的公钥环出发，按连续 sequence 验证证书后才信任新的 `nextSignerKeyId`；相同 keyId 映射到不同公钥、断链、重复字段或缺失证书均拒绝更新。
- 检查更新时客户端先获取完整轮换索引与所有链证书，验证到 manifest 的 `signerKeyId` 后才验 manifest。因此跳过中间版本的旧客户端仍可从初始受信密钥验证完整链；链验证结果以备份加原子改名写入 `%LOCALAPPDATA%\Ideal1 File Vault\data\trusted-update-keys.json`，不因网络错误或失败安装污染现有公钥环。
- 用户点击“立即更新”后下载到目标 EXE 同卷临时文件，流式校验大小和 SHA-256。权限不足时给出手动下载路径。

便携应用通过 `PORTABLE_EXECUTABLE_FILE` 找到稳定外层 EXE，不使用临时 `process.execPath`。在主程序退出**前**，将嵌入的 update runner 复制并校验到 `%LOCALAPPDATA%\Ideal1 File Vault\updates\runner-<digest>`，在同一稳定目录创建事务日志、健康回执和下载暂存文件，再启动这个独立 runner；它在主 EXE 退出、outer portable 启动器清理临时资源后仍可运行。runner 记录事务：等待主进程退出、再次校验、将当前 EXE 版本化保留为 `.previous-<version>`、原子替换并启动新版本。

新版本以 `--post-update-health <transaction>` 启动；只有后端启动、窗口创建、数据目录可读后才写健康确认。runner 遇到替换失败、启动失败、超时或确认缺失时自动恢复旧 EXE 并重启，保留失败日志和下载文件。

签名清单是更新信任根；HTTPS、固定仓库、严格版本、精确资产名、下载上限和哈希为附加防护。Authenticode 代码签名不在本期范围。

## 设置、发布与测试

设置页新增“更新”区：自动检查开关默认开启；显示当前版本、上次检查、错误、更新版本/发布日期/说明；提供检查、立即更新与稍后。主进程做 24 小时节流，preload 暴露类型化 IPC，渲染端不直接访问网络或文件。

首次独立版为 `0.1.0`。发布脚本冻结两个运行时、构建 portable EXE、生成并签名 manifest、创建 `v<version>` Release 并上传资产。无签名私钥时失败。

- 单元测试：冻结资源/hidden-import 清单、稳定 hook runtime、迁移锁和 SQLite backup、Credential Manager 预检、manifest/semver/签名/哈希/更新状态机，以及从初始密钥跨越多个版本验证完整轮换证书链。
- UI 测试：更新设置 IPC、六语言 key 完整性。
- 构建测试：资源清单包含 backend、worker、C agent 和原生资源。
- 端到端：无 Python/源码树的 Windows VM（含非 ASCII 路径）验证最终 EXE、真实全局快捷键、重启后的 hook runtime。
- 故障注入：WAL 迁移中断/重试、恶意或损坏元数据、签名或哈希错误、超大下载、EXE 占用、新版启动失败和健康超时后的自动回滚、主 EXE 退出后 outer portable 启动器清理临时 resources 的 runner 存活与回滚时序，以及轮换链断裂、跳过中间版本、重复字段或 keyId 公钥冲突。

## 非目标

- macOS/Linux 更新。
- 静默安装更新。
- 删除旧应用数据或旧 EXE。
- Authenticode 证书采购。
