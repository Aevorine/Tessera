/**
 * U1（加密卡片吸收“高级操作”）与 U2（统计数字可点击）的不变量：坏了界面照常渲染，
 * 只是点了没反应或找不到，所以只能在源码层面盯。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const STAT_TILE = read('../src/components/StatTile.tsx')
const CLIPBOARD = read('../src/components/ClipboardScreen.tsx')
const PASSWORDS = read('../src/components/PasswordScreen.tsx')
const RECOVERY = read('../src/components/RecoveryCodesScreen.tsx')
const FILES = read('../src/components/FilesPane.tsx')
const METRICS = read('../src/lib/passwordMetrics.ts')

test('StatTile 传了 onClick 才变成按钮，不传保持纯展示', () => {
  // 不传时必须还是 div：别的地方可能还在把它当纯展示用，变成 button 会平白
  // 多出一个可聚焦、可回车触发的空控件。
  assert.match(STAT_TILE, /if \(!onClick\) \{\s*return <div className="rounded border p-4 text-center">/)
  assert.match(STAT_TILE, /<button[\s\S]*?aria-pressed=\{active\}/)
})

test('剪贴板三块数字都接了筛选，且「已隐藏」仍然要过解锁验证', () => {
  const block = CLIPBOARD.slice(CLIPBOARD.indexOf("t('statTotalLabel')"), CLIPBOARD.indexOf('clickToPasteHint'))
  assert.match(block, /t\('statTotalLabel'\)\}[\s\S]*?onClick=\{/)
  assert.match(block, /label=\{t\('statPinnedLabel'\)\}[\s\S]*?onClick=\{/)
  // 关键：隐藏那一块必须走 handleToggleHiddenOnly（里面有 ensureFreshlyUnlocked），
  // 不能图省事直接 setHiddenOnly(true) —— 那等于给隐藏内容开了一道不用验证的后门。
  assert.match(
    block,
    /label=\{t\('statHiddenLabel'\)\}[\s\S]*?onClick=\{\(\) => void handleToggleHiddenOnly\(\)\}/,
    '「已隐藏」必须复用带解锁验证的 handleToggleHiddenOnly',
  )
})

test('密码库的「重复使用」是独立指标，不能塞进强度里', () => {
  // 重复使用的密码即使强度高也要单独成一档，不能折进 weak/fair/good/strong；
  // 判据在 lib/passwordMetrics.ts 的通用指标定义处。
  assert.match(METRICS, /id: 'reused',/)
  assert.match(
    METRICS,
    /id: 'reused',[\s\S]{0,400}?match: \(e, ctx\) => Boolean\(e\.password\) && ctx\.reusedPasswords\.has\(e\.password\)/,
    '「重复使用」的判定必须只看有没有第二条用同一个密码，跟强度无关',
  )
  // 统计与筛选必须共用同一份 reusedPasswords，否则会“数字 3 条、筛出 2 条”。
  // 守的是唯一来源而非某行写法，别断言构造字面量，否则无关重构会误红、守卫被删。
  assert.match(METRICS, /export function buildMetricContext[\s\S]{0,900}?reusedPasswords:/)
  const producers = METRICS.match(/reusedPasswords:\s/g) ?? []
  assert.equal(
    producers.length,
    2, // 一处是 MetricContext 接口里的字段声明，一处是 buildMetricContext 里的赋值
    'reusedPasswords 只能由 buildMetricContext 产出一次，别处自己再数一遍必然对不上',
  )
  assert.ok(
    !/reusedPasswords\s*=/.test(METRICS),
    'reusedPasswords 不许在 buildMetricContext 之外被重新赋值',
  )
  // 强度那把尺子里不许混进 reused 这一档。
  const strength = /export type PasswordStrength[^\n]*\n/.exec(METRICS)
  assert.ok(strength, 'passwordMetrics.ts 里找不到 PasswordStrength 的定义')
  assert.ok(!strength[0].includes('reused'), 'reused 被折进强度枚举里了')
})

test('恢复码的导入和导出不再共用同一个图标', () => {
  assert.match(RECOVERY, /id: 'import',[^\n]*icon: ArrowDownToLine/)
  assert.match(RECOVERY, /id: 'export',[^\n]*icon: ArrowUpFromLine/)
})

test('恢复码三块数字都能点进完整列表', () => {
  // 逐块检查每个 <StatTile> 是否把视图切到 'list'，而不是按字符位置切片：磁贴搬家后位置会变，
  // 要守的是三块数字都能点进完整列表。
  const usages = RECOVERY.match(/<StatTile\b[\s\S]*?\/>/g) ?? []
  for (const key of ['dashboardServiceCountLabel', 'dashboardCodeCountLabel', 'dashboardRemainingCountLabel']) {
    const tile = usages.find((u) => u.includes(`t('${key}')`))
    assert.ok(tile, `恢复码少了 ${key} 这一块统计`)
    assert.match(
      tile,
      /onClick=\{\(\) => setView\('list'\)\}/,
      `${key} 点下去必须切到完整列表——数字说"有 12 个服务"，用户下一步要看的就是这 12 个`,
    )
  }
})

test('加密算法只属于加密那一侧，解密侧没有算法选择', () => {
  // 2026-09-27 起算法选择从加密卡搬进了顶栏的「算法」菜单（整页一行顶栏，见
  // TopBar.tsx）。守的性质没变：算法只对"新建加密"有意义，解密那块不许出现。
  const algorithmMenu = FILES.slice(FILES.indexOf("id: 'algorithm',"), FILES.indexOf("id: 'encrypt-options',"))
  assert.match(algorithmMenu, /ENCRYPTION_PROFILES\.map/, '算法选择必须在顶栏的「算法」菜单里')
  const encryptCard = FILES.slice(FILES.indexOf("t('encryptCardTitle')"), FILES.indexOf("t('decryptCardTitle')"))
  assert.match(encryptCard, /onClick=\{handleEncryptFolder\}/, '「加密整个文件夹」也归加密卡')

  const decryptCard = FILES.slice(FILES.indexOf("t('decryptCardTitle')"))
  assert.doesNotMatch(decryptCard, /ENCRYPTION_PROFILES/, '解密侧不该有算法选择——选错的唯一结果是解不开')
})

test('抗量子档默认选中，且 AES-128 不再是可选项', () => {
  // 默认必须是抗量子那一档：实测代价是每文件 0.07 ms CPU（外加头部变大带来的
  // I/O），让用户自己去勾一个几乎无代价的保护是在制造一个多数人不会勾的选项。
  assert.match(FILES, /useState<EncryptionProfile>\('pq-aes-256-gcm'\)/, '默认档必须是抗量子')
  assert.match(FILES, /\{ value: 'pq-aes-256-gcm'[^}]*postQuantum: true \}/, '抗量子档必须真的带 postQuantum')

  // AES-128 是唯一量子对手占便宜处（Grover 把 128 位削成 64），必须从新建加密中消失，
  // 解密侧保留，见 crypto.RETIRED_FILE_CIPHERS 与 test_container.py。
  const profiles = FILES.slice(FILES.indexOf('const ENCRYPTION_PROFILES'), FILES.indexOf('// One entry per item'))
  assert.doesNotMatch(profiles, /aes-128/, 'AES-128 不能再出现在可选加密档里')
})

test('多选文件与整文件夹走的是同一个加密档', () => {
  // 文件夹与单文件是两个调用点，漏改一个不报错，文件夹会悄悄退回经典封装而“抗量子”按钮照亮。
  // 后端共用 rpc_encrypt_file，这里钉住前端三处都传 post_quantum（收进 extra，与口令分享互斥）。
  assert.match(FILES, /const extra = share \? shareParams\(share\) : \{ post_quantum: postQuantum \}/)
  const singleAndBatch = (FILES.match(/cipher,\s+\.\.\.extra/g) ?? []).length
  assert.equal(singleAndBatch, 2, '单文件与多选批量都要带上 post_quantum')
  assert.match(FILES, /handleEncryptFolder/, '整文件夹入口仍在（它复用同一个 RPC，因此同一个档位）')
})

test('那张叫「高级操作」的卡已经拆掉了', () => {
  assert.doesNotMatch(
    FILES,
    /<PageSection[^>]*t\('advancedSectionTitle'\)/,
    '别把它加回来：一个叫"高级操作"的抽屉不告诉用户里面是什么，而里面每一样都属于上面那两张卡',
  )
})
