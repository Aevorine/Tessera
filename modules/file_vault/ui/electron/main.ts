import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, shell, Tray } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { PythonBridge } from './pythonBridge'
import {
  DEFAULT_STARTUP_PREFERENCES,
  LOGIN_LAUNCH_ARG,
  effectiveOpenAtLogin,
  parseRegQueryApproved,
  parseRegQueryString,
  parseStartupPreferences,
  planLoginItemOnLaunch,
  shouldStartHidden,
} from './startupMode'
import type { LoginItemSnapshot, StartupPreferences } from './startupMode'
import { CrossDeviceBridge } from './crossDeviceBridge'
import { UpdateService, AUTO_CHECK_THROTTLE_MS, DEFAULT_UPDATE_SOURCE, parseUpdateSource } from './updateService'
import type { UpdateSourceId } from './updateService'
import { createProxyAwareFetch } from './proxyFetch'
import { createProcessGovernor } from './processGovernor'
import { allowThroughFirewall, firewallStatus } from './firewall'
import { verifySigner } from './authenticode'
import { requiredFreeBytes } from './updateVersion'
import { stripMarkupTags } from '../src/shared/plainText'
import { formatStartupReport, markStartup } from './startupTiming'
import {
  detectInstallFlavor,
  inspectTarget,
  readPostUpdateHealthArg,
  rememberExePath,
  resolveStableExePath,
  runInstallerAndQuit,
  stagingDirFor,
  startInstall,
  writeHealthReceipt,
} from './updateInstaller'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  AutoLockSettings,
  GlobalShortcutAction,
  GlobalShortcuts,
  RuntimeMetricsSnapshot,
  ShortcutBinding,
  VaultMethodName,
} from '../src/shared/ipcTypes'
import zhMenuLocale from './locales/zh.json'
import enMenuLocale from './locales/en.json'
import frMenuLocale from './locales/fr.json'
import esMenuLocale from './locales/es.json'
import ruMenuLocale from './locales/ru.json'
import arMenuLocale from './locales/ar.json'

createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建目录：dist/index.html、dist-electron/main.js 与 preload.js
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

/** 开机自启的注册表值名（HKCU\...\Run），同时是本应用的 AppUserModelId，两者必须是同一个字符串。
 *  Windows 上 `setLoginItemSettings` 可用 `name` 指定值名，但 `getLoginItemSettings` 没有该参数，
 *  固定按 AppUserModelId 读；两者不一致时写入成功而回读永远 false，设置页会报"系统未保存开机自启动设置"。
 *  setAppUserModelId 之后读写同名；顺带修好任务栏图标归组和通知归属。 */
const AUTOSTART_REGISTRY_NAME = 'com.ideal1.filevault'
app.setAppUserModelId(AUTOSTART_REGISTRY_NAME)

/** 登录项要登记的 exe：免安装版必须是用户双击的那个稳定路径，理由见 createWindow 里
 *  autoStartExePath 那段注释。 */
const LOGIN_ITEM_EXE_PATH = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
/** 登录项固定带这个参数——靠它分辨"开机自启拉起来的"，见 startupMode.ts 顶部。 */
const LOGIN_ITEM_ARGS = [LOGIN_LAUNCH_ARG]
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const STARTUP_APPROVED_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const STARTUP_PREFS_FILE = path.join(app.getPath('userData'), 'startup-preferences.json')
const execFileAsync = promisify(execFile)

function loadStartupPreferences(): { preferences: StartupPreferences; firstRun: boolean } {
  try {
    const parsed = parseStartupPreferences(JSON.parse(fs.readFileSync(STARTUP_PREFS_FILE, 'utf-8')))
    return { preferences: parsed ?? { ...DEFAULT_STARTUP_PREFERENCES }, firstRun: false }
  } catch (err) {
    // 只有"文件不存在"才算第一次。文件在但读坏了，照默认值静默启动，但**不**重新
    // 登记开机自启——不能因为一个坏文件就把用户关掉的自启悄悄打开。
    return {
      preferences: { ...DEFAULT_STARTUP_PREFERENCES },
      firstRun: (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
    }
  }
}

function saveStartupPreferences(preferences: StartupPreferences): void {
  fs.mkdirSync(path.dirname(STARTUP_PREFS_FILE), { recursive: true })
  const tmp = `${STARTUP_PREFS_FILE}.part`
  fs.writeFileSync(tmp, JSON.stringify(preferences), 'utf-8')
  fs.renameSync(tmp, STARTUP_PREFS_FILE)
}

const loadedStartupPreferences = loadStartupPreferences()
let startupPreferences: StartupPreferences = loadedStartupPreferences.preferences
let startupPreferencesFirstRun = loadedStartupPreferences.firstRun
/** 这一次是不是开机自启拉起来、且该静默。只在第一次建窗口时消费一次。 */
let startWindowHidden = app.isPackaged && shouldStartHidden(process.argv, startupPreferences)

async function regQuery(key: string, valueName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', valueName], { windowsHide: true, encoding: 'utf-8' })
    return stdout
  } catch {
    return '' // 值不存在时 reg.exe 以非零退出，这里就是"没有"
  }
}

/**
 * 读登录项现状。命令行是否一致交给 Electron 比（它按 Unicode 读注册表；
 * reg.exe 输出走控制台代码页，中文路径会乱码）。reg.exe 只回答两个与编码无关的问题：
 * 本应用值名下有没有登记、StartupApproved 里是否被禁用。
 */
async function readLoginItemSnapshot(): Promise<LoginItemSnapshot> {
  const settings = app.getLoginItemSettings({ path: LOGIN_ITEM_EXE_PATH, args: LOGIN_ITEM_ARGS })
  if (process.platform !== 'win32') {
    return { exactMatch: settings.openAtLogin, staleCommand: false, approved: null }
  }
  const [runOutput, approvedOutput] = await Promise.all([
    regQuery(RUN_KEY, AUTOSTART_REGISTRY_NAME),
    regQuery(STARTUP_APPROVED_RUN_KEY, AUTOSTART_REGISTRY_NAME),
  ])
  const registered = parseRegQueryString(runOutput, AUTOSTART_REGISTRY_NAME) !== null
  const item = settings.launchItems?.find((entry) => entry.name.toLowerCase() === AUTOSTART_REGISTRY_NAME.toLowerCase())
  return {
    exactMatch: settings.openAtLogin,
    staleCommand: registered && !settings.openAtLogin,
    approved: item ? item.enabled : parseRegQueryApproved(approvedOutput, AUTOSTART_REGISTRY_NAME),
  }
}

/** `enabled` 写的是 StartupApproved（任务管理器「启动」页那个开关），修复旧登记时要原样保留。 */
function writeLoginItem(openAtLogin: boolean, enabled = true): void {
  app.setLoginItemSettings({
    openAtLogin,
    path: LOGIN_ITEM_EXE_PATH,
    args: LOGIN_ITEM_ARGS,
    name: AUTOSTART_REGISTRY_NAME,
    enabled,
  })
}

/** 启动时对一次账：第一次按默认值登记，旧登记补上参数；其余不碰。 */
async function reconcileLoginItemOnLaunch(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const action = planLoginItemOnLaunch(startupPreferencesFirstRun, await readLoginItemSnapshot())
    if (action.kind === 'register') writeLoginItem(true, action.enabled)
    if (startupPreferencesFirstRun) {
      saveStartupPreferences(startupPreferences)
      startupPreferencesFirstRun = false
    }
  } catch (err) {
    console.error('[startup] login item reconcile failed:', err)
  }
}

// 后端在两种模式下是两种不同的东西：
// - 开发：系统 Python 跑源码 `backend_server.py`，改完重启即可，无需冻结。
// - 已打包：跑 PyInstaller 冻结的 `file_vault_backend/file_vault_backend.exe`，自带解释器和依赖，
//   绝不从 PATH 找 python（目标机可以没有 Python，否则只在干净机器上才失败，最难发现）。
// 用 spawnTarget 一并表达"可执行文件 + 脚本参数"，不让 PythonBridge 去猜。
interface BackendSpawnTarget {
  command: string
  leadingArgs: string[]
}

const BACKEND_TARGET: BackendSpawnTarget = app.isPackaged
  ? {
      // one-dir 冻结产物：exe 在同名子目录里，旁边是解释器和依赖 DLL
      // （one-dir 为砍掉每次冷启动几十 MB 的自解压，见 packaging/file_vault_backend.spec 顶部）。
      command: path.join(process.resourcesPath, 'backend', 'file_vault_backend', 'file_vault_backend.exe'),
      leadingArgs: [],
    }
  : {
      // 开发模式的解释器可用 IDEAL1_BACKEND_PYTHON 指定。原先写死裸 'python'（PATH 上第一个），
      // 它可能没装 sqlcipher3 等依赖（依赖在仓库 .venv），后端必然崩，表现为应用能起来但任何操作无反应。
      // 端到端测试（tests/e2e/）也用它指向 .venv：改 PATH 太脆（Windows 环境变量名是 'Path'，
      // 而 Node 的 env 区分大小写，加错键就静默无效）。
      command: process.env.IDEAL1_BACKEND_PYTHON || 'python',
      leadingArgs: ['-X', 'utf8', path.join(process.env.APP_ROOT, '..', 'backend_server.py')],
    }

// IDEAL1_FILE_VAULT_DATA_DIR 在两种模式下都优先，显式指定就绝不自动迁移。
// 已打包模式不传 --data-dir（不再写死仓库路径，换机器会指向不存在的目录），
// 由后端 data_dir.resolve_data_dir() 决定：优先 %LOCALAPPDATA%，检测到源码树里有旧金库时做一次
// 带校验、可重试、不删旧数据的迁移（迁移需读身份库、用 SQLite backup API，都在 Python 侧）。
// 开发模式什么都不传，后端默认用源码树里的 data/。
const BACKEND_ARGS = process.env.IDEAL1_FILE_VAULT_DATA_DIR
  ? ['--data-dir', process.env.IDEAL1_FILE_VAULT_DATA_DIR]
  : []

// 跨设备同步守护进程：单独的 Go 可执行文件，不走 Python 后端。
// 理由见 modules/file_vault/crossdevice/docs/01-架构与技术原理.md §1：协议核心一份、三端共用
// （Windows 直接编译，Android 走 gomobile bind 成 .aar），三端各写加密和状态机 bug 会平方增长。
// 不持有金库密钥，有独立的设备长期密钥，所以生命周期跟随主窗口而非登录状态
// （已配对设备需要它常驻才能断联后自动连上）。
const CROSSDEVICE_COMMAND = app.isPackaged
  ? path.join(process.resourcesPath, 'crossdevice', 'tessera-crossdevice.exe')
  : path.join(process.env.APP_ROOT, '..', 'crossdevice', 'tessera-crossdevice.exe')

// 数据目录和金库分开：跨设备的设备身份、已配对设备名单、传输断点都放这里。
// 放 userData 下而不是金库目录里，是因为它在金库锁着的时候也要能读写。
const CROSSDEVICE_DATA_DIR = path.join(app.getPath('userData'), 'crossdevice')

let crossDevice: CrossDeviceBridge | null = null

/** 用户切去别的程序时让后端让出 CPU，见 processGovernor.ts。 */
const backendGovernor = createProcessGovernor()

function startCrossDeviceBridge(): void {
  if (crossDevice) return
  const deviceName = os.hostname() || 'Tessera PC'
  crossDevice = new CrossDeviceBridge(CROSSDEVICE_COMMAND, CROSSDEVICE_DATA_DIR, deviceName)

  crossDevice.setEventListener((e) => {
    // 本机剪贴板变化事件只给主进程用，不转发渲染进程。
    if (e.event === 'clip_changed') {
      if (clipTimer) onClipChanged()
      return
    }
    if (e.event === 'clip_watch') {
      setClipEventDriven(true)
      return
    }
    if (e.event === 'daemon_restarting') setClipEventDriven(false)
    // 收到别的设备发来的剪贴板内容 → 写进本机系统剪贴板。
    // 这一步必须在主进程做：渲染进程拿不到系统剪贴板的多格式写入能力。
    if (e.event === 'clip' && e.data) {
      writeIncomingClip(e.data as IncomingClip)
      // 写完立刻把指纹记下来，否则下一轮轮询会把刚收到的内容当成
      // "用户又复制了一次"再广播回去（见 noteClipboardWritten）。
      noteClipboardWritten()
    }
    // 守护进程就绪后才开始盯剪贴板：没有连接时发出去的每一条都只会白跑一趟。
    if (e.event === 'ready') {
      startClipboardWatcher()
      // 用户可能上次把自动同步关掉了。以守护进程存档里的开关为准，
      // 而不是每次启动都默认打开——那等于悄悄忽略他的选择。
      void crossDevice
        ?.call<{ clip_sync?: boolean }>('status')
        .then((s) => {
          const opts = (s as { options?: { clip_sync?: boolean } }).options
          if (opts && typeof opts.clip_sync === 'boolean') clipAutoSync = opts.clip_sync
        })
        .catch(() => {
          /* 拿不到就保持默认开启 */
        })
    }
    sendToRenderer('crossdevice:event', e)
  })
  crossDevice.start()
}

interface IncomingClip {
  reps?: Array<{ mime: string; data?: string }>
  preferred?: string
}

/**
 * 把收到的跨设备剪贴板内容写进系统剪贴板，一次写入所有可用表示，让目标应用自选；
 * 只写纯文本会让富文本粘到 Word 里丢格式、公式退化成源码。
 */
function writeIncomingClip(clip: IncomingClip): void {
  const reps = clip.reps ?? []
  const decode = (mime: string): Buffer | null => {
    const rep = reps.find((r) => r.mime === mime || r.mime.startsWith(mime))
    if (!rep?.data) return null
    try {
      return Buffer.from(rep.data, 'base64')
    } catch {
      return null
    }
  }

  const png = decode('image/png')
  if (png) {
    const img = nativeImage.createFromBuffer(png)
    if (!img.isEmpty()) {
      clipboard.writeImage(img)
      return
    }
  }

  const payload: { text?: string; html?: string; rtf?: string } = {}
  const text = decode('text/plain')
  const html = decode('text/html')
  const rtf = decode('application/rtf')
  if (text) payload.text = text.toString('utf-8')
  if (html) payload.html = html.toString('utf-8')
  if (rtf) payload.rtf = rtf.toString('utf-8')
  // 纯文本兜底永远要有：没有它的话，只认 CF_UNICODETEXT 的老程序什么都粘不到。
  if (!payload.text && payload.html) payload.text = stripMarkupTags(payload.html)
  if (Object.keys(payload).length === 0) return
  try {
    clipboard.write(payload)
  } catch {
    // 富格式写入失败（剪贴板被别的程序占着、RTF 不合法）时至少把纯文本放进去——
    // 什么都不写等于这次同步白做，而用户根本不知道失败了。
    if (payload.text) {
      try {
        clipboard.writeText(payload.text)
      } catch {
        /* 剪贴板被占用，放弃这一条 */
      }
    }
  }
}

/**
 * 读当前系统剪贴板，转成守护进程要的多表示结构。图片与文本互斥：
 * Windows 截图时剪贴板常同时有 CF_BITMAP 和无用的文件名文本，都发会让对端粘出文件名。
 */
function readLocalClipboard(): { preferred: string; reps: Array<{ mime: string; data: string }> } | null {
  const reps: Array<{ mime: string; data: string }> = []
  const push = (mime: string, buf: Buffer) => reps.push({ mime, data: buf.toString('base64') })

  const img = clipboard.readImage()
  if (!img.isEmpty()) {
    push('image/png', img.toPNG())
    const alt = clipboard.readText()
    if (alt) push('text/plain;charset=utf-8', Buffer.from(alt, 'utf-8'))
    return { preferred: 'image/png', reps }
  }

  const text = clipboard.readText()
  if (!text) return null
  push('text/plain;charset=utf-8', Buffer.from(text, 'utf-8'))

  const html = clipboard.readHTML()
  if (html && html !== text) push('text/html', Buffer.from(html, 'utf-8'))
  const rtf = clipboard.readRTF()
  if (rtf) push('application/rtf', Buffer.from(rtf, 'utf-8'))

  return { preferred: 'text/plain;charset=utf-8', reps }
}

// 剪贴板跨设备自动同步：复制动作本身触发同步，不该让用户去面板按"发送剪贴板"。
//
// 事件驱动：守护进程用 AddClipboardFormatListener 监听，变了发 clip_changed，这里立即读，检测延迟接近 0，
// 也不再高频 OpenClipboard 抢别的程序的锁。守护进程报 clip_watch 之前（或它重启期间）退回 50 ms 轮询；
// 有事件源后轮询降到 CLIP_SAFETY_POLL_MS 只作兜底。
//
// 只比较指纹：文本直接用内容（小，长度相同内容不同也不漏发），超过 SAMPLE_SPAN 的长文本改存哈希。
// 图片曾每轮 `toBitmap()` 复制整张位图再做 SHA-256（1920×1080 每次 8.3 MB），剪贴板里躺一张截图就一直烧 CPU。
// 现在：1. 先问 `availableFormats()`，没有图片格式就不碰 `readImage()`；
// 2. 有图时 `readImage()` 解码和 `toBitmap()` 整张复制无便宜替代，所以图片路径用更慢的探测节奏
// IMAGE_PROBE_MS，哈希只取首/中/尾各 32 KB。代价：尺寸相同且这三段字节全同的两张图会被当成同一张，
// 实际遇不到。
//
// 间隔 50 ms：平均检测延迟 25 ms，加局域网 RTT 一次复制到对端可用约 30–60 ms；再密没有意义且有害，
// Windows 剪贴板全局互斥（读前要 OpenClipboard），轮询太密会抢到别的程序，表现为偶尔 Ctrl+C 没反应。
//
// 只发最新一次复制：无历史队列，每轮只看当前内容，与上轮不同就发，中间被跳过的不补发。
const CLIP_POLL_MS = 50

/** 有事件源时的兜底轮询间隔。 */
const CLIP_SAFETY_POLL_MS = 1000

/** 守护进程的剪贴板事件源是否在工作。 */
let clipEventDriven = false

/** 采样哈希每段取多少字节，以及文本超过多长就改存哈希。 */
const SAMPLE_SPAN = 32 * 1024

/** 图片路径的探测间隔。解码 + 整张复制没有便宜替代品，所以单独放慢。 */
const IMAGE_PROBE_MS = 200

/** 上一轮看到的剪贴板指纹。null 表示还没开始看。 */
let lastClipFingerprint: string | null = null
let clipTimer: ReturnType<typeof setInterval> | null = null
let clipAutoSync = true
let clipSyncInFlight = false

/**
 * 对大块字节取采样摘要：首、中、尾各 SAMPLE_SPAN 字节加总长度。
 * 只用于判断"与上轮是否同一份内容"，不是密码学标识，读完整块正是要避开的；
 * 总长度一起进摘要，使仅被截短/追加的内容也能区分。
 */
function sampledDigest(buf: Buffer): string {
  const h = createHash('sha256')
  h.update(String(buf.length))
  if (buf.length <= SAMPLE_SPAN * 3) {
    h.update(buf)
  } else {
    const mid = (buf.length >> 1) - (SAMPLE_SPAN >> 1)
    h.update(buf.subarray(0, SAMPLE_SPAN))
    h.update(buf.subarray(mid, mid + SAMPLE_SPAN))
    h.update(buf.subarray(buf.length - SAMPLE_SPAN))
  }
  return h.digest('hex')
}

/** 上一次真正解码过的图片指纹，以及那次发生的时间（见 IMAGE_PROBE_MS）。 */
let lastImageFingerprint = ''
let lastImageProbeAt = 0

/**
 * 取廉价的剪贴板指纹：先问格式列表再决定读什么，没有图片时调 `readImage()`（会解码）纯属浪费；
 * 绝大多数轮询是文本或未变化，只需一次格式枚举加一次小文本读取。
 */
function clipboardFingerprint(now: number): string {
  const formats = clipboard.availableFormats()
  if (formats.some((f) => f.startsWith('image/'))) {
    // 距上次解码不足 IMAGE_PROBE_MS 就沿用上次结果；返回同一值即"这轮没变化"，
    // 图片最多晚 IMAGE_PROBE_MS 被发现，而不是每 50 ms 复制整张位图。
    if (lastImageFingerprint && now - lastImageProbeAt < IMAGE_PROBE_MS) {
      return lastImageFingerprint
    }
    const img = clipboard.readImage()
    lastImageProbeAt = now
    if (!img.isEmpty()) {
      const s = img.getSize()
      lastImageFingerprint = `img:${s.width}x${s.height}:${sampledDigest(img.toBitmap())}`
      return lastImageFingerprint
    }
  }
  // 走到这里说明当前不是图片：清掉缓存，否则下次真的换成图片时会先命中一个
  // 过期的指纹，把那一次复制整个漏掉。
  lastImageFingerprint = ''
  const text = clipboard.readText()
  if (text) {
    // 短文本直接进指纹（最准）；长文本改采样摘要，避免每轮拼一个巨大的字符串。
    return text.length <= SAMPLE_SPAN
      ? `txt:${text.length}:${text}`
      : `txh:${text.length}:${sampledDigest(Buffer.from(text, 'utf8'))}`
  }
  return 'empty'
}

/**
 * 这份剪贴板内容是否「不该被别的程序记录」。
 * Windows 密码管理器（KeePass / 1Password / Bitwarden 等）复制密码时会额外放两个空标记格式，
 * 约定表示"别存历史、别同步、别上传"，系统剪贴板历史靠它跳过密码。
 * 自动同步必须认这个标记：每 200 ms 扫一次的监听器会在复制主密码的瞬间把它推给所有已配对设备，
 * 包括不在手边的。读不到这些格式（非 Windows 或不存在）返回 false，按普通内容处理。
 */
function isClipboardSensitive(): boolean {
  try {
    // 标记格式的内容是空的，**存在与否本身就是信号**，所以只看格式列表，
    // 不去读它的内容（readBuffer 对不存在的格式会抛，而且读了也没意义）。
    const formats = clipboard.availableFormats()
    // ExcludeClipboardContentFromMonitorProcessing 是 Windows/密码管理器约定的明确排除标记；
    // CanIncludeInClipboardHistory 是"允许历史记录"的正向标记，不能当敏感内容，否则普通复制会被无声吞掉。
    return formats.includes('ExcludeClipboardContentFromMonitorProcessing')
  } catch {
    // 读不到格式列表就按普通内容处理。这里保守到"一律不发"反而更糟：
    // 某个平台上枚举失败就等于整个同步功能静默失效。
    return false
  }
}

/**
 * 上一条还在发的时候用户又复制了新内容：记下来，等上一条回来立刻补发最新的。
 * 以前这种情况直接 return，而指纹已经更新成新内容——那次复制就永远不会再被发出去。
 */
let clipSyncQueued = false

/** 把当前剪贴板发给所有已连接设备。失败静默——同步是锦上添花，不该弹错误框。 */
function pushClipboardNow(): void {
  if (!crossDevice?.isAvailable()) return
  if (clipSyncInFlight) {
    clipSyncQueued = true
    return
  }
  if (isClipboardSensitive()) return
  let local: ReturnType<typeof readLocalClipboard>
  try {
    local = readLocalClipboard()
  } catch {
    // 别的程序正锁着剪贴板。清掉指纹让下一轮轮询重读一次，否则这次复制就丢了。
    lastClipFingerprint = null
    return
  }
  if (!local) return
  clipSyncInFlight = true
  crossDevice
    .call('send_clip', local)
    .catch(() => {
      /* 没有在线设备、或守护进程正在重启：守护进程重连后会自己补发最新一条 */
    })
    .finally(() => {
      clipSyncInFlight = false
      if (clipSyncQueued) {
        clipSyncQueued = false
        pushClipboardNow()
      }
    })
}

/** 看一次剪贴板，变了就发。返回 false 表示这次没读到（被锁或暂时为空），值得稍后重试。 */
function checkClipboardOnce(): boolean {
  if (!clipAutoSync || isPaused) return true
  let fp: string
  try {
    fp = clipboardFingerprint(Date.now())
  } catch {
    return false // 别的程序正锁着剪贴板
  }
  if (fp === 'empty') return false
  if (fp === lastClipFingerprint) return true
  lastClipFingerprint = fp
  pushClipboardNow()
  return true
}

/** clip_changed 到达：立即读；写入方刚放手时偶尔读不到，短间隔补读两次。 */
function onClipChanged(): void {
  if (checkClipboardOnce()) return
  let tries = 0
  const retry = () => {
    if (checkClipboardOnce() || ++tries >= 3) return
    setTimeout(retry, 15)
  }
  setTimeout(retry, 15)
}

function startClipboardWatcher(): void {
  if (clipTimer) return
  // 启动时只记指纹不发送：刚启动时剪贴板里是很久以前复制的内容，
  // 当作"刚发生的复制"广播会覆盖所有设备上各自的剪贴板。
  lastClipFingerprint = clipboardFingerprint(Date.now())
  clipTimer = setInterval(checkClipboardOnce, clipEventDriven ? CLIP_SAFETY_POLL_MS : CLIP_POLL_MS)
}

function stopClipboardWatcher(): void {
  if (!clipTimer) return
  clearInterval(clipTimer)
  clipTimer = null
}

/** 事件源上线 / 掉线时换轮询档位。 */
function setClipEventDriven(on: boolean): void {
  if (clipEventDriven === on) return
  clipEventDriven = on
  if (!clipTimer) return
  clearInterval(clipTimer)
  clipTimer = setInterval(checkClipboardOnce, on ? CLIP_SAFETY_POLL_MS : CLIP_POLL_MS)
}

/**
 * 收到对端内容写进本机剪贴板后，同步更新指纹。
 * 否则下一轮轮询会发现"变了"又广播回去；Go 侧回环抑制（Tracker.MarkWritten）只是 5 秒时间窗，
 * 且本机仍会白跑一次完整读取和编码，从源头不触发更可靠。
 */
function noteClipboardWritten(): void {
  try {
    // 必须绕过图片路径的节流缓存重新解码：沿用缓存拿到的是写入之前那张图的指纹，
    // 下一轮会把刚收到的图当成用户新复制的再广播回去。清掉时间戳即可强制重新探测。
    lastImageProbeAt = 0
    lastImageFingerprint = ''
    lastClipFingerprint = clipboardFingerprint(Date.now())
  } catch {
    /* 读不到就算了，最坏情况是多发一次，Go 侧会按内容哈希丢掉 */
  }
}

// 可自定义的全局快捷键（跨应用生效，窗口未聚焦也响应）。默认值特意选生僻组合避免抢占
// （笔记面板内另有仅聚焦时生效的本地 Ctrl+N，与此无关）。自定义值存 userData/global-shortcuts.json
// （与主题偏好 theme-preference.json 同模式），启动时读一次，设置页改动时经 system:setGlobalShortcuts 重新注册。
const DEFAULT_GLOBAL_SHORTCUTS: GlobalShortcuts = {
  toggleWindow: { key: 't', ctrl: true, alt: true, shift: false }, // Ctrl+Alt+T
  clipboardCapture: { key: 'v', ctrl: true, alt: false, shift: true }, // Ctrl+Shift+V
  quickNote: { key: 'n', ctrl: true, alt: false, shift: true }, // Ctrl+Shift+N
  openDevices: { key: 'd', ctrl: true, alt: true, shift: false }, // Ctrl+Alt+D
}
const GLOBAL_SHORTCUT_ACTIONS: GlobalShortcutAction[] = ['toggleWindow', 'clipboardCapture', 'quickNote', 'openDevices']

// 自动锁定：此前金库一旦解锁就一直解锁到应用退出，离座、合盖、Win+L 后仍全部可见。
// 锁定是整个换掉后端进程（见 pythonBridge.restartForLock）：主密钥只在该进程内存里，
// 换进程由操作系统保证页面不再属于我们，比在原进程里置 None 可靠。
// 默认：空闲 15 分钟、锁屏、睡眠都锁；藏进托盘不单独计时（0），因为会在用户只是收起窗口干别的时误锁。
const DEFAULT_AUTO_LOCK: AutoLockSettings = {
  idleMinutes: 15,
  trayMinutes: 0,
  onScreenLock: true,
  onSuspend: true,
}
let autoLock: AutoLockSettings = { ...DEFAULT_AUTO_LOCK }
// 巡查间隔。空闲时长最小可设 1 分钟，所以不能比一分钟长；也不必更短——
// 每次醒来只是问一次系统空闲秒数，但"每秒醒一次"仍会让笔记本无谓地不休眠。
const AUTO_LOCK_TICK_MS = 30_000
let autoLockTimer: NodeJS.Timeout | null = null
let hiddenSince: number | null = null
// 有没有解锁过。没解锁过就没有"锁定"这件事——那时候重启后端纯属白折腾，
// 还会让启动阶段的空闲计时把一个本来就在登录页的应用反复重启。
let vaultUnlocked = false
let pendingDevicesNavigation = false
// 哪些 RPC 成功之后算"金库开着了"。setup_complete 也算——首次设置走完就是解锁态。
const UNLOCK_METHODS: ReadonlySet<string> = new Set([
  'unlock_password',
  'unlock_totp',
  'unlock_recovery',
  'unlock_email_finish',
  'unlock_fingerprint',
  'setup_complete',
])

function autoLockFilePath(): string {
  return path.join(app.getPath('userData'), 'auto-lock.json')
}

function sanitizeAutoLock(raw: unknown): AutoLockSettings {
  const next = { ...DEFAULT_AUTO_LOCK }
  if (typeof raw !== 'object' || raw === null) return next
  const value = raw as Record<string, unknown>
  // 上限 720 分钟（12 小时）。再长就等于没开，而一个"开着但永远不触发"的开关
  // 比关着更糟——用户以为自己有保护。
  if (typeof value.idleMinutes === 'number' && Number.isFinite(value.idleMinutes)) {
    next.idleMinutes = Math.max(0, Math.min(720, Math.round(value.idleMinutes)))
  }
  if (typeof value.trayMinutes === 'number' && Number.isFinite(value.trayMinutes)) {
    next.trayMinutes = Math.max(0, Math.min(720, Math.round(value.trayMinutes)))
  }
  if (typeof value.onScreenLock === 'boolean') next.onScreenLock = value.onScreenLock
  if (typeof value.onSuspend === 'boolean') next.onSuspend = value.onSuspend
  return next
}

function loadAutoLock(): AutoLockSettings {
  try {
    return sanitizeAutoLock(JSON.parse(fs.readFileSync(autoLockFilePath(), 'utf-8')))
  } catch {
    return { ...DEFAULT_AUTO_LOCK } // 文件不存在（首次运行）或损坏，退回默认
  }
}

function saveAutoLock(settings: AutoLockSettings): void {
  try {
    fs.writeFileSync(autoLockFilePath(), JSON.stringify(settings), 'utf-8')
  } catch {
    // 写失败只影响下次启动读到的值，本次会话内的设置照常生效
  }
}

/** 把金库锁上。`reason` 只用于日志和给渲染端显示一句"为什么被锁了"。 */
function lockVault(reason: string): void {
  if (!vaultUnlocked) return
  vaultUnlocked = false
  hiddenSince = null
  console.log('[auto-lock] locking vault:', reason)
  sendToRenderer('vault:locked', reason)
  rebuildTrayMenu() // 「锁定金库」那一项要跟着消失，见 rebuildTrayMenu 里的注释
  bridge?.restartForLock()
}

function autoLockTick(): void {
  if (!vaultUnlocked) return
  if (autoLock.idleMinutes > 0) {
    // getSystemIdleTime 报的是**整个系统**的空闲秒数，不是本应用的。这正是想要的：
    // 用户在别的窗口里打字时金库不该被锁，人离开座位时才该。
    if (powerMonitor.getSystemIdleTime() >= autoLock.idleMinutes * 60) {
      lockVault(`idle ${autoLock.idleMinutes}m`)
      return
    }
  }
  if (autoLock.trayMinutes > 0 && hiddenSince !== null) {
    if (Date.now() - hiddenSince >= autoLock.trayMinutes * 60_000) {
      lockVault(`hidden ${autoLock.trayMinutes}m`)
    }
  }
}

function startAutoLockWatch(): void {
  if (autoLockTimer !== null) return
  autoLockTimer = setInterval(autoLockTick, AUTO_LOCK_TICK_MS)
  // 这两个事件不受巡查间隔影响，发生即锁——锁屏和合盖恰恰是最需要"立刻"的两个。
  powerMonitor.on('lock-screen', () => {
    if (autoLock.onScreenLock) lockVault('screen locked')
  })
  powerMonitor.on('suspend', () => {
    if (autoLock.onSuspend) lockVault('system suspended')
  })
  powerMonitor.on('shutdown', () => {
    if (autoLock.onSuspend) lockVault('system shutting down')
  })
}

function cloneGlobalShortcuts(source: GlobalShortcuts): GlobalShortcuts {
  return {
    toggleWindow: { ...source.toggleWindow },
    clipboardCapture: { ...source.clipboardCapture },
    quickNote: { ...source.quickNote },
    openDevices: { ...source.openDevices },
  }
}

let currentGlobalShortcuts: GlobalShortcuts = cloneGlobalShortcuts(DEFAULT_GLOBAL_SHORTCUTS)
// register 失败（组合键被系统里其他软件占用）不是错误，但设置页要能如实
// 展示"这条当前没注册上"，所以逐条记录注册结果。
let globalShortcutsRegistered: Record<GlobalShortcutAction, boolean> = {
  toggleWindow: false,
  clipboardCapture: false,
  quickNote: false,
  openDevices: false,
}

function isValidGlobalShortcutBinding(candidate: unknown): candidate is ShortcutBinding {
  if (typeof candidate !== 'object' || candidate === null) return false
  const binding = candidate as Record<string, unknown>
  if (
    typeof binding.key !== 'string' ||
    typeof binding.ctrl !== 'boolean' ||
    typeof binding.alt !== 'boolean' ||
    typeof binding.shift !== 'boolean'
  ) {
    return false
  }
  if (!/^[a-z0-9]$/i.test(binding.key)) return false // 单个字母/数字
  if (!binding.ctrl && !binding.alt) return false // 全局键必须至少带 Ctrl 或 Alt
  return true
}

function globalBindingSignature(binding: ShortcutBinding): string {
  return `${binding.key.toLowerCase()}|${binding.ctrl}|${binding.alt}|${binding.shift}`
}

// 全局键不能撞车：Electron 只让后注册的生效，先注册的静默失效，设置页却仍显示它。
// 两两比较而非写死某两条，以后加全局键无需改这里。
function hasDuplicateBinding(shortcuts: GlobalShortcuts): boolean {
  const seen = new Set<string>()
  for (const action of GLOBAL_SHORTCUT_ACTIONS) {
    const signature = globalBindingSignature(shortcuts[action])
    if (seen.has(signature)) return true
    seen.add(signature)
  }
  return false
}

function bindingToAccelerator(binding: ShortcutBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('CommandOrControl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  parts.push(binding.key.toUpperCase())
  return parts.join('+')
}

function globalShortcutsFilePath(): string {
  return path.join(app.getPath('userData'), 'global-shortcuts.json')
}

function loadGlobalShortcuts(): GlobalShortcuts {
  const result = cloneGlobalShortcuts(DEFAULT_GLOBAL_SHORTCUTS)
  let devicesMissing = true
  try {
    const raw = fs.readFileSync(globalShortcutsFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Record<GlobalShortcutAction, unknown>>
    devicesMissing = !isValidGlobalShortcutBinding(parsed.openDevices)
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const binding = parsed[action]
      if (isValidGlobalShortcutBinding(binding)) {
        result[action] = {
          key: binding.key.toLowerCase(),
          ctrl: binding.ctrl,
          alt: binding.alt,
          shift: binding.shift,
        }
      }
    }
  } catch {
    // 文件不存在（首次运行）或损坏——退回默认，不是需要上报的错误
  }
  if (devicesMissing && GLOBAL_SHORTCUT_ACTIONS.some((action) => action !== 'openDevices' && globalBindingSignature(result[action]) === globalBindingSignature(result.openDevices))) {
    for (const key of 'dyubabcdefghijklmnopqrstuvwxyz0123456789') {
      const binding = { key, ctrl: true, alt: true, shift: true }
      if (!GLOBAL_SHORTCUT_ACTIONS.some((action) => action !== 'openDevices' && globalBindingSignature(result[action]) === globalBindingSignature(binding))) {
        result.openDevices = binding
        break
      }
    }
  }
  if (hasDuplicateBinding(result)) {
    // 存的里头有两条互撞（正常保存路径拦得住，只可能是手改文件）→ 整体退回默认。
    // 按动作清单两两比，不是写死比某两条——以后再加一条全局键，这里不用跟着改。
    return cloneGlobalShortcuts(DEFAULT_GLOBAL_SHORTCUTS)
  }
  return result
}

function saveGlobalShortcuts(shortcuts: GlobalShortcuts): void {
  try {
    fs.writeFileSync(globalShortcutsFilePath(), JSON.stringify(shortcuts), 'utf-8')
  } catch {
    // 写入失败只影响下次启动读到的值，本次会话内已注册的快捷键照常工作
  }
}

function registerGlobalShortcuts(): void {
  // 整体重注册最简单也最不易漏。register 失败（如组合键被别的软件占用）不当错误处理，
  // 只是这次没注册上；没有不弹窗打断用户的安全办法去"抢"回来。
  globalShortcut.unregisterAll()
  const next: Record<GlobalShortcutAction, boolean> = { toggleWindow: false, clipboardCapture: false, quickNote: false, openDevices: false }
  try {
    // 呼出主窗口；已经在前台就收回托盘。跟托盘图标单击是同一个函数，
    // 所以「点托盘」和「按键」两条路的行为不可能分家。
    next.toggleWindow = globalShortcut.register(
      bindingToAccelerator(currentGlobalShortcuts.toggleWindow),
      () => toggleWindow()
    )
  } catch {
    next.toggleWindow = false
  }
  try {
    // 呼出主窗口并跳转到剪贴板面板
    next.clipboardCapture = globalShortcut.register(
      bindingToAccelerator(currentGlobalShortcuts.clipboardCapture),
      () => sendNav('clipboard')
    )
  } catch {
    next.clipboardCapture = false
  }
  try {
    // 全局速记：即使窗口最小化/藏到托盘，也先唤回再让渲染端打开一张新的
    // 空白笔记。渲染端另保留编辑器之外的本地 Ctrl+N 作为同窗口快捷键。
    next.quickNote = globalShortcut.register(bindingToAccelerator(currentGlobalShortcuts.quickNote), () => {
      sendQuickCapture()
    })
  } catch {
    next.quickNote = false
  }
  try {
    next.openDevices = globalShortcut.register(bindingToAccelerator(currentGlobalShortcuts.openDevices), () => {
      if (!vaultUnlocked) { pendingDevicesNavigation = true; showWindow() }
      else sendNav('crossdevice')
    })
  } catch { next.openDevices = false }
  globalShortcutsRegistered = next
}

let win: BrowserWindow | null
let bridge: PythonBridge | null
let tray: Tray | null = null
let isQuitting = false
let isPaused = false
let languageChangeDebounceHandle: ReturnType<typeof setTimeout> | null = null
const recentExportPaths: string[] = []

// 渲染端文件管理面板挂载/卸载时上报；Edit 菜单的复制/剪切/粘贴/删除据此决定走文件操作还是普通文字编辑
// （见 'filemanager:setActive' 的 ipcMain.on 与 buildTemplate 的 Edit 菜单 click）。
let fileManagerActive = false

// 系统级文件快捷键钩子的已知状态：启动时问一次 file_clip_hook_status，之后由渲染进程
// FileHookStatusCard / SettingsScreen 的 RPC 结果回传刷新，用于原生菜单 checkbox 的 checked。
// 钩子是独立进程，状态可被外部改变，不能像 alwaysOnTop 那样用 in-process 即时查询。
let fileHookEnabled = false

// 用"打开方式"选中本应用时，Windows 以 exe 路径 + 文件路径作命令行参数拉起新进程（见 setFileAssociationRegistered
// 写入的 shell\open\command），不是拖进已有窗口。从参数里找第一个真实存在且扩展名已关联的路径；
// 开发模式 argv 里是 vite/electron 自己的路径，不会误判。
const ASSOCIATED_EXTENSIONS = ['.txt', '.md', '.markdown']

function extractOpenPathFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const lower = arg.toLowerCase()
    if (!ASSOCIATED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
    if (fs.existsSync(arg)) return arg
  }
  return null
}

// 冷启动被"打开方式"拉起时记下待打开文件，由渲染端挂载后主动拉取（vault:takePendingOpenPath）而不是
// 这里 push：挂载早期渲染端可能还没订阅 IPC 事件，push 会丢。
let pendingOpenPath: string | null = extractOpenPathFromArgv(process.argv)

// 常驻托盘使"再次打开"入口很多（双击 exe、双击 txt、开始菜单），不加单实例锁每次都会多起一套
// Electron + Python 后端和托盘图标。抢锁失败就让新进程直接退出，由已在跑的实例在 'second-instance' 里处理。
const gotAppLock = app.requestSingleInstanceLock()
if (!gotAppLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow()
    const openPath = extractOpenPathFromArgv(argv)
    if (openPath) sendToRenderer('vault:open-text-file', openPath)
  })
}

// 文件"打开方式"关联只注册到 HKCU\...\Applications\<key>，让本应用出现在右键候选里，
// 不碰 HKCU\...\Classes\.<ext> 的默认程序。key 名是固定标识，不必与 exe 文件名一致
// （portable 包每次解压到不同临时目录，固定 key 才不会每次启动新增陈旧项）。
// shell\open\command 必须用 autoStartExePath（用户双击的稳定路径），不能用 process.execPath，原因同开机自启。
// 仅 Windows 有效，其它平台 reg.exe 会失败，调用方（Settings 页）需自行兜住。
// Applications\<key> 是所有扩展名共用的身份，只有 SupportedTypes 的值和各扩展名自己的 OpenWithList 项
// 按扩展名区分：判断是否已关联要查该扩展名的 OpenWithList 项，不能只看共享 key 是否存在；
// 取消关联只删该扩展名的 OpenWithList 项和 SupportedTypes 值，不删共享 key，否则连带断开其它扩展名。
const FILE_ASSOC_APP_KEY = 'Ideal1FileVault.exe'
const FILE_ASSOC_APPLICATIONS_KEY = `HKCU\\Software\\Classes\\Applications\\${FILE_ASSOC_APP_KEY}`
const FILE_ASSOC_PROMPT_MARKER = 'file-association-prompted.json'

function fileAssocOpenWithListKey(ext: string): string {
  return `HKCU\\Software\\Classes\\.${ext}\\OpenWithList\\${FILE_ASSOC_APP_KEY}`
}

function isFileAssociationRegistered(ext: string): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('reg', ['query', fileAssocOpenWithListKey(ext)], { windowsHide: true, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function setFileAssociationRegistered(ext: string, enabled: boolean, exePath: string): void {
  if (process.platform !== 'win32') {
    throw new Error('file association is only supported on Windows')
  }
  if (enabled) {
    // FriendlyAppName 是具名值而非 key 的 (Default)：Explorer 的"打开方式"靠它取显示名，写成 (Default) 读不到，
    // 只显示裸 exe 名。对不同扩展名重复调用是幂等的（/f 覆盖同值）。
    execFileSync('reg', ['add', FILE_ASSOC_APPLICATIONS_KEY, '/v', 'FriendlyAppName', '/d', 'Tessera', '/f'], {
      windowsHide: true,
    })
    execFileSync(
      'reg',
      ['add', `${FILE_ASSOC_APPLICATIONS_KEY}\\shell\\open\\command`, '/ve', '/d', `"${exePath}" "%1"`, '/f'],
      { windowsHide: true },
    )
    execFileSync('reg', ['add', `${FILE_ASSOC_APPLICATIONS_KEY}\\SupportedTypes`, '/v', `.${ext}`, '/d', '', '/f'], {
      windowsHide: true,
    })
    execFileSync('reg', ['add', fileAssocOpenWithListKey(ext), '/ve', '/d', '', '/f'], { windowsHide: true })
  } else {
    // 两条 delete 分开 try/catch：其中一条本来就不存在（比如上次注册中途
    // 失败过）不该让另一条也不执行。
    try {
      execFileSync('reg', ['delete', fileAssocOpenWithListKey(ext), '/f'], { windowsHide: true })
    } catch {
      // 本来就没有这个 key，忽略
    }
    try {
      execFileSync('reg', ['delete', `${FILE_ASSOC_APPLICATIONS_KEY}\\SupportedTypes`, '/v', `.${ext}`, '/f'], { windowsHide: true })
    } catch {
      // 本来就没有这个值，忽略
    }
  }
}

function fileAssociationPromptPath(): string {
  return path.join(app.getPath('userData'), FILE_ASSOC_PROMPT_MARKER)
}

function shouldPromptForFileAssociation(): boolean {
  if (process.platform !== 'win32') return false
  return !fs.existsSync(fileAssociationPromptPath())
}

async function promptForFileAssociation(exePath: string): Promise<void> {
  if (!shouldPromptForFileAssociation()) return
  try {
    const result = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['关联 txt 和 Markdown', '暂不设置'],
      defaultId: 0,
      cancelId: 1,
      title: 'Tessera',
      message: '是否将 txt、md 和 markdown 文件关联到 Tessera？',
      detail: '之后仍可在设置中单独调整文件关联。',
    })
    if (result.response === 0) {
      setFileAssociationRegistered('txt', true, exePath)
      setFileAssociationRegistered('md', true, exePath)
      setFileAssociationRegistered('markdown', true, exePath)
    }
  } finally {
    await fs.promises.writeFile(fileAssociationPromptPath(), JSON.stringify({ promptedAt: Date.now() }), 'utf-8').catch(() => {})
  }
}

function isTrustedRendererUrl(url: string): boolean {
  try {
    if (VITE_DEV_SERVER_URL) {
      return new URL(url).origin === new URL(VITE_DEV_SERVER_URL).origin
    }
    return url === pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href
  } catch {
    return false
  }
}

/**
 * 往渲染进程发消息的唯一入口。
 * `win` 非 null 不代表还能用：窗口关闭、渲染崩溃重载、应用退出时 BrowserWindow 还在但 webContents 已销毁，
 * send 会抛 `Render frame was disposed before WebFrameMain could be accessed`（退出时必现：
 * 后端被杀触发 vault:event 再发往已销毁的 webContents），关闭路径上抛出行之后的事都不会做。
 * 15 处调用原先各写 win?.，漏一处就复发，故收敛成这一个函数。
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  // 退出流程一开始就不再往渲染端发任何东西，这才是真正管用的闸：
  // 下面两道 isDestroyed() 都能过、try/catch 也拦不住，"Error sending from webFrameMain" 是
  // Electron 内部自己 catch 后打印的，根本没有异常抛到我们这层，只能从源头不发。
  // 退出时后端被杀会触发一串 vault:event，此时渲染端正在拆，没有接收者。
  if (isQuitting) return
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  // isDestroyed() 过了仍可能抛（实测）：WebContents 还活着，但其下 main frame 已销毁，
  // 公开 API 没有可靠问出"frame 还在不在"的办法，所以最后这道只能是 try/catch。
  // 吞掉是对的：能走到这里都是窗口正在消失，消息本来就没有接收者。
  try {
    wc.send(channel, ...args)
  } catch {
    /* 窗口正在消失，这条消息已经没有接收者 */
  }
}

/**
 * 往发起这次 IPC 的渲染端回推进度。与 sendToRenderer 同一个坑：进度回调发生在长任务中，
 * 正是用户最可能关窗口或应用退出的时刻，此时 event.sender 已销毁，send 会抛 "Render frame was disposed"。
 * 目标不是 win（可能是任意渲染端），所以单独成函数。
 */
function sendToSender(sender: Electron.WebContents, channel: string, payload: unknown): void {
  if (!sender || sender.isDestroyed()) return
  // 同 sendToRenderer：isDestroyed() 过了仍可能抛，见那边的长注释。
  try {
    sender.send(channel, payload)
  } catch {
    /* 发起这次调用的页面已经不在了，进度没人收 */
  }
}

function assertTrustedRenderer(event: IpcMainInvokeEvent) {
  // `senderFrame` 自 Electron 35 起可空：发起 IPC 的 frame 可能在主进程处理前已销毁（导航、关窗、崩溃重载）。
  // 必须 fail closed：空值意味着无法证明调用来自受信页面，而该断言是金库全部 IPC 的唯一门禁；
  // 多拒绝已消失 frame 的调用没有代价，没人在等结果。
  const frame = event.senderFrame
  if (!frame || !isTrustedRendererUrl(frame.url)) {
    throw new Error('Blocked IPC from untrusted renderer')
  }
}

// Dev-only: lets an external CDP client attach to the renderer, but only
// when explicitly requested. The dev app shares real vault data by default.
if (VITE_DEV_SERVER_URL && process.env.IDEAL1_ENABLE_REMOTE_DEBUGGING === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// 首次打开的窗口尺寸，抽成常量因为「窗口 → 恢复默认大小」要回到同一个值。
const DEFAULT_WINDOW_WIDTH = 1140
const DEFAULT_WINDOW_HEIGHT = 760

// 事件循环心跳（默认关，IDEAL1_LOOP_HEARTBEAT=1 打开）：
// 区分"界面卡住是主进程被同步操作堵死，还是在等异步结果"，两者表现相同但修法不同；堵死会打印停摆毫秒数。
if (process.env.IDEAL1_LOOP_HEARTBEAT === '1') {
  let __last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const gap = now - __last
    __last = now
    if (gap > 400) console.log('[loop] 停摆 ' + gap + 'ms @' + Math.round(now - performance.timeOrigin) + 'ms')
  }, 200)
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Tessera',
    icon: path.join(process.env.VITE_PUBLIC!, 'icon.ico'),
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    // 先不显示，等渲染端画完第一帧再显示（下面的 ready-to-show）：
    // 立刻出现的空白窗口看起来就是"启动很慢"，深色主题下白框一闪尤其刺眼。
    show: false,
    // 静默启动时让渲染端按"真的看不见"跑：默认 true 会让隐藏窗口首次加载时 document.visibilityState
    // 报 'visible'（实测），登录页据此开机就在后台弹 Windows Hello。关掉后报 'hidden'，JS 照常执行；
    // 代价是 ready-to-show 不再触发，静默启动本来不需要（兜底计时器会收掉 startWindowHidden）。
    paintWhenInitiallyHidden: !startWindowHidden,
    // ready-to-show 之前万一有任何一帧被合成出来（缩放、快照、某些显卡驱动），
    // 底色也跟应用一致而不是纯白。这是廉价的保险，不是主要手段。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      // .js（CommonJS）而不是 .mjs：沙箱化的 preload 没有 ESM 上下文，
      // 见 vite.config.ts 里 preload 输出格式那段长注释。
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程关进 Chromium 沙箱：即使页面脚本被攻破也不能直接发系统调用、读写文件、起进程。
      // 这是 contextIsolation 之外的另一层（那层隔的是脚本能否碰到 preload 变量）。
      sandbox: true,
    },
  })

  // 用 ready-to-show 而非 did-finish-load：前者是首帧可画，后者是资源全加载完，晚得多且不保证已渲染。
  // 兜底 timer：ready-to-show 极少数情况不触发（渲染进程启动失败、首帧被同步脚本卡住），
  // 没有兜底则窗口完全不出现、只剩托盘图标；宁可显示未画完的窗口。
  let shown = false
  const showOnce = (via: 'ready-to-show' | 'fallback-timer') => {
    if (shown || !win) return
    shown = true
    // 开机自启 + 静默启动：窗口照常创建、渲染端照常加载（后端、剪贴板同步、
    // 跨设备都要跑起来），只是不露面。点托盘图标或再双击一次 exe 才出来。
    if (startWindowHidden) {
      startWindowHidden = false
      console.log('[startup] window kept hidden (silent login start), via', via)
      return
    }
    // 记下窗口是被哪条路唤醒的：ready-to-show 是正常路径，fallback-timer 是 4 秒仍未画好而强行显示的问题路径，
    // 只记耗时看不出区别，而病因和修法不同。
    console.log('[startup] window shown via', via)
    markStartup('windowShown')
    win.show()
    // 账单在窗口出来后延迟 3 秒再打：backendReady 常晚于 windowShown，立刻打会永远缺这一项。
    // 3 秒是上限不是等待，后端到点仍未就绪则该项缺席本身就是结论。
    setTimeout(() => console.log(formatStartupReport()), 3000)
  }
  markStartup('windowCreated')
  win.once('ready-to-show', () => showOnce('ready-to-show'))
  setTimeout(() => showOnce('fallback-timer'), 4000)

  // 「藏进托盘多久之后锁」的起算点用窗口自己的 hide/show 事件，
  // 不在每处 hide() 调用点各记一次——漏一处整条规则就失效且无迹象。
  win.on('hide', () => {
    if (vaultUnlocked) hiddenSince = Date.now()
  })
  win.on('show', () => {
    hiddenSince = null
  })
  win.on('blur', () => {
    lastWindowBlurAt = Date.now()
  })

  // 只跟真实的窗口事件走，不在创建时判一次：静默自启时窗口从未有过焦点，
  // 那时就降级会拖慢后端冷启动。
  const syncForeground = () => {
    backendGovernor.setForeground(
      Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()),
    )
  }
  win.on('focus', syncForeground)
  win.on('blur', syncForeground)
  win.on('show', syncForeground)
  win.on('hide', syncForeground)
  win.on('minimize', syncForeground)
  win.on('restore', syncForeground)

  bridge = new PythonBridge(BACKEND_TARGET.command, BACKEND_TARGET.leadingArgs, BACKEND_ARGS)
  bridge.setSpawnListener((pid) => backendGovernor.adopt(pid))
  bridge.setEventListener((payload) => sendToRenderer('vault:event', payload))
  bridge.setFatalListener((detail) => {
    sendToRenderer('vault:backend-fatal', detail)
  })
  bridge.setRestartListener(() => {
    isPaused = false // 新进程里剪贴板服务是全新起的，不是"暂停"状态
    sendToRenderer('vault:backend-restarted')
  })

  startCrossDeviceBridge()
  markStartup('crossDeviceStarted')

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Chromium导航会把本地拖入的文件当作一次页面跳转；拦下导航并把已允许的
  // txt/md/markdown路径交给现有导入通道，避免拖文件意外把应用页面替换掉。
  win.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl.startsWith('file:')) {
      try {
        const droppedPath = fileURLToPath(navigationUrl)
        if (ASSOCIATED_EXTENSIONS.some((ext) => droppedPath.toLowerCase().endsWith(ext))) {
          event.preventDefault()
          sendToRenderer('vault:open-text-file', droppedPath)
          return
        }
      } catch {
        event.preventDefault()
        return
      }
    }
    if (!isTrustedRendererUrl(navigationUrl)) {
      event.preventDefault()
    }
  })

  // 常驻托盘：点右上角关闭只隐藏窗口，不退出 app（不杀还在监听剪贴板的 Python 后端）；
  // 真正退出走托盘菜单"退出"，先置 isQuitting 为 true 再 app.quit()。
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      hideWindow()
    }
  })

  // 跨设备面板的统一入口：渲染进程只发方法名和参数，协议在守护进程里。
  // send_clip 特殊：需读系统剪贴板而渲染进程没有这个能力（也不该有），由主进程读好并转成多表示结构再转发。
  ipcMain.handle('crossdevice:call', async (event, method: string, params: Record<string, unknown> = {}) => {
    assertTrustedRenderer(event)
    if (!crossDevice) throw new Error('跨设备服务未启动')

    if (method === 'send_clip' && !params.reps) {
      const local = readLocalClipboard()
      if (!local) throw new Error('clipboard.empty')
      // force：用户亲手按的发送，接收端不做回环去重，同一内容也照发不误。
      params = { ...params, ...local, force: true }
      // 手动按了"发送剪贴板"就把指纹对齐：否则轮询紧接着会发现"变了"
      // （其实是刚才那一份），再自动发一遍同样的内容。
      noteClipboardWritten()
    }
    // 时间线「再次粘贴」：正文由守护进程直接交给主进程写进系统剪贴板，
    // 不回传给渲染进程——列表页用不着正文，多走一趟只是多一份副本。
    if (method === 'clip_timeline_apply') {
      const res = await crossDevice.call<IncomingClip & { item_id?: string; errors?: string[] }>(method, params)
      // local:false：「发送剪贴板」多选发送，只推给其他设备，不改本机剪贴板。
      if (params.local !== false) {
        writeIncomingClip(res)
        // 写完立刻对齐指纹：否则下一轮轮询把它当成新复制又自动发一遍。
        noteClipboardWritten()
      }
      return { item_id: res.item_id, errors: res.errors ?? [] }
    }
    // 剪贴板自动同步的开关跟着 clip_sync 选项走，两个地方各存一份状态迟早
    // 会分叉——表现是界面上写着"已开启"，而本机压根没在监听。
    if (method === 'set_options' && typeof params.clip_sync === 'boolean') {
      clipAutoSync = params.clip_sync
    }
    return crossDevice.call(method, params)
  })

  ipcMain.handle('crossdevice:available', (event) => {
    assertTrustedRenderer(event)
    return {
      available: crossDevice?.isAvailable() ?? false,
      error: crossDevice?.getLastError() ?? null,
    }
  })

  // 防火墙查询无需权限，进「设备与同步」即可查并参与诊断；查的是守护进程那个 exe，不是 Electron 主程序，
  // 被 Windows 拦下的是它。
  ipcMain.handle('crossdevice:firewall-status', (event) => {
    assertTrustedRenderer(event)
    return firewallStatus(CROSSDEVICE_COMMAND)
  })

  // 添加规则会弹 UAC，所以只能由用户点按钮触发，绝不在启动时自动调用。
  ipcMain.handle('crossdevice:firewall-allow', (event) => {
    assertTrustedRenderer(event)
    return allowThroughFirewall(CROSSDEVICE_COMMAND)
  })

  // 在资源管理器里打开收件目录。路径取自守护进程的当前设置，不收渲染进程传来的路径。
  ipcMain.handle('crossdevice:open-download-dir', async (event): Promise<{ ok: boolean; error?: string }> => {
    assertTrustedRenderer(event)
    if (!crossDevice) return { ok: false, error: '跨设备服务未启动' }
    const s = await crossDevice.call<{ options?: { download_dir?: string } }>('status')
    const dir = s.options?.download_dir
    if (!dir) return { ok: false, error: 'download_dir_unset' }
    await fs.promises.mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('vault:call', async (event, method: VaultMethodName, params: unknown, progressToken?: string) => {
    assertTrustedRenderer(event)
    if (!bridge) throw new Error('Python backend is not running')

    // 指纹相关 RPC 自动附上主窗口的原生句柄，让 Windows Hello 弹窗显示在应用上方而非沉在任务栏；
    // params 已反序列化，直接改是安全的。
    const FINGERPRINT_METHODS = new Set<VaultMethodName>([
      'unlock_fingerprint',
      'rebind_fingerprint',
      'setup_verify_fingerprint',
    ])
    if (FINGERPRINT_METHODS.has(method)) {
      const p = (params as Record<string, unknown>) ?? {}
      if (!p.hwnd && win) {
        // Windows 上 getNativeWindowHandle 返回的 Buffer 装着 HWND，HWND 在所有 Windows 平台都放得进 32 位，ReadUInt32LE 足够。
        const hwndBuf = win.getNativeWindowHandle()
        p.hwnd = Number(hwndBuf.readBigUInt64LE())
      }
    }

    const call = bridge.call(method, params as never, (progress) => {
      sendToSender(event.sender, 'vault:progress', { method, progressToken, ...progress })
    })

    // 自动锁定要知道"现在是解锁状态"。不能在这里 await，会给每个 RPC 多一跳微任务；挂一个不改返回值的 then 即可。
    if (UNLOCK_METHODS.has(method)) {
      void call
        .then((result) => {
          if (result && typeof result === 'object' && (result as { ok?: boolean }).ok) {
            vaultUnlocked = true
            hiddenSince = win && !win.isVisible() ? Date.now() : null
            rebuildTrayMenu() // 「锁定金库」那一项这时候才该出现
          }
        })
        .catch(() => {
          // 解锁失败不是这里要处理的事，渲染端自己会拿到 reject
        })
    }

    // 生物识别之外的调用直接返回 —— 不多包一层 await/finally，免得给每一个
    // RPC 都加上一跳无谓的微任务。
    if (!FINGERPRINT_METHODS.has(method) && method !== 'unlock_fingerprint_cancel') return call

    const countsAsPrompt = FINGERPRINT_METHODS.has(method)
    if (countsAsPrompt) biometricCallsInFlight += 1
    try {
      return await call
    } finally {
      if (countsAsPrompt) biometricCallsInFlight = Math.max(0, biometricCallsInFlight - 1)
      // 凭据界面对主窗口模态：broker 弹框期间会 EnableWindow(FALSE)，正常收场时自己恢复，所以通常是无操作。
      // 这句为 helper 被强杀、broker 出问题、验证中途应用被切走的情况：窗口会永久拒绝输入（按钮可点却无反应，
      // 登录页"卡死"），渲染侧救不回来，只有主进程能调 EnableWindow。
      if (win && !win.isDestroyed()) {
        try {
          win.setEnabled(true)
          // 只给可见窗口抢焦点：Windows 上对隐藏窗口调 focus() 会把它显示出来，静默启动后登录页验证一收场就被拽到前台。
          if (win.isVisible()) win.focus()
        } catch {
          // 窗口正在销毁；没有窗口要救了。
        }
      }
    }
  })

  // 原生文件对话框/shell 集成：渲染端无直接文件系统访问（nodeIntegration: false），经主进程。
  // openFile 总是返回完整选择数组，单文件调用方读 [0]。
  ipcMain.handle('dialog:openFile', async (event, options?: Electron.OpenDialogOptions) => {
    assertTrustedRenderer(event)
    const result = await dialog.showOpenDialog(win!, options ?? {})
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('dialog:openDirectory', async (event, options?: Electron.OpenDialogOptions) => {
    assertTrustedRenderer(event)
    const result = await dialog.showOpenDialog(win!, { ...options, properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:saveFile', async (event, options?: Electron.SaveDialogOptions) => {
    assertTrustedRenderer(event)
    const result = await dialog.showSaveDialog(win!, options ?? {})
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('shell:showItemInFolder', (event, targetPath: string) => {
    assertTrustedRenderer(event)
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('app:getVersion', (event) => {
    assertTrustedRenderer(event)
    return app.getVersion()
  })

  /**
   * 打开外部链接（「关于」页的项目主页、许可证、第三方组件）。白名单在主进程而非渲染端。
   * `shell.openExternal` 把 URL 交系统按协议处理，能力远比看上去危险：`file:` 可启动本地可执行文件，
   * Windows 注册的自定义协议（`ms-msdt:` 等）历史上被反复用于远程代码执行，
   * 而渲染进程里有 Markdown、剪贴板富文本、OCR 文本这类不可信内容。
   * 所以只放行 https 且只放行本项目自己的域名；加条目前先想：域名被劫持或收购后用户点下去会怎样。
   */
  ipcMain.handle('shell:openExternal', async (event, rawUrl: string) => {
    assertTrustedRenderer(event)
    return openExternalChecked(rawUrl)
  })

  // 渲染端记住的"上次导入/导出文件夹"路径可能已被删除/改名/移动 - 弹系统
  // 对话框前先用这个查一下还在不在，不在就提示用户重选而不是硬塞给对话框。
  ipcMain.handle('fs:pathExists', (event, targetPath: string) => {
    assertTrustedRenderer(event)
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
    } catch {
      return false
    }
  })

  ipcMain.handle('system:getLocale', (event) => {
    assertTrustedRenderer(event)
    return app.getLocale()
  })

  // 文件管理面板浏览任意磁盘目录是通用文件系统读取，与保险箱加密内容无关，直接在主进程用 Node fs，
  // 不绕 Python NDJSON 管道（与 fs:pathExists / fs:writeBinaryFileBase64 同类先例）。
  // 真正的复制/剪切/粘贴/删除引擎（core/fileops）走 vaultAPI 到 Python 后端，这里只"看"不"改"。
  ipcMain.handle('fs:listDirectory', async (event, targetPath: string) => {
    assertTrustedRenderer(event)
    try {
      const dirents = await fs.promises.readdir(targetPath, { withFileTypes: true })
      const entries = await Promise.all(
        dirents.map(async (d) => {
          const full = path.join(targetPath, d.name)
          const isDirectory = d.isDirectory()
          let size = 0
          let mtimeMs = 0
          try {
            const stat = await fs.promises.stat(full)
            size = isDirectory ? 0 : stat.size
            mtimeMs = stat.mtimeMs
          } catch {
            // 权限不足/软链接悬空等——保留条目，size/mtime 留 0，不整条丢弃。
          }
          return { name: d.name, isDirectory, size, mtimeMs }
        })
      )
      return { ok: true, path: targetPath, entries }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 盘符下拉——本模块（file_clip 引擎）只服务 Windows，遍历 A-Z 用
  // existsSync 探测哪些盘符实际挂载，比调用外部命令简单可靠。
  ipcMain.handle('fs:listDrives', (event) => {
    assertTrustedRenderer(event)
    const drives: string[] = []
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`
      if (fs.existsSync(drive)) drives.push(drive)
    }
    return drives
  })

  // 双击文件用系统默认关联程序打开，跟资源管理器双击行为一致。
  ipcMain.handle('fs:openPath', async (event, targetPath: string) => {
    assertTrustedRenderer(event)
    const err = await shell.openPath(targetPath)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // 文件管理面板的"新建文件夹"工具栏按钮——跟目录浏览一样是纯本地文件系统
  // 操作，不经 Python 后端。
  ipcMain.handle('fs:makeDirectory', async (event, targetPath: string) => {
    assertTrustedRenderer(event)
    try {
      await fs.promises.mkdir(targetPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // "批量重命名"逐个调用的重命名原语，纯本地文件系统操作。目标名已存在时明确拒绝而不执行 rename
  // （各平台 fs.rename 对目标已存在是覆盖还是报错不一致），让渲染端能确定地识别冲突并追加序号，不会覆盖别的文件。
  ipcMain.handle('fs:renameEntry', async (event, oldPath: string, newPath: string) => {
    assertTrustedRenderer(event)
    try {
      if (fs.existsSync(newPath)) {
        return { ok: false, error: 'target_exists' }
      }
      await fs.promises.rename(oldPath, newPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 渲染端文件管理面板挂载/卸载各调一次——见上面 fileManagerActive 的声明。
  ipcMain.on('filemanager:setActive', (event, active: boolean) => {
    assertTrustedRenderer(event)
    fileManagerActive = active
    updateItemState('fileManagerDeleteRecycle', { enabled: active })
    updateItemState('fileManagerDeletePermanent', { enabled: active })
  })

  // 系统级文件快捷键钩子的 toggle 事件透传——菜单 checkbox 点击时触发，
  // 渲染进程 FileManagerScreen.tsx 监听同一事件并实际调 RPC。
  ipcMain.handle('filemanager:getHookEnabled', (event) => {
    assertTrustedRenderer(event)
    return fileHookEnabled
  })
  ipcMain.on('filemanager:setHookEnabled', (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    fileHookEnabled = enabled
    updateItemState('fileHookEnabled', { checked: enabled })
  })

  // 冷启动被 txt"打开方式"拉起时（见 pendingOpenPath），渲染端挂载后调这个取走一次并清空，
  // 避免应用重连（如后端崩溃自动重连）或切换页面时重复触发导入。
  ipcMain.handle('vault:takePendingOpenPath', (event) => {
    assertTrustedRenderer(event)
    const p = pendingOpenPath
    pendingOpenPath = null
    return p
  })

  // 开机自启用 Electron 的 setLoginItemSettings（写当前用户级注册表 Run 键），不用任务计划程序：
  // 官方标准做法，不弹 UAC。只有用户在设置页勾选才真的写入。
  // 本包是 electron-builder 的 portable 目标，运行时解压到临时目录，process.execPath 指向临时副本，
  // 写进注册表后临时目录被清理，自启就悄悄失效。故用 PORTABLE_EXECUTABLE_FILE（用户双击的稳定路径），
  // 开发模式没有该变量则退回 process.execPath。
  // getAutoStart 必须传与 setAutoStart 相同的 path，否则 Electron 拿默认值（portable 下每次不同）去比，
  // 永远不等，界面一直显示"未勾选"。
  const autoStartExePath = LOGIN_ITEM_EXE_PATH
  // 本应用自己是否官方签名（安全体检项）。与更新用同一个 SIGNER_POLICY（钉公钥，不钉证书链，
  // 自签名证书的链验证天然过不了，是记录在案的正常状态）；两处判据必须同源，否则面板与更新结论矛盾。
  // 开发模式 execPath 是 electron.exe，验它无意义，返回 null 使该项为「查不到」，避免报「未签名」一片红。
  ipcMain.handle('system:getSignatureStatus', async (event) => {
    assertTrustedRenderer(event)
    if (!app.isPackaged) return null
    const target = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
    try {
      const info = await verifySigner(target, UpdateService.signerPolicy())
      return { verified: true, publisher: info.simpleName ?? null }
    } catch (err) {
      return { verified: false, publisher: null, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  // 读写都走文件顶部的 readLoginItemSnapshot / writeLoginItem。
  // 回读无法指定注册表值名：Windows 上 getLoginItemSettings 只收 path 和 args，值名固定取 AppUserModelId，
  // 所以靠启动时 app.setAppUserModelId(AUTOSTART_REGISTRY_NAME) 把默认值名钉成同一个（见文件顶部）。
  // 勾选状态取"下次登录真的会启动"：在任务管理器里被禁用的登记不算勾上。
  ipcMain.handle('system:getStartupSettings', async (event) => {
    assertTrustedRenderer(event)
    return { openAtLogin: effectiveOpenAtLogin(await readLoginItemSnapshot()), silent: startupPreferences.silent }
  })
  ipcMain.handle('system:setAutoStart', async (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    writeLoginItem(enabled === true)
    if (startupPreferencesFirstRun) {
      // 用户已经亲手选过了，之后的启动不能再按"第一次"的默认值替他登记。
      saveStartupPreferences(startupPreferences)
      startupPreferencesFirstRun = false
    }
    return effectiveOpenAtLogin(await readLoginItemSnapshot())
  })
  ipcMain.handle('system:setSilentStart', (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    const next = { ...startupPreferences, silent: enabled === true }
    saveStartupPreferences(next)
    startupPreferences = next
    startupPreferencesFirstRun = false
    return next.silent
  })

  // 全局快捷键自定义：设置页读当前值/保存。保存成功即重新注册并持久化；`registered` 逐条反映 register 结果
  // （false=被其他软件占用，保存仍算成功，与启动时的容忍策略一致）。
  // 与文件管理器 5 条快捷键的互撞检查在渲染端保存前做（那里能拿到两份数据），这里只管全局键自身的合法性与互撞。
  ipcMain.handle('nav:takePendingDevices', (event) => {
    assertTrustedRenderer(event)
    if (!vaultUnlocked || !pendingDevicesNavigation) return null
    return 'crossdevice'
  })
  ipcMain.handle('nav:ackPendingDevices', (event) => {
    assertTrustedRenderer(event)
    if (vaultUnlocked) pendingDevicesNavigation = false
  })
  ipcMain.handle('system:getGlobalShortcuts', (event) => {
    assertTrustedRenderer(event)
    return { shortcuts: currentGlobalShortcuts, registered: globalShortcutsRegistered }
  })
  ipcMain.handle('system:setGlobalShortcuts', (event, incoming: unknown) => {
    assertTrustedRenderer(event)
    const parsed = (typeof incoming === 'object' && incoming !== null ? incoming : {}) as Partial<
      Record<GlobalShortcutAction, unknown>
    >
    const next = cloneGlobalShortcuts(DEFAULT_GLOBAL_SHORTCUTS)
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const binding = parsed[action]
      if (!isValidGlobalShortcutBinding(binding)) {
        return { ok: false as const, error: 'settings.shortcut_invalid' }
      }
      next[action] = {
        key: binding.key.toLowerCase(),
        ctrl: binding.ctrl,
        alt: binding.alt,
        shift: binding.shift,
      }
    }
    if (hasDuplicateBinding(next)) {
      return { ok: false as const, error: 'settings.shortcut_conflict' }
    }
    currentGlobalShortcuts = next
    saveGlobalShortcuts(next)
    registerGlobalShortcuts()
    return { ok: true as const, shortcuts: currentGlobalShortcuts, registered: globalShortcutsRegistered }
  })

  ipcMain.handle('system:getAutoLock', (event) => {
    assertTrustedRenderer(event)
    return autoLock
  })
  ipcMain.handle('system:setAutoLock', (event, incoming: unknown) => {
    assertTrustedRenderer(event)
    autoLock = sanitizeAutoLock(incoming)
    saveAutoLock(autoLock)
    // 改完立刻按新规则重新起算："藏进托盘 5 分钟"改成 1 分钟之后，不该还按
    // 旧值等着；同理关掉之后正在计的那次要作废。
    hiddenSince = win && !win.isVisible() && vaultUnlocked ? Date.now() : null
    return autoLock
  })
  // 手动锁定。有自动规则也仍然要有这一条：用户临时离开时，"我现在就锁"
  // 比"等 15 分钟"有用得多。
  ipcMain.handle('system:lockNow', (event) => {
    assertTrustedRenderer(event)
    lockVault('manual')
    return { ok: true as const }
  })

  ipcMain.handle('system:getTxtAssociation', (event) => {
    assertTrustedRenderer(event)
    return isFileAssociationRegistered('txt')
  })
  ipcMain.handle('system:setTxtAssociation', (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    setFileAssociationRegistered('txt', enabled, autoStartExePath)
  })

  // .md/.markdown 在用户眼里是同一个"Markdown文件"，一个开关同时控制两个扩展名：
  // 查询只看 .md 作代表，setter 保证两个扩展名的注册状态始终一起变化。
  ipcMain.handle('system:getMdAssociation', (event) => {
    assertTrustedRenderer(event)
    return isFileAssociationRegistered('md')
  })
  ipcMain.handle('system:setMdAssociation', (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    setFileAssociationRegistered('md', enabled, autoStartExePath)
    setFileAssociationRegistered('markdown', enabled, autoStartExePath)
  })

  // 语言同步：渲染端切换语言（或挂载后用真实偏好纠正冷启动的猜测）时调用，300ms 防抖；
  // 若实测有拖慢感可调到 150ms（见任务文档"效率优化"）。缓存命中时 buildAppMenu 直接 setApplicationMenu，
  // 未命中才 buildFromTemplate。
  ipcMain.handle('system:setLanguage', (event, lang: string) => {
    assertTrustedRenderer(event)
    if (languageChangeDebounceHandle) clearTimeout(languageChangeDebounceHandle)
    languageChangeDebounceHandle = setTimeout(() => {
      buildAppMenu(resolveMenuLang(lang))
      rebuildTrayMenu()
    }, 300)
  })

  // 渲染端主动拉取当前主题偏好，补 App.tsx 挂载时的首次同步：锁屏/初始化页没有 theme:sync 监听器，
  // 菜单切换会被静默错过，挂载时必须主动查真实值，不能只靠被动推送。
  ipcMain.handle('system:getThemePreference', (event) => {
    assertTrustedRenderer(event)
    return currentThemePreference
  })

  ipcMain.handle('system:setThemePreference', (event, pref: unknown) => {
    assertTrustedRenderer(event)
    if (pref !== 'system' && pref !== 'light' && pref !== 'dark') {
      throw new Error('invalid_theme_preference')
    }
    applyThemePreference(pref)
  })

  // Fixed, argument-free diagnostics snapshot. Renderer code cannot turn this
  // into arbitrary process inspection because no PID/path/command crosses IPC.
  ipcMain.handle('system:getRuntimeMetrics', (event) => {
    assertTrustedRenderer(event)
    const processes = app.getAppMetrics()
    const snapshot: RuntimeMetricsSnapshot = {
      capturedAtMs: Date.now(),
      cpuPercent: processes.reduce((sum, metric) => sum + Math.max(0, metric.cpu.percentCPUUsage), 0),
      // Electron reports the per-process memory figures in KiB.
      workingSetBytes: processes.reduce((sum, metric) => sum + Math.max(0, metric.memory.workingSetSize) * 1024, 0),
      privateMemoryBytes: processes.reduce(
        (sum, metric) => sum + Math.max(0, metric.memory.privateBytes ?? 0) * 1024,
        0,
      ),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      processCount: processes.length,
      uptimeSeconds: process.uptime(),
    }
    return snapshot
  })

  ipcMain.handle('system:copyDiagnostics', (event) => {
    assertTrustedRenderer(event)
    try {
      clipboard.writeText(collectDiagnostics())
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 剪贴板读写。渲染端一律走这两条，不许用 `navigator.clipboard`。
   *
   * 网页剪贴板 API 有两道闸，本应用都踩：
   * 1. 权限：`denyAllWebPermissions()` 拒掉所有网页权限（这是对的），含 `clipboard-sanitized-write` 和
   *    `clipboard-read`，写入报 `NotAllowedError: Write permission denied`。
   * 2. 焦点：即使放开权限也要求文档有焦点，而复制密码 30 秒后自动清空时用户早已切走，
   *    会抛 `Document is not focused`。渲染端无法修好，是 API 的设计前提不成立。
   *
   * `electron.clipboard` 直接调系统剪贴板，不经 Chromium 权限层也不看焦点，最小化/藏托盘/后台都能写。
   * 这不是放松安全：网页那套仍全程拒绝，渲染进程被 XSS 拿下也读不到剪贴板，只能调这条 IPC，
   * 而它由 `assertTrustedRenderer` 把着，只认本应用页面，能力从"任何渲染进程脚本"收窄到"本应用页面"。
   */
  ipcMain.handle('system:clipboardWriteText', (event, text: unknown) => {
    assertTrustedRenderer(event)
    // 只接受字符串：传入 undefined/对象时 Electron 会 String() 成 "undefined"/"[object Object]" 静默写进剪贴板，
    // 用户粘出垃圾而日志里没有任何记录，宁可在此明确失败。
    if (typeof text !== 'string') {
      return { ok: false, error: 'clipboard text must be a string' }
    }
    try {
      clipboard.writeText(text)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('system:clipboardReadText', (event) => {
    assertTrustedRenderer(event)
    try {
      return { ok: true, text: clipboard.readText() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('system:resetAppPreferences', (event) => {
    assertTrustedRenderer(event)
    try {
      currentThemePreference = 'system'
      nativeTheme.themeSource = 'system'
      fs.rmSync(themePreferenceFilePath(), { force: true })
      fs.rmSync(fileAssociationPromptPath(), { force: true })
      updateItemState('appearanceSystem', { checked: true })
      updateItemState('appearanceLight', { checked: false })
      updateItemState('appearanceDark', { checked: false })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 笔记导出 .pdf 用 Electron/Chromium 内置的 webContents.printToPDF()，不引入第三方 PDF 库：
  // 渲染质量等同打印预览，中文不乱码（jsPDF 类库需额外内嵌字体才能显示中文）。
  // 渲染端传来独立 HTML 字符串，这里用隐藏窗口加载再打印，不影响主窗口；
  // 先写临时文件再 loadFile 而非 data: URL，避免大笔记撑爆 data URL 长度上限。
  ipcMain.handle('document:exportPdf', async (event, html: string, savePath: string) => {
    assertTrustedRenderer(event)
    const tempHtmlPath = path.join(app.getPath('temp'), `ideal1-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
    const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
    try {
      await fs.promises.writeFile(tempHtmlPath, html, 'utf-8')
      await printWin.loadFile(tempHtmlPath)
      const pdfBuffer = await printWin.webContents.printToPDF({})
      await fs.promises.writeFile(savePath, pdfBuffer)
      recordRecentExport(savePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      printWin.destroy()
      await fs.promises.unlink(tempHtmlPath).catch(() => {})
    }
  })

  // 笔记导出 .docx：生成（Markdown token 流/纯文本→OOXML）是纯 JS 计算，完全在渲染端做；
  // 这里只负责渲染端做不了的最后一步，把二进制内容写盘（nodeIntegration:false，无直接文件系统访问）。
  ipcMain.handle('fs:writeBinaryFileBase64', async (event, targetPath: string, base64: string) => {
    assertTrustedRenderer(event)
    try {
      await fs.promises.writeFile(targetPath, Buffer.from(base64, 'base64'))
      recordRecentExport(targetPath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
  win.webContents.once('did-finish-load', () => {
    // 静默启动时窗口还藏着，这时弹"要不要关联文件"的对话框既没有上下文，也会
    // 把用户刚登录的桌面打断。等窗口第一次真的出来再问。
    if (win?.isVisible()) void promptForFileAssociation(autoStartExePath)
    else win?.once('show', () => void promptForFileAssociation(autoStartExePath))
  })
}

function showWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// 窗口上次失去焦点的时刻。点托盘图标本身就会让窗口先失焦（焦点先给了任务栏），
// 所以"刚刚还在前台"要用一个很短的回看窗口来判断。
let lastWindowBlurAt = 0
const TOGGLE_FOCUS_GRACE_MS = 400
// 在途的生物识别 RPC 数。窗口被藏起来时要把对它模态的 Hello 验证框撤掉，
// 否则那个框会挂在一个看不见的窗口上，直到超时。
let biometricCallsInFlight = 0

/** 藏进托盘（不在任务栏显示）。所有"隐藏主窗口"的入口都走这里。 */
function hideWindow() {
  if (!win) return
  if (biometricCallsInFlight > 0) {
    void bridge?.call('unlock_fingerprint_cancel', {} as never).catch(() => undefined)
  }
  win.hide()
}

// 托盘图标单击与全局快捷键共用的开关：窗口在前台就藏进托盘，否则（藏着、最小化、被挡住）一律唤到最前。
// 只看 isVisible 的话，被挡住的窗口按快捷键反而会消失，得再按一次。
function toggleWindow() {
  if (!win) {
    createWindow()
    return
  }
  const inFront =
    win.isVisible() &&
    !win.isMinimized() &&
    (win.isFocused() || Date.now() - lastWindowBlurAt < TOGGLE_FOCUS_GRACE_MS)
  if (inFront) {
    hideWindow()
  } else {
    showWindow()
  }
}

// 菜单栏"查看"和全局快捷键都要跳转到指定面板；值与渲染端 AppShell 的 Pane 联合类型一一对应，
// 这里不重复定义该类型，主进程只原样转发字符串。
function sendNav(pane: string) {
  showWindow()
  sendToRenderer('nav:show-pane', pane)
}

// Edit 菜单的复制/剪切/粘贴/删除到回收站/永久删除，在 fileManagerActive 时转发给渲染端文件管理面板；
// 面板内部把这五个动作也接到 Ctrl+C/X/V/Delete/Shift+Delete，键盘与菜单走同一套函数（见 FileManagerScreen.tsx）。
type FileManagerMenuAction = 'copy' | 'cut' | 'paste' | 'delete-recycle' | 'delete-permanent'
function sendFileManagerAction(action: FileManagerMenuAction) {
  sendToRenderer('filemanager:menu-action', action)
}

// 只发 'notes:quick-capture' 一个事件，不再额外发 'nav:show-pane'：
// 渲染端 AppShell 自己走 handleNavClick('notes') 切换面板（含笔记模块可能的解锁校验），成功后才把"新建笔记"交给 NotesScreen。
// 分别发两个事件时，开了强制解锁会在 NotesScreen 尚未挂载时就发出并丢失（Electron 不给后注册的监听器补发历史事件）。
function sendQuickCapture() {
  showWindow()
  if (win?.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => sendToRenderer('notes:quick-capture'))
  } else {
    sendToRenderer('notes:quick-capture')
  }
}

// --- 桌面菜单多语言 + 状态单一数据源（详见任务文档"桌面菜单强化"一节）---

// 启动时一次性加载全部语言字典进内存（6 种 × 约 35 个 key，不必按需加载）。
// 不复用渲染端 src/i18n/locales 的 11 个功能 namespace：那些混有与菜单无关的文案，
// 为几十个菜单 key 把它们打进主进程 bundle 浪费体积，也让两套无关内容耦合。
// 主进程没有组件树，不需要完整 i18next，只做按 key 查表。
const MENU_LOCALES = { zh: zhMenuLocale, en: enMenuLocale, fr: frMenuLocale, es: esMenuLocale, ru: ruMenuLocale, ar: arMenuLocale }
type SupportedMenuLang = keyof typeof MENU_LOCALES
type MenuLocale = typeof zhMenuLocale
const SUPPORTED_MENU_LANGS = Object.keys(MENU_LOCALES) as SupportedMenuLang[]

// 与渲染端 src/i18n/index.ts 的 resolveSupportedLanguage 同逻辑，各自维护一份很短的映射函数，
// 不强行共享：共享（跨 renderer/main 引入公共模块）的代价比重复这几行更高。
function resolveMenuLang(rawLocale: string): SupportedMenuLang {
  const prefix = rawLocale.split('-')[0].toLowerCase()
  return (SUPPORTED_MENU_LANGS as string[]).includes(prefix) ? (prefix as SupportedMenuLang) : 'en'
}

// 冷启动时渲染端尚未挂载、还没调用 system:setLanguage 纠正真实偏好，先用 app.getLocale() 猜语言建菜单；
// 与保存的偏好不一致会有一闪而过的文案不一致，是预期内可接受的（见 system:setLanguage 处）。
let currentMenuLang: SupportedMenuLang = resolveMenuLang(app.getLocale())

function getCurrentLocale(): MenuLocale {
  return MENU_LOCALES[currentMenuLang]
}

// Windows 下用 & 标记助记键（Alt+F 展开"文件"菜单）；macOS 没有这套约定，字面显示 `&` 会突兀，只在 win32 拼上。
// 只加在 5 个顶层菜单标签上（验收标准唯一明确要求的），二级子菜单项收益有限。
function mnemonic(label: string, letter: string): string {
  return process.platform === 'win32' ? `${label}(&${letter})` : label
}

// 状态更新用 itemRefs 直接改，不整树重建（验收标准 A14）：buildAppMenu 构建后把需动态控制的 MenuItem 引用存入 Map，
// 深色模式/置顶等状态变化只 updateItemState，不调用 buildAppMenu、不碰 menuCache；
// 只有语言切换需要整树重建（见文档③"多语言同步机制"）。
type MenuActionKey =
  | 'appearanceSystem'
  | 'appearanceLight'
  | 'appearanceDark'
  | 'alwaysOnTop'
  | 'fileManagerDeleteRecycle'
  | 'fileManagerDeletePermanent'
  | 'fileHookEnabled'
const itemRefs = new Map<MenuActionKey, Electron.MenuItem>()

// 模板携带 actionKey 标记；Menu.buildFromTemplate 产出的 MenuItem 不保留自定义字段，无法反查，
// 所以递归遍历结构相同的 template 和 menu.items 两棵树，把标了 actionKey 的节点的真实引用收进 itemRefs。
type MenuTemplateItem = Electron.MenuItemConstructorOptions & { actionKey?: MenuActionKey; submenu?: MenuTemplateItem[] }

function captureRefs(template: readonly MenuTemplateItem[], items: Electron.MenuItem[]): void {
  for (let i = 0; i < template.length; i++) {
    const tpl = template[i]
    const item = items[i]
    if (!item) continue
    if (tpl.actionKey) itemRefs.set(tpl.actionKey, item)
    if (tpl.submenu && item.submenu) captureRefs(tpl.submenu, item.submenu.items)
  }
}

function updateItemState(key: MenuActionKey, patch: { checked?: boolean; enabled?: boolean }): void {
  const item = itemRefs.get(key)
  if (!item) return
  if (patch.checked !== undefined) item.checked = patch.checked
  if (patch.enabled !== undefined) item.enabled = patch.enabled
}

// 深色模式：nativeTheme.themeSource 仍设置（驱动原生标题栏），但不再假设它会联动 next-themes 的
// prefers-color-scheme 监听——实测运行期间点菜单切换，已打开的渲染端不会跟着变（无 IPC 推送，
// 也没有组件调用 setTheme()）。改为显式推送：改完 themeSource 后发 'theme:sync' IPC，
// 渲染端 AppShell.tsx 收到后调 setTheme()。冷启动首屏不受影响（建窗口前已设好 themeSource），
// 显式推送只补"运行期间再切换"。
type ThemePreference = 'system' | 'light' | 'dark'
let currentThemePreference: ThemePreference = 'system'

function themePreferenceFilePath(): string {
  return path.join(app.getPath('userData'), 'theme-preference.json')
}

function loadThemePreference(): ThemePreference {
  try {
    const raw = fs.readFileSync(themePreferenceFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as { pref?: string }
    if (parsed.pref === 'light' || parsed.pref === 'dark' || parsed.pref === 'system') return parsed.pref
  } catch {
    // 文件不存在（首次运行）或损坏——退回默认'system'，不是需要上报的错误
  }
  return 'system'
}

function saveThemePreference(pref: ThemePreference): void {
  try {
    fs.writeFileSync(themePreferenceFilePath(), JSON.stringify({ pref }), 'utf-8')
  } catch {
    // 写入失败（磁盘满/权限问题等）不影响本次会话内已经生效的 nativeTheme
    // 设置，只是下次启动会退回默认——不是致命错误，不打断当前操作。
  }
}

function applyThemePreference(pref: ThemePreference): void {
  currentThemePreference = pref
  nativeTheme.themeSource = pref
  saveThemePreference(pref)
  // 外观三项是 radio 菜单项：实测 Electron/Windows 对 radio 做 updateItemState 式的逐项手动置 checked 不可靠
  // （显式设 false 不总生效，残留多项"内部已选中"，Windows 只在同组最后一项画圆点，"深色"永远亮着）。
  // checkbox（如 alwaysOnTop）没有这个坑，继续原地刷新；radio 必须清缓存整树重建，
  // 让新 MenuItem 一开始就只有一个正确的 checked=true（与 recordRecentExport() 重建菜单同一做法）。
  menuTemplateCache.clear()
  menuCache.clear()
  buildAppMenu(currentMenuLang)
  sendToRenderer('theme:sync', pref)
}

/** 「关于」页和帮助菜单共用的项目地址。 */
const REPO_URL = 'https://github.com/Aevorine/Tessera'

/**
 * 排查用的环境信息，设置页按钮和帮助菜单共用。
 * 有意不含金库路径、设备标识、用户名或任何文件名：这份文本是要贴给别人看的，
 * 加东西前先问：发到公开 issue 里会泄露什么。
 */
function collectDiagnostics(): string {
  return [
    `Tessera ${app.getVersion()}`,
    `Electron ${process.versions.electron}`,
    `Node ${process.versions.node}`,
    `Platform ${process.platform} ${process.getSystemVersion()}`,
    `Theme ${currentThemePreference}`,
    `Backend ${bridge ? 'running' : 'not running'}`,
  ].join('\n')
}

/**
 * 打开外部链接，带域名白名单（在主进程，不在渲染端）。
 * shell.openExternal 会把 URL 交给系统按协议处理（file:、ms-msdt: 等可导致 RCE），
 * 而渲染进程里全是不可信内容；所以只放行 https 且只放行本项目自己的域名，写死的常量也走这里。
 */
async function openExternalChecked(rawUrl: string): Promise<{ ok: boolean }> {
  const ALLOWED_HOSTS = new Set(['github.com', 'www.gnu.org'])
  try {
    const url = new URL(String(rawUrl))
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      console.warn(`[security] refused to open external URL: ${url.protocol}//${url.hostname}`)
      return { ok: false }
    }
    await shell.openExternal(url.toString())
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * 帮助菜单「检查更新」：与设置页同一个 UpdateService，结果用系统对话框报；force=true
 * 不受自动检查节流限制。
 */
async function checkForUpdatesFromMenu(): Promise<void> {
  const t = getCurrentLocale()
  let options: Electron.MessageBoxOptions
  let hasUpdate = false
  try {
    // force=true：手动点的就是要现在查，不受自动检查那个节流的限制。
    const result = await getUpdateService().check(true, detectInstallFlavor())
    hasUpdate = result.status === 'update-available'
    if (hasUpdate) {
      options = {
        type: 'info',
        title: t.checkForUpdates,
        message: t.updateAvailable,
        detail: `${result.currentVersion} → ${result.latest?.version ?? ''}\n${t.updateGoToSettings}`,
        buttons: [t.aboutOkButton],
      }
    } else if (result.status === 'error') {
      // check() 对网络类失败是**返回** error 状态而不是抛错，所以这一支必须
      // 单独处理——漏掉它会把"没查成"显示成"已是最新版"，是最糟的一种错报。
      options = {
        type: 'warning',
        title: t.checkForUpdates,
        message: t.updateCheckFailed,
        detail: result.errorMessage ?? result.errorCode ?? '',
        buttons: [t.aboutOkButton],
      }
    } else {
      options = {
        type: 'info',
        title: t.checkForUpdates,
        message: t.updateUpToDate,
        detail: result.currentVersion,
        buttons: [t.aboutOkButton],
      }
    }
  } catch (error) {
    options = {
      type: 'warning',
      title: t.checkForUpdates,
      message: t.updateCheckFailed,
      detail: error instanceof Error ? error.message : String(error),
      buttons: [t.aboutOkButton],
    }
  }
  await showMessageBoxOnWindow(options)
  // 有新版就顺手把用户送到能安装它的地方——只告诉他"有更新"却不说去哪装，
  // 等于把找入口这件事又丢回给他。
  if (hasUpdate) sendNav('settings')
}

/** 帮助菜单「复制诊断信息」：内容同 system:copyDiagnostics，有意不含金库数据、路径或设备标识。 */
function copyDiagnosticsFromMenu(): void {
  const t = getCurrentLocale()
  clipboard.writeText(collectDiagnostics())
  void showMessageBoxOnWindow({
    type: 'info',
    title: t.copyDiagnostics,
    message: t.diagnosticsCopied,
    buttons: [t.aboutOkButton],
  })
}

/** 有主窗口就把对话框挂在它上面（模态、跟着窗口走），没有就退回无主对话框。
 *  菜单里几个动作都要这么做，抽出来免得每处重写一遍这个二选一。 */
function showMessageBoxOnWindow(options: Electron.MessageBoxOptions) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
}

function showAboutDialog() {
  const t = getCurrentLocale()
  const descriptions: Record<string, string> = {
    en: 'Encrypted local vault for files, passwords, notes, clipboard history, and direct cross-device sync.',
    zh: '文件、密码、笔记、剪贴板记录与局域网跨设备同步的本地加密金库。',
    fr: 'Coffre local chiffré pour fichiers, mots de passe, notes, historique du presse-papiers et synchronisation directe entre appareils.',
    es: 'Caja fuerte local cifrada para archivos, contraseñas, notas, historial del portapapeles y sincronización directa entre dispositivos.',
    ru: 'Зашифрованное локальное хранилище для файлов, паролей, заметок, истории буфера обмена и прямой синхронизации между устройствами.',
    ar: 'خزنة محلية مشفّرة للملفات وكلمات المرور والملاحظات وسجل الحافظة والمزامنة المباشرة بين الأجهزة.',
  }
  void showMessageBoxOnWindow({
    type: 'info',
    title: t.about,
    message: 'Tessera',
    detail: `${descriptions[currentMenuLang] ?? descriptions.en}\n\nVersion ${app.getVersion()}\nElectron ${process.versions.electron} / Node ${process.versions.node}`,
    buttons: [t.aboutOkButton],
  })
}

// 纯函数，不直接调用 Menu.buildFromTemplate/setApplicationMenu；项目暂无 JS 测试 runner，
// 以后需要再补。
function recordRecentExport(targetPath: string): void {
  const next = [targetPath, ...recentExportPaths.filter((path) => path !== targetPath)].slice(0, 8)
  recentExportPaths.splice(0, recentExportPaths.length, ...next)
  menuTemplateCache.clear()
  menuCache.clear()
  buildAppMenu(currentMenuLang)
}

function recentExportsSubmenu(t: MenuLocale): MenuTemplateItem[] {
  if (recentExportPaths.length === 0) return [{ label: t.noRecentExports, enabled: false }]
  return recentExportPaths.map((targetPath) => ({
    label: path.basename(targetPath),
    toolTip: targetPath,
    click: () => shell.showItemInFolder(targetPath),
  }))
}

function buildTemplate(t: MenuLocale): MenuTemplateItem[] {
  const isMac = process.platform === 'darwin'

  const fileSubmenu: MenuTemplateItem[] = []
  // 「新建笔记」排第一：它是菜单里唯一产生新东西的动作；Ctrl+N 与全局速记（Ctrl+Shift+N）走同一条
  // sendQuickCapture。
  fileSubmenu.push({ label: t.newNote, accelerator: 'CmdOrCtrl+N', click: sendQuickCapture })
  fileSubmenu.push({ type: 'separator' })
  fileSubmenu.push({ label: t.navFiles, accelerator: 'CmdOrCtrl+O', click: () => sendNav('files') })
  fileSubmenu.push({ label: t.navFileManager, click: () => sendNav('filemanager') })
  fileSubmenu.push({ label: t.recentExports, submenu: recentExportsSubmenu(t) })
  fileSubmenu.push({ type: 'separator' })
  if (!isMac) {
    fileSubmenu.push({ label: t.openSettings, accelerator: 'CmdOrCtrl+,', click: () => sendNav('settings') })
    fileSubmenu.push({
      label: t.fileHookEnabled,
      type: 'checkbox',
      actionKey: 'fileHookEnabled',
      checked: fileHookEnabled,
      click: () => {
        fileHookEnabled = !fileHookEnabled
        updateItemState('fileHookEnabled', { checked: fileHookEnabled })
        sendToRenderer('filemanager:hook-toggle', fileHookEnabled)
      },
    })
    fileSubmenu.push({ type: 'separator' })
  }
  // 「隐藏到托盘」与「退出」之间隔分隔线；关窗默认收进托盘，真正退出只有这一个入口。
  // 不给加速键：Ctrl+H 已被笔记编辑器绑成查找替换（NotesScreen.tsx），菜单加速键会先于渲染端截胡。
  fileSubmenu.push({ label: t.hideToTray, click: () => hideWindow() })
  if (!isMac) {
    fileSubmenu.push({ type: 'separator' })
    fileSubmenu.push({
      label: t.quit,
      accelerator: 'CmdOrCtrl+Q',
      click: () => {
        isQuitting = true
        app.quit()
      },
    })
  }

  const menus: MenuTemplateItem[] = []

  // macOS：关于/设置/退出挪到 App 名称菜单；Edit 菜单保留系统标准 role，
  // 否则输入法候选词和系统右键菜单失效。
  if (isMac) {
    menus.push({
      label: app.name,
      submenu: [
        { label: t.about, click: showAboutDialog },
        { type: 'separator' },
        { label: t.openSettings, accelerator: 'Cmd+,', click: () => sendNav('settings') },
        { type: 'separator' },
        {
          label: t.quit,
          accelerator: 'Cmd+Q',
          click: () => {
            isQuitting = true
            app.quit()
          },
        },
      ],
    })
  }

  menus.push({ label: mnemonic(t.file, 'F'), submenu: fileSubmenu })

  menus.push({
    label: mnemonic(t.edit, 'E'),
    submenu: [
      { label: t.undo, role: 'undo' },
      { label: t.redo, role: 'redo' },
      { type: 'separator' },
      // cut/copy/paste 用 click 而非 role：文件管理面板聚焦时转发给渲染端做文件操作，否则退回
      // webContents 等价 API
      // （见 sendFileManagerAction、fileManagerActive）。
      {
        label: t.cut,
        // 改成 click 后 role 自带的默认加速键消失了，必须显式补回，否则只能用鼠标点菜单。
        accelerator: 'CmdOrCtrl+X',
        click: () => (fileManagerActive ? sendFileManagerAction('cut') : win?.webContents.cut()),
      },
      {
        label: t.copy,
        accelerator: 'CmdOrCtrl+C',
        click: () => (fileManagerActive ? sendFileManagerAction('copy') : win?.webContents.copy()),
      },
      {
        label: t.paste,
        accelerator: 'CmdOrCtrl+V',
        click: () => (fileManagerActive ? sendFileManagerAction('paste') : win?.webContents.paste()),
      },
      // 粘贴为纯文本，文件管理器里无意义所以不分支。
      // 有意不给 Ctrl+Shift+V：那是「打开剪贴板记录」的全局快捷键（DEFAULT_GLOBAL_SHORTCUTS），OS
      // 级注册必赢菜单加速键。
      { label: t.pastePlain, role: 'pasteAndMatchStyle' },
      { type: 'separator' },
      {
        label: t.fileManagerDeleteRecycle,
        actionKey: 'fileManagerDeleteRecycle',
        enabled: fileManagerActive,
        // 有意不给 Delete / Shift+Delete 加速键：菜单加速键全应用生效，会在任何输入框触发删除文件；
        // 这两键已在 FileManagerScreen.tsx 内部绑定，那里才知道焦点是否在文件列表。
        click: () => sendFileManagerAction('delete-recycle'),
      },
      {
        label: t.fileManagerDeletePermanent,
        actionKey: 'fileManagerDeletePermanent',
        enabled: fileManagerActive,
        click: () => sendFileManagerAction('delete-permanent'),
      },
      { type: 'separator' },
      { label: t.selectAll, role: 'selectAll' },
      { type: 'separator' },
      // 命令面板本来只有 Ctrl+K 一个入口，而没人会去猜一个没写在任何地方的
      // 组合键。摆进菜单，这个快捷键才有被发现的机会。
      {
        label: t.commandPalette,
        accelerator: 'CmdOrCtrl+K',
        click: () => {
          showWindow()
          sendToRenderer('app:open-command-palette')
        },
      },
    ],
  })

  menus.push({
    label: mnemonic(t.view, 'V'),
    submenu: [
      // 顺序跟左侧导航栏一致，编号也跟着 Ctrl+1..8 一一对应——菜单和侧栏
      // 说的是同一件事，两处排法不同会让人以为是两套功能。
      { label: t.navFiles, accelerator: 'CmdOrCtrl+1', click: () => sendNav('files') },
      { label: t.navClipboard, accelerator: 'CmdOrCtrl+2', click: () => sendNav('clipboard') },
      { label: t.navCrossDevice, accelerator: 'CmdOrCtrl+3', click: () => sendNav('crossdevice') },
      { label: t.navPasswords, accelerator: 'CmdOrCtrl+4', click: () => sendNav('passwords') },
      { label: t.navNotes, accelerator: 'CmdOrCtrl+5', click: () => sendNav('notes') },
      { label: t.navAi, accelerator: 'CmdOrCtrl+6', click: () => sendNav('ai') },
      { label: t.navNetwork, accelerator: 'CmdOrCtrl+7', click: () => sendNav('network') },
      { label: t.navFileManager, accelerator: 'CmdOrCtrl+8', click: () => sendNav('filemanager') },
      // 电脑清理是侧边栏里唯一没有编号快捷键的重模块。用 9 而不是接着往下排到
      // 0：Ctrl+0 已经是"界面实际大小"，抢过来会让缩放那三个键少一个。
      { label: t.navPcClean, accelerator: 'CmdOrCtrl+9', click: () => sendNav('pcclean') },
      { type: 'separator' },
      { label: t.navSettings, click: () => sendNav('settings') },
      { label: t.navDiagnostics, click: () => sendNav('diagnostics') },
      { type: 'separator' },
      {
        label: t.appearance,
        // 用 checkbox 而非 radio：Electron 在 Windows 下 radio 菜单项显示不可靠（圆点总停在组内最后一项），
        // 而 checked 布尔值本身计算正确；checkbox 完全由这里的 checked 决定显示。
        submenu: [
          {
            label: t.appearanceSystem,
            type: 'checkbox',
            actionKey: 'appearanceSystem',
            checked: currentThemePreference === 'system',
            click: () => applyThemePreference('system'),
          },
          {
            label: t.appearanceLight,
            type: 'checkbox',
            actionKey: 'appearanceLight',
            checked: currentThemePreference === 'light',
            click: () => applyThemePreference('light'),
          },
          {
            label: t.appearanceDark,
            type: 'checkbox',
            actionKey: 'appearanceDark',
            checked: currentThemePreference === 'dark',
            click: () => applyThemePreference('dark'),
          },
        ],
      },
      { type: 'separator' },
      // 缩放用 role：Electron 自己维护每个 webContents 的缩放级别，我们
      // 再存一份只会两边不同步。
      { label: t.zoomIn, role: 'zoomIn' },
      { label: t.zoomOut, role: 'zoomOut' },
      { label: t.zoomReset, role: 'resetZoom' },
      { type: 'separator' },
      { label: t.reload, role: 'reload' },
      // 开发者工具只在开发模式下暴露——打包后的个人使用场景不需要普通用户
      // 能打开控制台。
      ...(!app.isPackaged ? [{ label: t.devTools, role: 'toggleDevTools' } as MenuTemplateItem] : []),
      { type: 'separator' },
      { label: t.fullscreen, role: 'togglefullscreen' },
    ],
  })

  menus.push({
    label: mnemonic(t.window, 'W'),
    submenu: [
      { label: t.minimize, role: 'minimize' },
      { label: t.hideToTray, click: () => hideWindow() },
      {
        label: t.alwaysOnTop,
        type: 'checkbox',
        actionKey: 'alwaysOnTop',
        // 单一数据源，实时查询——不额外维护一份"是否置顶"的影子state。
        checked: win?.isAlwaysOnTop() ?? false,
        click: () => {
          if (!win) return
          const next = !win.isAlwaysOnTop()
          win.setAlwaysOnTop(next)
          updateItemState('alwaysOnTop', { checked: next })
        },
      },
      { type: 'separator' },
      // 「窗口跑到屏幕外面去了」是拔掉外接显示器之后的常见状况，而那时候
      // 用鼠标根本够不着窗口——所以恢复入口必须在菜单里，不能只靠拖。
      { label: t.centerWindow, click: () => win?.center() },
      {
        label: t.resetWindowSize,
        click: () => {
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          if (win.isFullScreen()) win.setFullScreen(false)
          win.setSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
          win.center()
        },
      },
      { type: 'separator' },
      { label: t.close, role: 'close' },
    ],
  })

  // Help菜单在mac下只有"关于"一项，且已经挪到App名称菜单，不需要重复一个
  // 几乎空的Help顶层菜单（"操作指南"在mac下仍可从应用内导航栏进入）。
  if (!isMac) {
    menus.push({
      label: mnemonic(t.help, 'H'),
      submenu: [
        // F1 是 Windows 上「帮助」的通用键，用户按下去会预期出现帮助。
        { label: t.helpGuide, accelerator: 'F1', click: () => sendNav('help') },
        { type: 'separator' },
        { label: t.checkForUpdates, click: () => void checkForUpdatesFromMenu() },
        { label: t.copyDiagnostics, click: copyDiagnosticsFromMenu },
        { type: 'separator' },
        // 两个外链走的是和渲染端同一套白名单校验（openExternalChecked），
        // 不因为"这是我们自己写死的常量"就跳过——写死的常量也会被改错。
        { label: t.projectHome, click: () => void openExternalChecked(REPO_URL) },
        { label: t.reportIssue, click: () => void openExternalChecked(`${REPO_URL}/issues`) },
        { type: 'separator' },
        { label: t.about, click: showAboutDialog },
      ],
    })
  }

  return menus
}

// 仅语言切换才整树重建，缓存 key 只按语言分；状态变化走 itemRefs/updateItemState。
// 重建产生全新 MenuItem，itemRefs 要用新菜单的 item 重新填充。
const menuTemplateCache = new Map<SupportedMenuLang, MenuTemplateItem[]>()
const menuCache = new Map<SupportedMenuLang, Electron.Menu>()

// 每个语言各缓存一份 MenuItem，updateItemState 只改当前语言那份；切回缓存语言时会显示旧状态。
// 每次激活某语言菜单后，按真实来源（win.isAlwaysOnTop()/currentThemePreference）把动态状态刷进
// itemRefs。
function syncDynamicMenuState(): void {
  updateItemState('alwaysOnTop', { checked: win?.isAlwaysOnTop() ?? false })
  updateItemState('appearanceSystem', { checked: currentThemePreference === 'system' })
  updateItemState('appearanceLight', { checked: currentThemePreference === 'light' })
  updateItemState('appearanceDark', { checked: currentThemePreference === 'dark' })
}

function buildAppMenu(lang: SupportedMenuLang): void {
  currentMenuLang = lang
  let template = menuTemplateCache.get(lang)
  let menu = menuCache.get(lang)
  if (!template || !menu) {
    template = buildTemplate(MENU_LOCALES[lang])
    menu = Menu.buildFromTemplate(template)
    menuTemplateCache.set(lang, template)
    menuCache.set(lang, menu)
  }
  Menu.setApplicationMenu(menu)
  captureRefs(template, menu.items)
  syncDynamicMenuState()
}

// 模块级函数而非 createTray 内闭包：语言切换时也要重新调用来刷新托盘菜单文案。
/** 托盘菜单「把剪贴板发到所有设备」。跟设备页的「发送剪贴板」走同一条路（force：
 *  接收端不做回环去重），只是不用先打开窗口。 */
async function sendClipboardFromTray(): Promise<void> {
  if (!crossDevice) return
  const local = readLocalClipboard()
  if (!local) return
  noteClipboardWritten()
  try {
    await crossDevice.call('send_clip', { ...local, force: true })
  } catch (error) {
    console.error('[tray] send clipboard failed', error)
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const t = getCurrentLocale()
  tray.setToolTip(`Tessera · ${vaultUnlocked ? t.trayStatusUnlocked : t.trayStatusLocked}`)
  const openAtLogin = app.getLoginItemSettings({ path: LOGIN_ITEM_EXE_PATH, args: LOGIN_ITEM_ARGS }).openAtLogin
  const menu = Menu.buildFromTemplate([
    { label: t.trayOpenPanel, click: showWindow },
    {
      label: t.trayQuickAccess,
      submenu: [
        { label: t.navClipboard, click: () => sendNav('clipboard') },
        { label: t.navPasswords, click: () => sendNav('passwords') },
        { label: t.newNote, click: () => sendQuickCapture() },
        { label: t.navCrossDevice, click: () => sendNav('crossdevice') },
        { label: t.navFiles, click: () => sendNav('files') },
        { label: t.navPcClean, click: () => sendNav('pcclean') },
        { label: t.navSettings, click: () => sendNav('settings') },
      ],
    },
    { label: t.traySendClipboard, click: () => void sendClipboardFromTray() },
    { type: 'separator' as const },
    {
      label: isPaused ? t.trayResumeClipboard : t.trayPauseClipboard,
      click: async () => {
        isPaused = !isPaused
        try {
          await bridge?.call('clipboard_set_paused', { paused: isPaused })
        } catch {
          // 后端未解锁/未起来时调用会失败：托盘状态照样翻转，解锁后 AppShell 会用当前 isPaused 重新同步；
          // 容忍静默失败。
        }
        rebuildTrayMenu()
      },
    },
    // 锁定放在退出上面、分隔线下面（人离开座位前最常用）；金库本已锁定时不显示，
    // 免得出现点了没反应的菜单项。
    ...(vaultUnlocked ? [{ label: t.trayLockVault, click: () => lockVault('tray menu') }] : []),
    { type: 'separator' as const },
    {
      label: t.trayAutoStart,
      type: 'checkbox' as const,
      checked: openAtLogin,
      click: (item: Electron.MenuItem) => {
        writeLoginItem(item.checked)
        if (startupPreferencesFirstRun) {
          saveStartupPreferences(startupPreferences)
          startupPreferencesFirstRun = false
        }
        rebuildTrayMenu()
      },
    },
    {
      label: t.traySilentStart,
      type: 'checkbox' as const,
      checked: startupPreferences.silent,
      click: (item: Electron.MenuItem) => {
        startupPreferences = { ...startupPreferences, silent: item.checked }
        saveStartupPreferences(startupPreferences)
        startupPreferencesFirstRun = false
      },
    },
    { label: t.checkForUpdates, click: () => void checkForUpdatesFromMenu() },
    { type: 'separator' as const },
    {
      label: t.trayQuit,
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function createTray() {
  const iconPath = path.join(process.env.VITE_PUBLIC!, 'icon.ico')
  tray = new Tray(iconPath)
  tray.setToolTip('Tessera')
  rebuildTrayMenu()
  tray.on('click', toggleWindow)
}

app.on('window-all-closed', () => {
  // 常规关窗由 win.on('close') 拦下隐藏，不会走到这里；仅真正退出（isQuitting）或 win
  // 从未创建成功时处理，macOS 约定不在此退出。
  if (isQuitting && process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    showWindow()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  stopClipboardWatcher()
  // 让守护进程自己收尾：它要把传输进度位图刷盘，直接 kill 会丢掉最近几十 MB
  // 的续传进度（见 crossdevice/core/transfer/receiver.go 的 fsync 节奏）。
  crossDevice?.dispose()
  crossDevice = null
})

// ---- 应用更新（GitHub Releases + Authenticode 代码签名） ----
// 信任根是 exe 自带的代码签名而非 HTTPS：HTTPS 只证明从 github.com 下载，不证明是我们发布的。
// 证书自签名；详见 authenticode.ts 和 updateService.ts 顶部。

const LOCAL_APP_DATA_ROOT = path.join(
  process.env.LOCALAPPDATA ?? path.join(app.getPath('home'), 'AppData', 'Local'),
  'Tessera',
)

/** 自动检查开关，跟其它 UI 偏好一样存 userData。默认开启——只查元数据，不下载。 */
const UPDATE_PREFS_FILE = path.join(app.getPath('userData'), 'update-preferences.json')

/** 上次启动时这个 exe 在哪。拿不到 PORTABLE_EXECUTABLE_FILE 时的兜底线索——
 *  **不是信任源**，用它之前必须先验那个文件确实是我们签的（见安装流程）。 */
const INSTALL_LOCATION_FILE = path.join(LOCAL_APP_DATA_ROOT, 'install-location.json')

interface UpdatePreferences {
  autoCheck: boolean
  source: UpdateSourceId
}

function readUpdatePreferences(): UpdatePreferences {
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_PREFS_FILE, 'utf-8')) as { autoCheck?: unknown; source?: unknown }
    return { autoCheck: raw.autoCheck !== false, source: parseUpdateSource(raw.source) }
  } catch {
    return { autoCheck: true, source: DEFAULT_UPDATE_SOURCE }
  }
}

/** 只改给出的字段：两项偏好共用一个文件，各写各的会互相抹掉。 */
function writeUpdatePreferences(patch: Partial<UpdatePreferences>): void {
  try {
    fs.mkdirSync(path.dirname(UPDATE_PREFS_FILE), { recursive: true })
    fs.writeFileSync(UPDATE_PREFS_FILE, JSON.stringify({ ...readUpdatePreferences(), ...patch }), 'utf-8')
  } catch (error) {
    console.error('[update] failed to persist the update preferences', error)
  }
}

function readAutoCheckEnabled(): boolean {
  return readUpdatePreferences().autoCheck
}

function writeAutoCheckEnabled(enabled: boolean): void {
  writeUpdatePreferences({ autoCheck: enabled })
}

let updateService: UpdateService | null = null

function getUpdateService(): UpdateService {
  if (!updateService) {
    // 下载目录不在这里定：它必须跟目标 exe 同一个目录（同目录必然同卷，runner
    // 那一步的"原子替换"才成立），而目标 exe 是安装时才解析出来的。
    updateService = new UpdateService({
      currentVersion: app.getVersion(),
      source: readUpdatePreferences().source,
      // 更新跟着系统代理走；解析交给 Chromium，PAC 和手动代理都认。
      fetchImpl: createProxyAwareFetch((url) => session.defaultSession.resolveProxy(url)),
    })
  }
  return updateService
}

/**
 * 安装版更新：下载安装包 → 验签 → 静默运行 → 自己退出。
 * 不做免安装版的原子替换，因为安装目录、卸载项、快捷方式都由 NSIS 写入，自己替换 exe
 * 会让它们过期；
 * 安装包落在系统临时目录（一次性，无需同卷）。
 */
async function installViaSetupPackage(service: UpdateService, event: IpcMainInvokeEvent) {
  const stagingDir = path.join(app.getPath('temp'), 'ideal1-update')

  let downloaded: { path: string; sha256: string }
  try {
    // download() 内部做完 Authenticode 验签，验不过会抛异常并删掉文件——
    // 走到下一步的一定是一个签名合格的安装包。
    downloaded = await service.download(stagingDir, (progress) => {
      sendToSender(event.sender, 'update:progress', progress)
    })
  } catch (error) {
    return {
      ok: false as const,
      errorCode: (error as { code?: string }).code ?? 'download_failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }

  if (!runInstallerAndQuit(downloaded.path)) {
    return { ok: false as const, errorCode: 'installer_launch_failed' }
  }

  // 安装程序会自己等这个进程退出再动手，所以现在退出是安全的。
  isQuitting = true
  setTimeout(() => app.quit(), 200)
  return { ok: true as const }
}

function registerUpdateIpc(): void {
  ipcMain.handle('update:getState', (event) => {
    assertTrustedRenderer(event)
    return {
      currentVersion: app.getVersion(),
      autoCheck: readAutoCheckEnabled(),
      source: getUpdateService().getSource(),
      // 安装版不需要稳定 exe 路径；免安装版必须定位到自己的 exe，定位不到只能提示手动下载，绝不猜路径。
      // 开发模式两者都不满足，故为 false。
      canSelfUpdate:
        app.isPackaged &&
        (detectInstallFlavor() === 'installer' || resolveStableExePath(INSTALL_LOCATION_FILE) !== null),
    }
  })

  ipcMain.handle('update:setAutoCheck', (event, enabled: boolean) => {
    assertTrustedRenderer(event)
    writeAutoCheckEnabled(enabled === true)
    return readAutoCheckEnabled()
  })

  ipcMain.handle('update:setSource', (event, source: unknown) => {
    assertTrustedRenderer(event)
    // 渲染端只能在两个内置仓库之间选，说不出别的地址。
    const next = parseUpdateSource(source)
    writeUpdatePreferences({ source: next })
    getUpdateService().setSource(next)
    return next
  })

  ipcMain.handle('update:check', async (event, force: boolean) => {
    assertTrustedRenderer(event)
    return getUpdateService().check(force === true, detectInstallFlavor())
  })

  ipcMain.handle('update:install', async (event) => {
    assertTrustedRenderer(event)
    const service = getUpdateService()
    const pending = service.getPendingUpdate()
    if (!pending) {
      return { ok: false as const, errorCode: 'no_pending_update' }
    }
    // 安装版：下安装包 → 验签 → 跑它 → 退出。替换由 NSIS 负责，我们不碰文件。
    if (pending.flavor === 'installer') {
      return await installViaSetupPackage(service, event)
    }

    // 免安装版：定位自己的 exe 并原地原子替换。优先用 portable 启动器的环境变量，
    // 否则退回上次启动记下的路径。
    const target = resolveStableExePath(INSTALL_LOCATION_FILE)
    if (!target) {
      return { ok: false as const, errorCode: 'not_portable' }
    }

    // 记住的路径来自当前用户可写的文件，可被篡改成任意路径；
    // 走这条路径必须先验证那个文件确实是我们签的，
    // 否则改一行 JSON 就能让更新器覆盖任意文件。环境变量来自我们自己的启动器，不需要这步。
    if (target.source === 'remembered') {
      try {
        await verifySigner(target.path, UpdateService.signerPolicy())
      } catch (error) {
        return {
          ok: false as const,
          errorCode: 'target_not_ours',
          errorMessage: `${target.path}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    // 下载之前先确认目标可替换（文件在、目录可写、空间够），避免下完 145MB 才报错。
    const problem = inspectTarget(target.path, requiredFreeBytes(pending.assetSize))
    if (problem) {
      return { ok: false as const, errorCode: problem.code, errorMessage: problem.message }
    }

    // download() 内部已做 Authenticode 验签（失败抛异常并删文件），走到这里的一定是签名合格的包。
    // 落盘目录与目标 exe 同目录（同卷），runner 的原子替换才成立。
    let downloaded: { path: string; sha256: string }
    try {
      downloaded = await service.download(stagingDirFor(target.path), (progress) => {
        sendToSender(event.sender, 'update:progress', progress)
      })
    } catch (error) {
      return {
        ok: false as const,
        errorCode: (error as { code?: string }).code ?? 'download_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }

    try {
      // runner 必须在主进程退出**之前**部署并启动：portable 外层启动器会在主进程
      // 退出后清掉整个临时 resources 目录，那之后连 runner 的源文件都读不到了。
      await startInstall({
        runnerSource: path.join(process.resourcesPath, 'updater', 'updateRunner.js'),
        updatesRoot: path.join(LOCAL_APP_DATA_ROOT, 'updates'),
        targetExe: target.path,
        downloadedExe: downloaded.path,
        expectedSha256: downloaded.sha256,
        expectedPublisher: UpdateService.signerPolicy().publisher,
        expectedPublicKeySha256: UpdateService.signerPolicy().publicKeySha256,
        currentVersion: app.getVersion(),
        newVersion: pending.version,
      })
    } catch (error) {
      return {
        ok: false as const,
        errorCode: 'runner_deploy_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }
    }

    // runner 会先等这个进程退出再动手，所以现在退出是安全的。
    isQuitting = true
    setTimeout(() => app.quit(), 200)
    return { ok: true as const }
  })
}

/**
 * 更新后首次启动时确认自己真的活起来了。
 * 必须在后端已连通、窗口已创建之后调用，仅进程起来不算；runner 等这份回执，等不到就回滚。
 */
async function reportPostUpdateHealthIfNeeded(): Promise<void> {
  const logPath = readPostUpdateHealthArg(process.argv)
  if (!logPath) return
  try {
    await writeHealthReceipt(logPath)
    console.log('[update] post-update health receipt written')
  } catch (error) {
    // 写不出回执 → runner 会超时回滚。这是**正确**的结果：连一个几十字节的回执
    // 都写不了，说明这个安装确实有问题（权限、磁盘满），回滚比带病运行好。
    console.error('[update] failed to write the health receipt; the runner will roll back', error)
  }
}

/** 启动后延迟做一次自动检查——只查元数据，绝不静默下载或替换。 */
function scheduleAutoUpdateCheck(): void {
  if (!app.isPackaged) return
  if (!readAutoCheckEnabled()) return
  // 延迟 30 秒：启动那一刻用户在等界面，不该跟他抢网络和 CPU。
  setTimeout(() => {
    void getUpdateService()
      .check(false, detectInstallFlavor())
      .then((result) => {
        if (result.status === 'update-available') {
          sendToRenderer('update:available', result)
        }
      })
      .catch((error) => console.error('[update] automatic check failed', error))
  }, 30_000)
  // 长时间不关的应用也要能发现新版本；节流窗口本身在 UpdateService 里。
  setInterval(() => {
    if (!readAutoCheckEnabled()) return
    void getUpdateService()
      .check(false, detectInstallFlavor())
      .then((result) => {
        if (result.status === 'update-available') {
          sendToRenderer('update:available', result)
        }
      })
      .catch(() => undefined)
  }, AUTO_CHECK_THROTTLE_MS)
}

app.on('will-quit', () => {
  if (autoLockTimer !== null) {
    clearInterval(autoLockTimer)
    autoLockTimer = null
  }
  globalShortcut.unregisterAll()
  backendGovernor.dispose()
  bridge?.dispose()
})

// 仅开发模式（app.isPackaged 为 false）校验各语言菜单字典 key 一致；缺 key 不会崩溃，
// 只会让菜单项显示空白，很难排查。
function checkMenuLocaleCompleteness(): void {
  if (app.isPackaged) return
  const referenceKeys = new Set(Object.keys(MENU_LOCALES.zh))
  for (const lang of SUPPORTED_MENU_LANGS) {
    if (lang === 'zh') continue
    const keys = new Set(Object.keys(MENU_LOCALES[lang]))
    const missing = [...referenceKeys].filter((k) => !keys.has(k))
    const extra = [...keys].filter((k) => !referenceKeys.has(k))
    if (missing.length > 0 || extra.length > 0) {
      console.error(`[menu i18n] ${lang}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`)
    }
  }
}

/**
 * 一律拒绝所有 Web 权限请求（摄像头、麦克风、定位、通知、剪贴板读取等）。
 * Electron 默认全部批准，而本应用不需要任何 Web 权限（文件、剪贴板、截图都走主进程 IPC）。
 * 这是 CSP 之后的纵深一层：即使 Markdown 净化被绕过，脚本也拿不到设备权限。
 * 必须同时设 setPermissionCheckHandler（同步查询）和 setPermissionRequestHandler（异步请求），
 * 只设一个另一条路仍放行。
 */
function denyAllWebPermissions() {
  // 每种权限只记一次日志：setPermissionCheckHandler 是高频同步回调，
  // 主进程 console 同步写 stdout，逐次打印曾让事件循环单次停摆 28.9 秒、首屏从 0.5 秒拖到 29 秒。
  const logged = new Set<string>()
  const denyOnce = (kind: string, permission: string) => {
    const key = `${kind}:${permission}`
    if (logged.has(key)) return
    logged.add(key)
    console.warn(`[security] denied permission ${kind}:`, permission)
  }

  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    denyOnce('request', permission)
    callback(false)
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    denyOnce('check', permission)
    return false
  })
}

app.whenReady().then(() => {
  // 抢锁失败的进程正常已被 app.quit() 掉；这里只兜底 quit() 与 'ready' 之间的时序竞争，
  // 避免起重复的窗口/后端/托盘。
  if (!gotAppLock) return
  markStartup('appReady')
  denyAllWebPermissions()
  checkMenuLocaleCompleteness()
  // 深色模式偏好要在 createWindow() 之前落好 nativeTheme.themeSource——
  // 这样首帧渲染就是正确的主题，不会先闪一下系统默认再纠正。
  currentThemePreference = loadThemePreference()
  nativeTheme.themeSource = currentThemePreference
  createWindow()
  autoLock = loadAutoLock()
  startAutoLockWatch()
  createTray()
  markStartup('trayCreated')
  void reconcileLoginItemOnLaunch()
  // 首屏不被菜单构建拖慢：先用猜测的语言建菜单，渲染端挂载后经 system:setLanguage 纠正一次，
  // 短暂不一致是预期的（见 currentMenuLang）。
  buildAppMenu(currentMenuLang)
  markStartup('menuBuilt')
  // 全局快捷键（默认 Ctrl+Shift+V 剪贴板面板 / Ctrl+Shift+N 全局速记，可自定义）：
  // 读一次持久化偏好后统一注册，冲突处理见 registerGlobalShortcuts。
  currentGlobalShortcuts = loadGlobalShortcuts()
  registerGlobalShortcuts()
  markStartup('shortcutsRegistered')

  registerUpdateIpc()
  markStartup('ipcRegistered')
  // 每次启动记下 exe 当前位置；拿不到 PORTABLE_EXECUTABLE_FILE
  // 时这是找到安装位置的唯一线索（使用前会先验签，见 update:install）。
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    rememberExePath(INSTALL_LOCATION_FILE, process.env.PORTABLE_EXECUTABLE_FILE)
  }
  // 健康回执等窗口真正加载完再写：did-finish-load 表示渲染端已跑起来，
  // 后端连不通会直接体现为登录界面出不来。
  win?.webContents.once('did-finish-load', () => {
    void reportPostUpdateHealthIfNeeded()
  })
  scheduleAutoUpdateCheck()
})
