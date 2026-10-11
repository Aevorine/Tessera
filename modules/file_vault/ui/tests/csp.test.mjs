/**
 * 内容安全策略断言，守的不是「CSP 存在」而是打包版里绝不能出现的东西：
 * 为让某功能跑通顺手加 `https:` 或 `'unsafe-eval'` 会使整条策略名存实亡且无报错。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CSP_PLACEHOLDER, buildCsp, injectCsp } from '../scripts/csp-policy.mjs'

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf-8')

test('index.html carries the placeholder the build replaces', () => {
  // 占位符没了的话，CSP 会静默地完全不生效——页面照常工作，没有任何迹象。
  assert.ok(indexHtml.includes(CSP_PLACEHOLDER), 'index.html 里的 CSP 占位符不见了')
})

test('the packaged policy allows no remote origin at all', () => {
  const prod = buildCsp({ dev: false })
  // 这是整件事的核心：金库解锁之后内容就在渲染进程内存里，能发出去的通道只有
  // 网络。策略里一旦出现任意远程 scheme，外传就重新成立了。
  for (const scheme of ['http:', 'https:', 'ws:', 'wss:']) {
    assert.ok(!prod.includes(scheme), `打包版策略里不该出现 ${scheme}`)
  }
})

test('the packaged policy never relaxes script execution', () => {
  const prod = buildCsp({ dev: false })
  assert.ok(!prod.includes("'unsafe-eval'"), '打包版绝不能放行 unsafe-eval')
  const scriptSrc = /script-src([^;]*)/.exec(prod)
  assert.ok(scriptSrc, '缺 script-src')
  assert.ok(!scriptSrc[1].includes("'unsafe-inline'"), '打包版 script-src 不能放行 unsafe-inline')
})

test('the packaged policy denies by default and blocks the usual escape hatches', () => {
  const prod = buildCsp({ dev: false })
  assert.ok(prod.includes("default-src 'none'"), '没有 default-src none 就不是白名单模型')
  assert.ok(prod.includes("object-src 'none'"), '<object>/<embed> 是老牌绕过途径')
  assert.ok(prod.includes("base-uri 'none'"), '注入一个 <base> 就能改写所有相对路径的解析基准')
  assert.ok(prod.includes("form-action 'none'"), '表单提交同样是一条外传通道')
})

test('local schemes stay allowed so the app actually works offline', () => {
  const prod = buildCsp({ dev: false })
  // 打包后页面是 file:// 加载的，tesseract.js 用 fetch 取本地 wasm 和语言包。
  // 把这些一起禁掉，OCR 会直接不能用——CSP 收得太紧和收得不够一样是 bug。
  assert.ok(/connect-src[^;]*file:/.test(prod), 'connect-src 需要 file: 否则本地 wasm 取不到')
  assert.ok(/img-src[^;]*data:/.test(prod), '二维码等用 data: URI')
  assert.ok(/worker-src[^;]*blob:/.test(prod), 'tesseract.js 用 blob 起 Worker')
})

test('the dev policy keeps HMR working', () => {
  const dev = buildCsp({ dev: true })
  // 开发环境写死严格策略的话，HMR 直接不工作，而且报错信息跟 CSP 毫无关联，
  // 排查起来非常费劲。
  assert.ok(dev.includes("'unsafe-eval'"), 'Vite 的模块热替换需要 eval')
  assert.ok(dev.includes('ws:'), 'HMR 走 WebSocket')
})

test('injection produces exactly one meta tag and leaves no placeholder', () => {
  const out = injectCsp(`<head>${CSP_PLACEHOLDER}</head>`, { dev: false })
  assert.ok(!out.includes(CSP_PLACEHOLDER), '占位符没被替换')
  assert.equal((out.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1)
  // 策略串会被塞进 HTML 属性里，出现裸引号就会把属性截断，
  // 得到一个残缺但**语法上仍然合法**的策略——静默失效的经典形态。
  assert.ok(!buildCsp({ dev: false }).includes('"'), '策略串里不能有双引号')
})
