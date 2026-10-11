// Windows 防火墙：跨设备守护进程的入站放行。
//
// 发现和连接都跑在 UDP 上（QUIC + mDNS 组播 + 固定端口信标），Windows 对未经请求的入站 UDP 默认静默丢弃：
// 无报错、socket 照常绑定，表现为同一 Wi-Fi 下能 ping 通但「附近的设备」永远为空。
// 「Windows 安全中心已阻止」弹窗多半不出现（只对前台进程弹，而 tessera-crossdevice.exe 是无窗口子进程），
// 点"允许"也需管理员权限；安装包是 perMachine:false（见 electron-builder.json5），安装时也加不了规则。
// 所以规则只能在运行期、经用户明确同意的一次提权来加：本文件提供查询（无需权限）和添加（弹一次 UAC）。
// 改防火墙属于用户必须知情的系统安全配置：界面先讲清后果，用户点按钮才弹 UAC，绝不在启动时自动尝试。

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 规则名。查询和删除都按它精确匹配，改名会让旧规则变孤儿。
 * 必须是纯 ASCII：同名还出现在 nsis/installer.nsh 里，NSIS 非 ASCII 字面量取决于 makensis 的解码，
 * 两边理解不一致就会变成两条无关规则且不报错。
 */
export const FIREWALL_RULE_NAME = 'Tessera Cross-Device Sync'

export type FirewallState =
  /** 规则在，入站放行了。 */
  | 'allowed'
  /** 规则不在。设备发现多半会失败。 */
  | 'blocked'
  /** 查不出来（netsh 不可用、非 Windows、语言环境异常）。不猜，如实说不知道。 */
  | 'unknown'

export interface FirewallStatus {
  state: FirewallState
  /** 被放行的可执行文件路径，供界面显示和排查用。 */
  program: string | null
}

/**
 * 查询规则是否存在。用 `netsh advfirewall firewall show rule` 而非 `Get-NetFirewallRule`
 * （部分精简版 Windows 没有 NetSecurity 模块）。
 * 只看退出码不解析输出文本：输出是本地化的，规则不存在时 netsh 返回非 0，与语言无关。
 */
export async function firewallStatus(program: string | null): Promise<FirewallStatus> {
  if (process.platform !== 'win32') return { state: 'unknown', program }
  try {
    await execFileAsync('netsh', [
      'advfirewall', 'firewall', 'show', 'rule',
      `name=${FIREWALL_RULE_NAME}`,
      'dir=in',
    ], { windowsHide: true, timeout: 10_000 })
    return { state: 'allowed', program }
  } catch (err) {
    // netsh 对"没有匹配的规则"返回 1。真正的执行失败（找不到 netsh、超时）
    // 会给出别的错误形态——那种情况下我们确实不知道，不能报成"被挡了"。
    const code = (err as { code?: number | string }).code
    if (code === 1) return { state: 'blocked', program }
    return { state: 'unknown', program }
  }
}

/**
 * 旧版本留下的被截断的规则名：旧代码按数组给 Start-Process 传 -ArgumentList，
 * 含空格的 `name=Tessera Cross-Device Sync` 被拆开，netsh 只认第一段，其余被当成别的参数
 * （绑到不存在的服务，实际什么都不放行），却在防火墙面板里可见而误导排查。放行时按「同名 + 同程序」清掉。
 */
const LEGACY_TRUNCATED_RULE_NAME = 'Tessera'

/** 把一个参数包成 netsh 能正确解析的形式：带空格就加双引号。 */
function netshArg(value: string): string {
  return value.includes(' ') ? `"${value}"` : value
}

/** 包成 PowerShell 单引号字面量。 */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 加入站放行规则。会弹一次 UAC，必须由用户主动触发。
 *
 * 只放行 tessera-crossdevice.exe 这个程序，不按端口：QUIC 监听端口由系统随机分配，
 * 按程序放行覆盖它开的所有 socket，包括固定端口的信标。
 *
 * 参数必须自己拼成一个字符串并加好引号：`Start-Process -ArgumentList` 收到数组时直接用空格拼接、
 * 不给含空格的元素补引号，`name=Tessera Cross-Device Sync` 到 netsh 就变成 `name=Tessera` 加野参数，
 * 全程无报错（UAC 通过、退出码 0），但建出的规则名不对，应用查完整名字，横幅永远显示"没有放行"。
 *
 * 放行所有网络配置文件，不只 domain,private：Windows 默认把新网络归为「公用」，家里 Wi-Fi 多半是 Public，
 * 只放 domain,private 则规则建对也不生效。暴露面很小：进程只回答信标探测（内容与公开广播的 mDNS TXT 相同）
 * 和 QUIC 握手，没有配对就拿不到任何东西（配对要对端手动同意并核对同一组安全码）。
 */
export async function allowThroughFirewall(program: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'firewall.not_windows' }
  if (!program || !path.isAbsolute(program)) return { ok: false, error: 'firewall.bad_program' }

  // 先删后加：重装或换安装位置后，同名旧规则指向已不存在的路径，永远匹配不上却在防火墙里可见，会误导排查。
  // 删除失败（本来就没有）不算错，所以两条删除不检查退出码。
  // 三步必须在同一次提权里完成，否则用户要连点三次 UAC。
  const cmdline = (verb: string, extra: string[]) =>
    psLiteral(
      ['advfirewall', 'firewall', verb, 'rule', `name=${FIREWALL_RULE_NAME}`, ...extra]
        .map(netshArg)
        .join(' '),
    )

  // 清掉旧版留下的截断规则。**按名字 + 程序路径双重限定**：只删我们自己建的
  // 那一条，绝不会误伤用户自己建的、碰巧也叫 Tessera 的规则。
  const legacyCleanup = psLiteral(
    ['advfirewall', 'firewall', 'delete', 'rule', `name=${LEGACY_TRUNCATED_RULE_NAME}`, 'dir=in', `program=${program}`]
      .map(netshArg)
      .join(' '),
  )

  const script =
    `$ErrorActionPreference = 'Stop'; ` +
    `Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList ${cmdline('delete', ['dir=in'])} -ErrorAction SilentlyContinue; ` +
    `Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList ${legacyCleanup} -ErrorAction SilentlyContinue; ` +
    `$p = Start-Process -FilePath netsh -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
      `-ArgumentList ${cmdline('add', ['dir=in', 'action=allow', `program=${program}`, 'enable=yes', 'profile=any'])}; ` +
    `exit $p.ExitCode`

  try {
    // Start-Process -Verb RunAs 是弹 UAC 的标准做法。-Wait 让我们能拿到结果；
    // 用户在 UAC 上点"否"会让 Start-Process 抛错，正好被下面 catch 成失败。
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { windowsHide: true, timeout: 120_000 })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 最常见的失败是用户在 UAC 上点了"否"。不把它当异常上报，界面显示成
    // "没有授权"就够了——用户刚刚亲手拒绝的事情，不需要再被告知一次错误。
    return { ok: false, error: message }
  }
}
