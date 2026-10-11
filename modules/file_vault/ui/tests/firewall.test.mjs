import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 防火墙最易悄悄坏掉的是几个看似无所谓的决定：判据用退出码还是文本、放行按程序还是按端口、公共网络放不放、
// 安装包与应用用的规则名是否相同。每条各锁一次。

const firewallSource = readFileSync(new URL('../electron/firewall.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8')
const nsisSource = readFileSync(new URL('../nsis/installer.nsh', import.meta.url), 'utf8')

/** 去掉注释再断言：本文件注释大量引用它「不该做」的事（如「不解析 Enabled: Yes」），对全文做 doesNotMatch 会被自己的说明绊倒，报错还极具误导性。 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const firewallCode = codeOnly(firewallSource)

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`
  const start = mainSource.indexOf(marker)
  assert.notEqual(start, -1, `${channel} handler must exist`)
  const nextHandler = mainSource.indexOf('ipcMain.handle(', start + marker.length)
  return mainSource.slice(start, nextHandler === -1 ? undefined : nextHandler)
}

test('查询靠退出码判定，不解析被本地化的输出文本', () => {
  // netsh 的 `show rule` 输出是本地化的（中文"已启用: 是"、英文 "Enabled: Yes"）。
  // 按文本匹配等于给每一种系统语言埋一个坑，而且坑只在那种语言的机器上才踩得到。
  assert.match(firewallCode, /code === 1/, '必须按退出码 1 判"规则不存在"')
  assert.doesNotMatch(
    firewallCode,
    /(Enabled|已启用|stdout\.includes|stdout\.match)/,
    '不许解析 netsh 的输出文本',
  )
})

test('查不出来时报 unknown，绝不猜成 blocked', () => {
  // 猜成 blocked 会让一台其实没问题的机器一直显示"防火墙挡着你"，用户照着
  // 提示点了放行、弹了 UAC、什么也没改善——比不显示更糟。
  assert.match(firewallSource, /return \{ state: 'unknown', program \}/)
})

test('按程序放行，不按端口', () => {
  // QUIC 的监听端口是系统随机分配的，按端口放行等于每次启动都要重加一条规则。
  assert.match(firewallCode, /program=\$\{program\}/)
  assert.doesNotMatch(firewallCode, /localport=|protocol=UDP/i)
})

test('放行覆盖所有网络配置文件，且应用与安装包一致', () => {
  // 曾设 profile=domain,private，看似保守实则废掉功能：Windows 默认把新网络归为「公用」，家里 Wi-Fi 多半是 Public，
  // 规则建对了也不生效，且防火墙面板里规则明明在，极难排查。暴露面很小：进程只答信标探测和 QUIC 握手，未配对拿不到任何东西。
  assert.match(firewallCode, /profile=any/, '应用侧必须放行所有配置文件')
  assert.doesNotMatch(firewallCode, /profile=domain,private/, '不能退回只放专用网络')
  assert.match(nsisSource, /profile=any/, '安装包侧必须和应用侧一致')
  // 两边不一致的后果很具体：安装包建一条只在专用网络生效的规则，应用查得到
  // （名字对得上）于是报"已放行"，而用户在公用 Wi-Fi 上依然连不上任何设备。
  assert.doesNotMatch(nsisSource, /add rule[^\n]*profile=domain,private/)
})

test('规则名里的空格必须被引号包住', () => {
  // 真机踩过的无声坑：PowerShell Start-Process -ArgumentList 收到数组时直接用空格拼接，不给含空格元素补引号，
  // `name=Tessera Cross-Device Sync` 到 netsh 变成 `name=Tessera` 加两个野参数；UAC 点了同意、退出码 0，
  // 但建出的规则名不对，应用按完整名查，横幅永远显示「没有放行」。
  assert.match(firewallCode, /function netshArg/, '必须有专门的参数加引号函数')
  assert.match(firewallCode, /value\.includes\(' '\)/, '判据是"值里有没有空格"')
  // -ArgumentList 只能收拼好的单个字符串，绝不能再退回数组写法。
  const body = firewallCode.slice(firewallCode.indexOf('export async function allowThroughFirewall'))
  assert.doesNotMatch(
    body,
    /-ArgumentList \$\{args\(/,
    '不许把参数数组直接交给 -ArgumentList（空格会丢引号）',
  )
  assert.match(body, /\.map\(netshArg\)\s*\n?\s*\.join\(' '\)/, '参数要逐个加引号后拼成一串')
})

test('顺手清掉旧版留下的截断规则', () => {
  // 那条名为 Tessera、绑在不存在服务上的规则什么都不放行，却在防火墙面板里可见，会把排查带偏。
  // 删除必须同时限定程序路径，避免误伤用户自建的同名规则。
  const body = firewallCode.slice(firewallCode.indexOf('export async function allowThroughFirewall'))
  assert.match(firewallCode, /LEGACY_TRUNCATED_RULE_NAME = 'Tessera'/)
  assert.match(body, /legacyCleanup/, '必须清理旧的截断规则')
  assert.match(
    firewallCode,
    /name=\$\{LEGACY_TRUNCATED_RULE_NAME\}[^\n]*program=\$\{program\}/,
    '删除旧规则必须同时限定程序路径，不能只按名字删',
  )
})

test('先删后加在同一次提权里做完，而且真的被执行', () => {
  // 曾有版本把 delete+add 拼成字符串却没执行（只 `void script`），重装换目录后旧规则指向不存在的 exe：
  // 查得到却匹配不上，表现同「没有规则」，但防火墙里可见，排查方向全错。
  const body = firewallCode.slice(firewallCode.indexOf('export async function allowThroughFirewall'))
  assert.match(body, /'delete'/, '必须先删旧规则')
  assert.match(body, /'add'/, '必须再加新规则')
  assert.doesNotMatch(body, /void script/, 'script 必须被执行，不能只是拼出来放着')
  assert.match(body, /-Command', script/, '拼好的脚本要真的传给 powershell')
  // 一次 UAC 完成两步：分两次 Start-Process -Verb RunAs 会让用户点两次 UAC。
  assert.equal(
    (body.match(/execFileAsync\(/g) ?? []).length,
    1,
    '整个放行流程只允许一次提权调用',
  )
})

test('添加规则永远不在启动时自动跑', () => {
  // 改防火墙是对系统安全配置的修改，属于用户必须知情的那一类。
  const statusHandler = handlerSource('crossdevice:firewall-status')
  assert.match(statusHandler, /firewallStatus\(/)
  assert.doesNotMatch(statusHandler, /allowThroughFirewall/, '查询不许顺手改')
})

test('两个防火墙 IPC 都校验发送方', () => {
  for (const channel of ['crossdevice:firewall-status', 'crossdevice:firewall-allow']) {
    assert.match(
      handlerSource(channel),
      /assertTrustedRenderer\(event\)/,
      `${channel} 必须先 assertTrustedRenderer(event)`,
    )
  }
})

test('放行的是守护进程，不是 Electron 主程序', () => {
  // 被 Windows 拦下的是那个无窗口子进程；放行主程序一点用都没有。
  for (const channel of ['crossdevice:firewall-status', 'crossdevice:firewall-allow']) {
    assert.match(handlerSource(channel), /CROSSDEVICE_COMMAND/)
  }
})

test('渲染端拿不到"要放行哪个程序"的决定权', () => {
  // preload 暴露的两个方法都不收参数：路径由主进程从 CROSSDEVICE_COMMAND 取。
  // 让渲染端传路径等于把"给任意 exe 开防火墙"这个能力递出去。
  assert.match(preloadSource, /firewallStatus: \(\):/)
  assert.match(preloadSource, /firewallAllow: \(\):/)
})

test('安装包和应用用的是同一个规则名', () => {
  // 对不上的话两边各管各的规则，应用永远报"未放行"，而用户在防火墙里明明
  // 看得见一条 Tessera 的规则——最容易把人带偏的一种不一致。
  const inApp = firewallSource.match(/FIREWALL_RULE_NAME = '([^']+)'/)
  const inInstaller = nsisSource.match(/!define TESSERA_FIREWALL_RULE "([^"]+)"/)
  assert.ok(inApp, 'firewall.ts 必须导出 FIREWALL_RULE_NAME')
  assert.ok(inInstaller, 'installer.nsh 必须定义 TESSERA_FIREWALL_RULE')
  assert.equal(inApp[1], inInstaller[1], '两处规则名必须一字不差')
  // 纯 ASCII：NSIS 脚本里的非 ASCII 字面量取决于 makensis 怎么解码源文件，
  // 理解不一致时不报错，只会静默地对不上。
  assert.match(inApp[1], /^[\x20-\x7E]+$/, '规则名必须是纯 ASCII')
})

test('卸载时把规则删掉，不留孤儿', () => {
  // 留着的话它指向一个已被删除的 exe：查得到、匹配不上。下一次排查时用户
  // 看到"Tessera 明明在允许列表里"，就再也不往这个方向想了。
  const uninstall = nsisSource.slice(nsisSource.indexOf('!macro customUnInstall'))
  assert.match(uninstall, /firewall delete rule name="\$\{TESSERA_FIREWALL_RULE\}"/)
})
