/**
 * 五个解锁方式的按钮永不卡在禁用态。`vaultApi.call` 会抛：后端 VaultError 走 error 信封，
 * pythonBridge 收到即 reject，`setBusy(false)` 执行不到。类型和 lint 守不住，
 * 所以盯源码：每个 handler 必须经 attemptUnlock，busy 复位必须在 finally 里。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/UnlockTabs.tsx', import.meta.url)),
  'utf8',
)

/** 取出 `export function <name>(` 到下一个 `export function` 之间的那一段。 */
function componentBody(name) {
  const start = SOURCE.indexOf(`export function ${name}(`)
  assert.notEqual(start, -1, `找不到组件 ${name}`)
  const next = SOURCE.indexOf('\nexport function ', start + 1)
  return SOURCE.slice(start, next === -1 ? undefined : next)
}

const FACTORS = [
  { component: 'PasswordTab', method: 'unlock_password' },
  { component: 'TotpTab', method: 'unlock_totp' },
  { component: 'EmailTab', method: 'unlock_email_finish' },
  { component: 'RecoveryTab', method: 'unlock_recovery' },
  { component: 'BiometricTab', method: 'unlock_fingerprint' },
]

for (const { component, method } of FACTORS) {
  test(`${component}：${method} 经 attemptUnlock 调用，抛出来也有结果`, () => {
    const body = componentBody(component)
    assert.match(
      body,
      // `call(` 和方法名之间允许换行——参数多起来之后 prettier 会把它折行。
      new RegExp(`attemptUnlock\\(\\(\\)\\s*=>\\s*vaultApi\\.call\\(\\s*'${method}'`),
      `${component} 必须用 attemptUnlock 包住 ${method}，否则 reject 会穿出去`,
    )
  })

  test(`${component}：忙碌状态的复位在 finally 里`, () => {
    const body = componentBody(component)
    assert.ok(
      // finally 和复位之间允许夹注释，所以不能要求紧挨着
      /finally\s*\{[\s\S]{0,600}?set(Busy|Verifying)\(false\)/.test(body),
      `${component} 必须在 finally 里解禁按钮，不能写在 await 后面`,
    )
  })
}

test('邮箱的"发送验证码"也一样——它跟解锁按钮是两个独立的忙碌状态', () => {
  const body = componentBody('EmailTab')
  assert.match(body, /attemptUnlock\(\(\)\s*=>\s*vaultApi\.call\('unlock_email_start'/)
  assert.ok(/finally\s*\{[\s\S]{0,600}?setSending\(false\)/.test(body))
})

/**
 * “屏幕上永远有一条出路”：Windows Hello 验证框对主窗口模态，没浮到前面时主窗口被禁用，
 * setVerifying(false) 救不了。验证进行中必须有两个不随 verifying 变灰的出口：取消（撤销提示框）和换方式（先撤再切）。
 */
const BIOMETRIC = componentBody('BiometricTab')

test('验证进行中，取消按钮存在且不跟着 verifying 变灰', () => {
  assert.match(BIOMETRIC, /\{verifying && \([\s\S]{0,400}?onClick=\{handleCancel\}/)
  // disabled={verifying} 会让这个按钮在唯一需要它的时刻恰好点不动。
  assert.doesNotMatch(
    BIOMETRIC.slice(BIOMETRIC.indexOf('{verifying && (')),
    /onClick=\{handleCancel\}[\s\S]{0,200}?disabled=/,
    '取消按钮不能带 disabled——它存在的意义就是在别的东西卡住时还能点',
  )
})

test('自动发起的那一次带短预算，手动那次不带', () => {
  // 验证框对应用窗口是模态的（实测 IsWindowEnabled 为 False），所以这个预算
  // 就是"登录页最多有多久点不动"。自动发起的必须短，否则每次开应用都锁一次。
  assert.match(
    BIOMETRIC,
    /isAutoAttempt \? \{ timeout_seconds: AUTO_ATTEMPT_TIMEOUT_SECONDS \} : \{\}/,
  )
})

test('自动那次超时后替用户切到密码——那一刻他自己切不动', () => {
  assert.match(BIOMETRIC, /if \(isAutoAttempt && isTimeout\) onUseAnotherFactor\?\.\(\)/)
})

test('取消走的是后端的协商撤销，不是只改前端状态', () => {
  // 只在前端把 verifying 置回 false，那个看不见的模态框还在，窗口仍然是禁用的。
  assert.match(BIOMETRIC, /vaultApi\.call\('unlock_fingerprint_cancel'/)
})

test('「改用其他方式」先撤销再切走', () => {
  const fn = BIOMETRIC.slice(BIOMETRIC.indexOf('async function handleUseAnotherFactor'))
  const cancelAt = fn.indexOf('handleCancel()')
  const switchAt = fn.indexOf('onUseAnotherFactor?.()')
  assert.ok(cancelAt !== -1 && switchAt !== -1, '两步都要有')
  assert.ok(
    cancelAt < switchAt,
    '顺序反了的话用户会看到密码框，却因为那个看不见的模态框还在而一个字都打不进去',
  )
})

test('用户主动取消之后不再甩一句"验证失败"给他', () => {
  assert.match(BIOMETRIC, /if \(canceledRef\.current\)/)
})

test('超时被单独认出来，按钮换成"重新验证"而不是降级到密码', () => {
  const body = componentBody('BiometricTab')
  // 超时的含义是"这次没验成"，不是"这台机器不行"——不能进 FINGERPRINT_UNUSABLE_ERRORS
  // 那条降级到密码的路，否则用户连再试一次的机会都没有。
  assert.doesNotMatch(
    SOURCE.slice(0, SOURCE.indexOf('export function')),
    /FINGERPRINT_UNUSABLE_ERRORS[\s\S]*?verification_timeout[\s\S]*?\]\)/,
    '超时不属于"这台机器用不了生物识别"',
  )
  assert.match(body, /const isTimeout = res\.error === 'fingerprint\.verification_timeout'/)
  assert.match(body, /setTimedOut\(isTimeout\)/)
  assert.match(body, /timedOut \? t\('biometricRetryButton'\)/)
})
