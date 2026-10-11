/**
 * 主进程侧安装编排：部署 runner → 写事务 → 启动 runner → 自己退出。
 * 主进程退出前的准备都在这里做（portable 外层启动器退出后会立刻清理临时 resources，之后读不到
 * runner 源文件）；
 * runner 只负责主进程死后的替换与回滚（见 updateRunner.ts）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { chooseUpdateTarget, type InstallFlavor, type UpdateTarget } from './updateVersion'
import type { UpdateTransaction } from './updateRunner'

export interface InstallOptions {
  /** resources 里那份 runner 的源路径（临时目录，随时会被清掉） */
  runnerSource: string
  /** 稳定根目录，%LOCALAPPDATA%\Tessera\updates */
  updatesRoot: string
  /** 被替换的稳定外层 EXE */
  targetExe: string
  downloadedExe: string
  expectedSha256: string
  /** 锁定的代码签名发布者（证书 CN），runner 替换前会拿它再验一次签名 */
  expectedPublisher: string
  /** 自签名模式下锁定的证书公钥 SHA-256；CA 模式为空串 */
  expectedPublicKeySha256: string
  currentVersion: string
  newVersion: string
}

export interface InstallHandle {
  transactionPath: string
  logPath: string
  healthReceiptPath: string
  runnerPid: number
}

/**
 * 判断当前是免安装版还是安装版：只看 PORTABLE_EXECUTABLE_FILE（electron-builder portable
 * 启动器独有）。
 * 没有就当安装版；开发模式也落此支，但那时 canSelfUpdate 本就为 false。
 * 刻意不查注册表或猜安装目录：失败模式更多，而判错会装错形态的包。
 */
export function detectInstallFlavor(): InstallFlavor {
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer'
}

/**
 * 记住当前 exe 位置供下次启动兜底；每次启动都写（内容不变则不动盘），exe 换位置后下次启动即跟上。
 */
export function rememberExePath(statePath: string, exePath: string): void {
  try {
    if (fs.existsSync(statePath)) {
      const existing = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { exePath?: unknown }
      if (existing.exePath === exePath) return
    }
  } catch {
    // 读不了/格式不认识 —— 当作没有，下面直接覆盖写
  }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({ exePath, at: new Date().toISOString() }, null, 2), 'utf-8')
  } catch (error) {
    // 记不住不影响这次运行，只是下次少一条兜底线索
    console.warn('[update] could not remember the install location:', error)
  }
}

function readRememberedExePath(statePath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { exePath?: unknown }
    return typeof raw.exePath === 'string' && raw.exePath.length > 0 ? raw.exePath : null
  } catch {
    return null
  }
}

/**
 * 找到稳定的外层 EXE 路径（应用装在哪）。
 * portable 下 process.execPath 指向临时解压目录，替换它无意义；应取 PORTABLE_EXECUTABLE_FILE。
 * 拿不到时退回上次记下的路径，但记录文件在 %LOCALAPPDATA% 下用户可写，不可信：
 * 返回值带 source，source 为 remembered 时调用方必须先确认那个文件确是我们签的（见 main.ts）。
 * 两者都没有返回 null，提示手动下载，绝不猜路径。
 */
export function resolveStableExePath(statePath?: string): UpdateTarget | null {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const remembered = statePath ? readRememberedExePath(statePath) : null
  const chosen = chooseUpdateTarget({
    portable: portable && fs.existsSync(portable) ? portable : null,
    remembered: remembered && fs.existsSync(remembered) ? remembered : null,
  })
  return chosen
}

export interface TargetProblem {
  code: 'target_missing' | 'target_not_writable' | 'target_no_space'
  message: string
}

/**
 * 下载之前确认目标能被替换：文件在、所在目录可写（Program Files、只读盘、杀软锁定都会失败）、
 * 同卷空间够放新包 + 旧包 + 替换瞬间两份。可写性用真的创建并删除临时文件探测，而非查权限位/ACL。
 */
export function inspectTarget(targetExe: string, requiredBytes: number): TargetProblem | null {
  if (!fs.existsSync(targetExe)) {
    return { code: 'target_missing', message: `the application is no longer at ${targetExe}` }
  }

  const dir = path.dirname(targetExe)
  const probe = path.join(dir, `.ideal1-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'x')
    fs.rmSync(probe, { force: true })
  } catch (error) {
    return {
      code: 'target_not_writable',
      message: `cannot write next to the application in ${dir}: ${String(error)}`,
    }
  }

  try {
    // statfs 在某些文件系统/驱动上会抛错。拿不到空间信息就跳过这一项检查——
    // 它是个提前预警，不是安全闸门，为它挡住一次本来能成功的更新不划算。
    const stats = fs.statfsSync(dir)
    const free = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(free) && free > 0 && free < requiredBytes) {
      return {
        code: 'target_no_space',
        message: `needs about ${Math.ceil(requiredBytes / 1024 / 1024)} MB free in ${dir}, has ${Math.floor(free / 1024 / 1024)} MB`,
      }
    }
  } catch {
    // 见上
  }

  return null
}

/** 暂存子目录名。放一个专门的目录而不是直接堆在 exe 旁边，理由见 stagingDirFor。 */
export const STAGING_DIR_NAME = '.ideal1-update'

/**
 * 下载暂存目录：目标 exe 目录下的专用子目录。
 * 必须同卷：跨卷 rename 非原子，Node 报 EXDEV。用子目录而非直接放 exe 旁，
 * 避免用户把 exe 改成与新资产同名时下载覆盖正在运行的 exe（不可逆），也不在用户文件夹留垃圾。
 */
export function stagingDirFor(targetExe: string): string {
  return path.join(path.dirname(targetExe), STAGING_DIR_NAME)
}

/** 把 runner 部署到稳定目录并校验；目录名带内容哈希：同内容复用（幂等），内容变则换目录。 */
export async function deployRunner(runnerSource: string, updatesRoot: string): Promise<string> {
  const bytes = await fsp.readFile(runnerSource)
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const dir = path.join(updatesRoot, `runner-${digest}`)
  const target = path.join(dir, 'updateRunner.js')

  await fsp.mkdir(dir, { recursive: true })
  // 已经部署过且内容一致就直接复用——避免重复写盘，也避免在杀毒软件正在扫描
  // 上一份的时候覆盖它。
  if (fs.existsSync(target)) {
    const existing = await fsp.readFile(target)
    if (existing.equals(bytes)) return target
  }
  const temp = `${target}.tmp-${process.pid}`
  await fsp.writeFile(temp, bytes)
  await fsp.rename(temp, target)

  // 校验落地内容——复制过程中出错的话，一个损坏的 runner 会在主进程已经退出之后
  // 才崩，那时候没有任何东西能把应用救回来。
  const written = await fsp.readFile(target)
  if (!written.equals(bytes)) {
    throw new Error('update runner failed verification after deployment')
  }
  return target
}

/**
 * 准备事务并启动 runner；调用方返回后应立即退出主进程（runner 会先等主进程退出再动手，无竞争）。
 */
export async function startInstall(options: InstallOptions): Promise<InstallHandle> {
  const runnerPath = await deployRunner(options.runnerSource, options.updatesRoot)

  const transactionDir = path.join(options.updatesRoot, `txn-${Date.now()}`)
  await fsp.mkdir(transactionDir, { recursive: true })
  const transactionPath = path.join(transactionDir, 'transaction.json')
  const logPath = path.join(transactionDir, 'install.log')
  const healthReceiptPath = path.join(transactionDir, 'health-ok')

  const transaction: UpdateTransaction = {
    targetExe: options.targetExe,
    downloadedExe: options.downloadedExe,
    expectedSha256: options.expectedSha256,
    expectedPublisher: options.expectedPublisher,
    expectedPublicKeySha256: options.expectedPublicKeySha256,
    currentVersion: options.currentVersion,
    newVersion: options.newVersion,
    mainPid: process.pid,
    healthReceiptPath,
    logPath,
  }
  await fsp.writeFile(transactionPath, JSON.stringify(transaction, null, 2), 'utf-8')

  // 用当前 Electron 可执行文件跑 runner（ELECTRON_RUN_AS_NODE=1 当纯 Node 用），不要求目标机器装
  // Node。
  const child = spawn(process.execPath, [runnerPath, '--transaction', transactionPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()

  return { transactionPath, logPath, healthReceiptPath, runnerPid: child.pid ?? -1 }
}

/**
 * 安装版更新：把下载好的安装包静默跑起来，然后自己退出。
 * 不像免安装版自己替换：安装版是整个目录树（外壳 exe、app.asar、冻结后端、DLL），只换 exe 会让
 * 外壳与 app/后端版本错开（V8 快照、原生模块 ABI），大概率更新后再也打不开；
 * 这套替换逻辑安装程序已有。
 * 装到原位置（NSIS 读卸载项里的安装路径），是原地升级。
 * 三个参数缺一不可：/S 静默；--force-run 因为静默安装默认不启动应用；--updated
 * 告知新版本是被更新上来的。
 * 没有自动回滚（免安装版靠保留的 .previous-<版本>），安装版回滚归安装程序，不是遗漏。
 */
export function runInstallerAndQuit(installerPath: string): boolean {
  try {
    const child = spawn(installerPath, ['/S', '--force-run', '--updated'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch (error) {
    console.error('[update] could not launch the downloaded installer', error)
    return false
  }
}

/**
 * 新版本启动时写健康回执，runner 等不到就回滚。
 * 必须在后端已连通、窗口已创建、数据目录可读之后调用，仅进程起来不算；
 * transactionLogPath 来自 `--post-update-health <path>`，回执写在它旁边。
 */
export async function writeHealthReceipt(transactionLogPath: string): Promise<void> {
  const receiptPath = path.join(path.dirname(transactionLogPath), 'health-ok')
  await fsp.writeFile(receiptPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), 'utf-8')
}

/** 从 argv 里取 `--post-update-health <path>`；不是更新后首启则返回 null。 */
export function readPostUpdateHealthArg(argv: string[]): string | null {
  const index = argv.indexOf('--post-update-health')
  if (index === -1 || index + 1 >= argv.length) return null
  return argv[index + 1]
}
