import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/LoginScreen.tsx', import.meta.url), 'utf8')
const dialogSource = readFileSync(new URL('../src/components/UnlockDialog.tsx', import.meta.url), 'utf8')
const tabsSource = readFileSync(new URL('../src/components/UnlockTabs.tsx', import.meta.url), 'utf8')

test('login opens on biometrics and prompts Windows Hello without waiting for a click', () => {
  // 产品要求：启动时登录页默认停在生物识别并自动发起一次验证。没有 Windows Hello 的机器由下一条的自动回落处理，
  // 不再让所有人先看到密码框。
  assert.match(tabsSource, /export const DEFAULT_UNLOCK_FACTOR = 'fingerprint'/)
  assert.match(source, /<Tabs value=\{factor\} onValueChange=\{setFactor\}>/)
  assert.match(source, /useState<string>\(DEFAULT_UNLOCK_FACTOR\)/)
  assert.match(source, /<BiometricTab\s+autoStart/)
})

test('the modality shown follows the hardware this machine actually has', () => {
  // 「有人脸识别就默认弹人脸，否则弹指纹」——图标和文案都必须跟着探测结果走。
  // 在一台只有指纹传感器的机器上画一张人脸，用户会一直等一个不存在的摄像头。
  assert.match(tabsSource, /MODALITY_PRESENTATION[\s\S]*?face:[\s\S]*?ScanFace/)
  assert.match(tabsSource, /MODALITY_PRESENTATION[\s\S]*?fingerprint:[\s\S]*?Fingerprint/)
  assert.match(tabsSource, /MODALITY_PRESENTATION[\s\S]*?iris:[\s\S]*?Eye/)
  // 排序只能有一处（后端 preferred_chain），前端直接用 preferred，不自己重排。
  assert.match(tabsSource, /presentationFor\(bio\?\.preferred\)/)
  for (const surface of [source, dialogSource]) {
    assert.match(surface, /<UnlockFactorTabsList modality=\{biometric\?\.preferred\} \/>/)
    assert.match(surface, /status=\{biometric\}/)
  }
})

test('a machine that cannot use biometrics falls back to password on its own', () => {
  // 没绑 / 绑定已失效 / 没有传感器的机器上，自动那一次尝试必须静默换到密码：
  // 既不弹红框，也不把用户晾在一个按了没反应的面板上。
  assert.match(source, /onUnavailable=\{\(\) => setFactor\('password'\)\}/)
  assert.match(dialogSource, /onUnavailable=\{\(\) => setFactor\('password'\)\}/)
  assert.match(tabsSource, /FINGERPRINT_UNUSABLE_ERRORS[\s\S]*?auth\.fingerprint_not_bound/)
  assert.match(tabsSource, /FINGERPRINT_UNUSABLE_ERRORS[\s\S]*?auth\.fingerprint_binding_stale/)
  assert.match(tabsSource, /if \(isAutoAttempt\) \{[\s\S]{0,160}?onUnavailableRef\.current\?\.\(\)/)

  // 探测就已经说"用不了"时连一次 Hello 都不该弹——以前会先弹一个注定失败的
  // 系统框，用户白按一次传感器才被踢回密码框。
  assert.match(tabsSource, /if \(!bio\.available \|\| !bio\.bound\) \{[\s\S]{0,120}?onUnavailableRef\.current\?\.\(\)/)
  // 探测未回来（null）前不许抢跑，否则把空状态当「没有生物识别」；窗口不可见时也不许发起——
  // 藏在托盘弹 Hello 只会在后台空等超时，用户打开窗口时看到的已是密码框（「指纹要好几秒才出现」的根因）。
  assert.match(tabsSource, /if \(!autoStart \|\| bio === null \|\| !activation\.visible\) return/)
  // 每次窗口重新回到眼前都重新发起一次，同一次激活里只发起一次。
  assert.match(tabsSource, /autoGeneration\.current === activation\.generation/)
})

test('the forced re-auth dialog auto-prompts too, and re-arms every time it opens', () => {
  // 产品决策反转：要密码的地方一律先自动弹生物识别，设置里的强制复验也不例外。
  // 自动发起 ≠ 自动通过——用户仍要真的刷一次脸或按一次传感器。
  assert.match(dialogSource, /<BiometricTab\s+autoStart=\{open\}/)
  // 弹窗关掉再打开时组件并不卸载，两处重置缺一不可：key 让 BiometricTab 里
  // "只自动发起一次"的 ref 归零，effect 让上次降级到的密码档回到生物识别。
  assert.match(dialogSource, /<Tabs key=\{String\(open\)\}/)
  assert.match(dialogSource, /if \(open\) setFactor\(DEFAULT_UNLOCK_FACTOR\)/)
})

test('both unlock surfaces render the one shared factor list', () => {
  // 两处各写一遍标签栏的话，改了一处忘了另一处，重叠就只在其中一个界面复现，
  // 而"强制重新验证"那个对话框平时不容易被看到。
  assert.match(source, /<UnlockFactorTabsList modality=/)
  assert.match(dialogSource, /<UnlockFactorTabsList modality=/)
  assert.doesNotMatch(source, /grid-cols-5/)
  assert.doesNotMatch(dialogSource, /grid-cols-5/)
})

test('the five factors always fit on one row of five equal cells, never overlap', () => {
  const list = tabsSource.match(/export function UnlockFactorTabsList\([\s\S]*?\n}/)
  assert.ok(list, '找不到 UnlockFactorTabsList')
  const body = list[0]

  // 断言改过一次，理由留此防改回：原先断「按内容宽度排 + flex-wrap」，虽修好文字重叠，但五个因子在 680px 登录卡里
  // 折成 4+1 或 3+2，行数随语言变（中文一行、俄文两行），违反「界面要统一」。
  // 现断言「布局永远五等分一行，换行的是标签里的文字」：TabsTrigger 自带 whitespace-nowrap，故 grid-cols-5 必须与
  // whitespace-normal 成对出现，缺后者就退回文字重叠的老 bug。
  assert.match(body, /grid-cols-5/)
  assert.match(body, /whitespace-normal/, 'grid-cols-5 必须配 whitespace-normal，否则长译名会溢出压到隔壁标签')
  assert.doesNotMatch(body, /flex-wrap/, '标签栏本身不再折行，折的是标签里的文字')

  // flex-1 的 basis 是 0，会把标签压到比内容还窄；等分宽度现在由 grid 保证，
  // 标签自己不该再参与 flex 伸缩。
  assert.doesNotMatch(body, /className="[^"]*\bflex-1\b/)

  // 文字折行需要标签栏能长高；基础样式把水平方向钉成了 h-8。
  assert.match(body, /group-data-\[orientation=horizontal\]\/tabs:h-auto/)
  // 定高：某种语言下某个标签折成两行时，标签栏不该突然长高把下面的内容顶下去。
  assert.match(body, /min-h-16/)

  // 五个因子一个都不能少。标签栏改成由数组渲染之后，断言的是那份数据而不是
  // 五段重复的 JSX——按 JSX 字面量断言会在任何一次合理重构里假报警。
  for (const value of ['password', 'totp', 'email', 'recovery', 'fingerprint']) {
    assert.match(body, new RegExp(`value: '${value}'`), `缺少 ${value} 标签`)
  }
  // 生物识别排第一位：它是默认选中的那个，排到列表中间去会让默认值看起来像是
  // 随机挑的。
  const order = [...body.matchAll(/value: '(\w+)'/g)].map((m) => m[1])
  assert.equal(order[0], 'fingerprint', `因子顺序是 ${order.join(',')}，生物识别必须排第一`)
})

test('the login card is wide enough for the longest translations, and still fits a small window', () => {
  // 西语 "Clave de recuperación"、俄语 "Ключ восстановления" 最长。正则把固定宽度和它的窄窗口回退绑在一起匹配，
  // 避免命中页面上别的定宽元素（如右上角语言选择器）。
  const card = source.match(/w-\[(\d+)px\] max-w-\[calc\(100vw-\d+rem\)\]/)
  assert.ok(card, '登录卡片没有"固定宽度 + 窄窗口回退"这一对')
  assert.ok(Number(card[1]) >= 640, `登录卡片 ${card[1]}px 太窄，放不下最长的那种语言`)
})
