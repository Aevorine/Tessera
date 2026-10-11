/**
 * 恢复码 OCR 导入所需本地资源。识别用的 worker/wasm/语言包全走 URL 加载，路径不对或缺一个文件，
 * 表现都只是「点了识别，转一下，什么也没发生」。两个坑各一条用例：
 *   1. 路径写成 `/tesseract/...`（带开头斜杠）：开发模式 Vite 有 URL 根能跑，打包后页面是 file://，会解析到盘根。
 *   2. tesseract.js 按 CPU 特性挑 core 变体，现代 Chromium 支持 relaxed SIMD，要 `-relaxedsimd-lstm` 那份，
 *      而 public/ 当初只手工拷了 simd 和无 simd 两份。
 * 跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { filePathToFileUrl } from '../src/lib/ocr.ts'

const ocrSource = readFileSync(new URL('../src/lib/ocr.ts', import.meta.url), 'utf-8')
const publicDir = new URL('../public/tesseract/', import.meta.url)

test('资源路径不带开头的斜杠，且解析成完整 URL 后再交给 tesseract.js', () => {
  // 开头的斜杠在 file:// 下会解析到盘根，是那次"OCR 在装好的应用里从来没成功过"
  // 的根因。相对路径也不能直接传——见 ocr.ts 里 assetUrl 的注释。
  assert.ok(
    !/['"]\/tesseract\//.test(ocrSource),
    "ocr.ts 里出现了以 '/' 开头的 tesseract 资源路径，打包后会解析到盘根",
  )
  for (const option of ['workerPath', 'corePath', 'langPath']) {
    assert.match(
      ocrSource,
      new RegExp(`${option}:\\s*assetUrl\\(`),
      `${option} 必须经过 assetUrl() 解析成完整 URL`,
    )
  }
  assert.match(ocrSource, /new URL\(relativePath, document\.baseURI\)/, 'assetUrl 应以文档地址为基址')
})

test('tesseract.js 可能索取的每一个 LSTM core 变体都在 public/ 里', () => {
  // ocr.ts 固定 OEM.LSTM_ONLY(=1)，只会要 `-lstm` 三种变体之一，由运行时 relaxedSimd()/simd() 探测决定；
  // 三种都得备着，少哪种就只在恰好探测到那一档的机器上坏。
  assert.match(ocrSource, /OEM_LSTM_ONLY = 1/, 'ocr.ts 不再是 LSTM_ONLY，这条用例覆盖的变体清单要跟着改')
  for (const variant of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
    for (const ext of ['.wasm.js', '.wasm']) {
      const file = new URL(`core/${variant}${ext}`, publicDir)
      assert.ok(existsSync(file), `缺少 public/tesseract/core/${variant}${ext}`)
    }
  }
})

test('带 Legacy 引擎的那两个 core 变体不在 public/ 里', () => {
  // `tesseract-core.wasm*` / `-simd.wasm*` 是含 Legacy 引擎的全量版本，tesseract.js 只在 lstmOnly 为假时才要；
  // 我们传 OEM 1、没传 legacyCore，lstmOnly 恒真，这两个变体从不会被请求，白占 15.5 MB（安装包约 8 MB）。
  // 本用例防止下次整目录拷贝把它们带回来。
  for (const variant of ['tesseract-core', 'tesseract-core-simd', 'tesseract-core-relaxedsimd']) {
    for (const ext of ['.wasm.js', '.wasm']) {
      const file = new URL(`core/${variant}${ext}`, publicDir)
      assert.ok(
        !existsSync(file),
        `public/tesseract/core/${variant}${ext} 是含 Legacy 引擎的版本，OEM 固定 LSTM_ONLY 时用不到，删掉`,
      )
    }
  }
  // 上面这条只有在 OEM 仍是 LSTM_ONLY 时才成立——真要用 Legacy 引擎，得把对应变体拷回来。
  assert.match(ocrSource, /OEM_LSTM_ONLY = 1/, 'ocr.ts 不再是 LSTM_ONLY，Legacy 变体就不能再断言"必须缺席"')
})

test('worker 与语言包在位，且语言包是 gzip 的那一份', () => {
  assert.ok(existsSync(new URL('worker.min.js', publicDir)), '缺少 public/tesseract/worker.min.js')
  // ocr.ts 传 gzip:true，对应的必须是 .gz；换成未压缩的那份会静默取不到。
  assert.match(ocrSource, /gzip:\s*true/, 'ocr.ts 的 gzip 选项变了，语言包文件名要跟着改')
  assert.ok(
    existsSync(new URL('lang-data/eng.traineddata.gz', publicDir)),
    '缺少 public/tesseract/lang-data/eng.traineddata.gz',
  )
})

test('图片路径转 file:// URL 后仍指向同一个文件', () => {
  // `#` 会被当片段、`?` 当查询串、`%41` 被解回 `A`，拼出的 URL 都指向另一个不存在的文件，识别失败而界面看不出与文件名有关。
  // 逐段编码后必须能原样解回。
  const cases = [
    'D:/Screenshots/Screenshot 2026-07-30 121500.png',
    'D:/img/shot#1.png',
    'D:/img/100%41.png',
    'D:/img/a?b.png',
    'D:/图片/恢复码 截图.png',
    // 用户名写成占位符而不是某台机器上的真实账户名 —— 这份测试是公开的，
    // 而一个真实用户名在夹具里除了泄露之外不提供任何测试价值。
    String.raw`C:\Users\example\Pictures\shot (2)#a.png`,
  ]
  for (const input of cases) {
    const parsed = new URL(filePathToFileUrl(input))
    assert.equal(parsed.hash, '', `${input}: 文件名被当成了片段标识`)
    assert.equal(parsed.search, '', `${input}: 文件名被当成了查询串`)
    assert.equal(
      decodeURIComponent(parsed.pathname).slice(1),
      input.split('\\').join('/'),
      `${input}: 解析回来指向了别的文件`,
    )
  }
})

test('盘符不被编码', () => {
  // 编码成 D%3A 之后 URL 解析器不再把它当 Windows 盘符。
  assert.match(filePathToFileUrl('D:/a.png'), /^file:\/\/\/D:\//)
})
