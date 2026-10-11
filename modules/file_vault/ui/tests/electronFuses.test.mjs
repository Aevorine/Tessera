import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Electron 保险丝是构建时烧进可执行文件的开关：配错无编译错误、测试也不红，只会让某条运行时路径悄悄失效，
// 往往到真发版、真点更新才暴露。这些用例为此而设。

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function readText(rel) {
  return readFileSync(ROOT + rel, 'utf8')
}

/** electron-builder.json5 带注释和尾逗号，JSON.parse 不认；仅做去行注释和尾逗号的清洗，文件自己写的，不值得多引一个 JSON5 依赖。 */
function readBuilderConfig() {
  const raw = readText('electron-builder.json5')
  const noComments = raw
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrailingCommas)
}

test('保险丝配置存在且是对象', () => {
  const cfg = readBuilderConfig()
  assert.ok(cfg.electronFuses, 'electron-builder.json5 里必须有 electronFuses')
})

test('asar 完整性校验和「只从 asar 加载」必须同时开', () => {
  // 这两条配套：只开完整性校验，攻击者在 resources/ 放 app/ 目录会被优先加载，asar 没被读到，校验白过；
  // 只开「只从 asar 加载」，asar 可被解包重打，同样等于没开。
  const fuses = readBuilderConfig().electronFuses
  assert.equal(fuses.onlyLoadAppFromAsar, true)
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true)
})

test('调试器附加和 NODE_OPTIONS 注入必须关掉', () => {
  // 金库解锁之后主密钥就在这个进程的内存里。--inspect 开着等于把它交出去。
  const fuses = readBuilderConfig().electronFuses
  assert.equal(fuses.enableNodeCliInspectArguments, false)
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false)
})

test('runAsNode 只要更新器还在用 ELECTRON_RUN_AS_NODE 就不能关', () => {
  // 守一个跨文件隐式依赖：electron/updateInstaller.ts 靠 ELECTRON_RUN_AS_NODE=1 把自己当 node 跑，
  // 启动必须活过主进程退出的 update runner。关掉 runAsNode 看似无害的加固，唯一坏的是「点更新」：应用退出后什么都不发生。
  const installer = readText('electron/updateInstaller.ts')
  const usesRunAsNode = /ELECTRON_RUN_AS_NODE/.test(installer)
  const fuses = readBuilderConfig().electronFuses

  if (usesRunAsNode) {
    assert.notEqual(
      fuses.runAsNode,
      false,
      'updateInstaller.ts 还在用 ELECTRON_RUN_AS_NODE 启动 update runner。' +
        '关掉 runAsNode 会让自动更新静默失效——应用退出后什么都不会发生。\n' +
        '要关它的话，先把 update runner 改成用别的方式启动（比如打包一个独立的小 exe）。',
    )
  } else {
    // 依赖已经解除了 —— 那就该把这条保险丝关上，别白留一个攻击面。
    assert.equal(
      fuses.runAsNode,
      false,
      'updateInstaller.ts 已经不用 ELECTRON_RUN_AS_NODE 了，runAsNode 该关掉。',
    )
  }
})

test('asar 必须是开的——保险丝全都建立在这个前提上', () => {
  const cfg = readBuilderConfig()
  assert.equal(cfg.asar, true, 'asar: false 会让上面几条保险丝全部失去意义')
})
