import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { unlockFactorOrder } from '../src/lib/unlockFactors.ts'

const source = readFileSync(new URL('../src/components/LoginScreen.tsx', import.meta.url), 'utf8')
const dialogSource = readFileSync(new URL('../src/components/UnlockDialog.tsx', import.meta.url), 'utf8')
const tabsSource = readFileSync(new URL('../src/components/UnlockTabs.tsx', import.meta.url), 'utf8')
const hookSource = readFileSync(new URL('../src/lib/useBiometricStatus.ts', import.meta.url), 'utf8')

const ALL = { password: true, totp: true, email: true, recovery: true }

test('order is face → fingerprint → password → others, biometrics first', () => {
  const order = unlockFactorOrder({ available: true, bound: true, chain: ['face', 'fingerprint'], factors: ALL })
  assert.deepEqual(order, ['face', 'fingerprint', 'password', 'totp', 'email', 'recovery'])
})

test('factors this device cannot do are not shown', () => {
  // 只有指纹：不出现人脸
  assert.deepEqual(unlockFactorOrder({ available: true, bound: true, chain: ['fingerprint'], factors: ALL })[0], 'fingerprint')
  assert.ok(!unlockFactorOrder({ available: true, bound: true, chain: ['fingerprint'], factors: ALL }).includes('face'))
  // Hello 未配置 / 金库未绑定：没有任何生物识别档，密码排第一
  assert.equal(unlockFactorOrder({ available: false, bound: true, chain: ['fingerprint'], factors: ALL })[0], 'password')
  assert.equal(unlockFactorOrder({ available: true, bound: false, chain: ['face'], factors: ALL })[0], 'password')
  // 金库没配的因子不显示
  const noExtras = unlockFactorOrder({ available: false, bound: false, chain: [], factors: { password: true, totp: false, email: false, recovery: true } })
  assert.deepEqual(noExtras, ['password', 'recovery'])
  // Hello 可用但枚举不出传感器类型：给中性 Windows Hello 档
  assert.equal(unlockFactorOrder({ available: true, bound: true, chain: [], factors: ALL })[0], 'biometric')
  // 旧后端不回 factors：全显示
  assert.equal(unlockFactorOrder({ available: false, bound: false, chain: [] }).length, 4)
})

test('a late or changed probe moves the user back to biometrics unless they picked a tab', () => {
  // 根因修复：缓存说「不可用」先落到密码，真结果回来时必须回切到第一个因子
  assert.match(tabsSource, /setFactor\(\(cur\) => \(!userPicked\.current \|\| !factorsRef\.current\.includes\(cur\) \? factorsRef\.current\[0\] : cur\)\)/)
  assert.match(tabsSource, /\}, \[orderKey\]\)/)
  // 探测失败不写缓存、不当成没有生物识别
  assert.match(hookSource, /if \(status\) writeStored\(status\)/)
  assert.match(hookSource, /RETRY_DELAYS_MS/)
})

test('login page and re-auth dialog share one factor component', () => {
  assert.match(source, /<UnlockFactorTabs onUnlocked=\{onUnlocked\} \/>/)
  assert.match(dialogSource, /<UnlockFactorTabs key=\{String\(open\)\} active=\{open\}/)
  assert.match(tabsSource, /gridTemplateColumns: `repeat\(\$\{factors\.length\}, minmax\(0, 1fr\)\)`/)
  assert.match(tabsSource, /whitespace-normal/)
})

test('the login card is wide enough for the longest translations, and still fits a small window', () => {
  const card = source.match(/w-\[(\d+)px\] max-w-\[calc\(100vw-\d+rem\)\]/)
  assert.ok(card)
  assert.ok(Number(card[1]) >= 640)
})
