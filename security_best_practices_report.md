# Tessera 安全最佳实践复核

复核日期：2026-07-29  
范围：Electron/React 桌面端、Python 文件保险库边界、Android 更新与设备列表相关改动。

## 执行摘要

- 本轮发现并修复 2 个中高优先级边界问题：Android 更新重定向未逐跳复核、4 个桌面更新 IPC 未显式校验 Renderer 来源。
- 未发现新增的明文密钥、任意命令执行、远程脚本、外部字体/CDN 或未清洗 HTML 注入。
- Electron 继续使用上下文隔离、禁用 Renderer Node 权限，并阻止新窗口和非白名单导航。
- 发布签名（Windows 与 Android）与依赖审计已在发布前补齐，见「已关闭」。
- 剩余的只有一条信息级事项：客户端侧“绝对防破解”做不到，只能提高成本。

## 已修复问题

### SEC-001 · 高 · Android 更新重定向可离开受信域

- 风险：只校验 GitHub API 返回的初始下载地址时，自动 30x 跳转可能把 APK 下载带到攻击者域名。
- 修复：关闭 `HttpURLConnection` 自动跳转；仅允许 HTTPS 的 GitHub/GitHubusercontent 域名，逐跳解析并复核，最多 5 次。
- 证据：`Updater.kt:159-209`；单测覆盖 HTTP、相似恶意域、`file:` URL、可信相对/绝对跳转和恶意跳转。

### SEC-002 · 中 · 桌面更新 IPC 缺少统一调用来源校验

- 风险：若 Renderer 发生意外导航或存在非受信 frame，更新检查/安装通道不应仅依赖参数约束。
- 修复：`update:getState`、`update:setAutoCheck`、`update:check`、`update:install` 均先执行 `assertTrustedRenderer(event)`。
- 证据：`main.ts:1731-1759`；`updateIpcSecurity.test.mjs` 验证全部更新 IPC 都拒绝非受信 Renderer。

## 已确认的安全基线

- Electron：`contextIsolation: true`、`nodeIntegration: false`（`main.ts:560-578`）。
- 导航边界：拒绝 `window.open`，仅允许受信本地页面导航（`main.ts:605-620`）。
- 富文本剪贴板：原始 HTML 经 DOMPurify 清洗，并显式禁用脚本、样式表、iframe、object、embed、form、link、meta（`ClipboardScreen.tsx:91-100`）。
- Markdown 预览：`markdown-it` 关闭原始 HTML，输出为解析器生成且转义后的 HTML（`NotesScreen.tsx:534-539`）。
- 运行指标：固定、无参数 IPC，不接受路径、命令或任意指标表达式；偏好值由枚举白名单归一化。
- Android APK：发布包通过 v2 签名验证，签名者 `CN=Tessera, O=Tessera, C=US`，证书 SHA-256 `33dd1913…`。

## 已关闭

### SEC-003 · 中 · 正式 Android 发布签名未配置 —— 已解决

- 现状：发布密钥已生成并置于仓库**之外**，构建时通过 `TESSERA_ANDROID_KEYSTORE_PROPS` 注入；
  不设该变量时产出未签名包（能编译、装不上），不会静默退回 Debug 签名。
- 证据：`apksigner verify --print-certs` 对发布 APK 输出 `CN=Tessera, O=Tessera, C=US`、
  SHA-256 `33dd1913066de50ed25144db4ed956197ecb53c5fd40cdcf93809f4a0a0db1d6`。

### SEC-004 · 低 · 在线依赖审计未完成 —— 已解决

- 本机 npm registry 指向 npmmirror，其 advisory 接口不可用，`npm run audit:ci` 会失败；
  指定官方源即可跑通：`npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org`。
- 结果：**0 个漏洞**（生产依赖，high 及以上门槛）。

## 未解决与后续

### SEC-005 · 信息 · 无法保证“绝对防破解”

- Electron/Android 客户端都能被静态分析；混淆、反调试和完整性检测只能增加攻击成本。
- 正确边界：敏感数据采用强加密与认证加密，密钥放 OS Keyring/Keystore，发布包验签，IPC/URL/文件路径最小权限，服务端或跨设备协议不信任客户端自报状态。

## 验证结果

- 桌面：52 项 Node 测试通过；ESLint 零警告；TypeScript 类型检查通过；Vite 生产构建成功。
- 桌面签名：安装版与免安装版 exe 的签名公钥指纹均与 `signer-policy.json` 里固定的值一致
  （自签根不受信，所以 `Get-AuthenticodeSignature` 的 Status 是 `UnknownError`，属预期）。
- Android：单元测试通过；**发布签名**包构建成功并通过 v2 验签；已确认 dex 内含逐跳复核逻辑。
- 依赖审计：生产依赖 0 漏洞（须指定官方 registry，见 SEC-004）。
- Python 受影响验证：完整初始化与密码解锁、RPC ok 合同测试均通过。
- 未执行：Android 真机/模拟器交互（本机无设备，也无可用模拟器）。
