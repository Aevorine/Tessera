/**
 * 更新信任判定的单元测试，只覆盖拿到数据后的判断，不碰网络和真实签名（见 docs/standalone-exe-release.md 验收清单）。
 * 用 `node --experimental-strip-types`（Node ≥ 22.6）直接加载 .ts，被测文件不能用需转译的 TS 语法。跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UpdateError,
  assertTrustedSigner,
  chooseUpdateTarget,
  compareVersions,
  parseDigest,
  requiredFreeBytes,
  sanitizeReleaseNotes,
  selectUpdateAsset,
  versionFromTag,
} from '../electron/updateVersion.ts'

const PUBLISHER = 'Ideal1 Software'
const PINNED_KEY = 'b'.repeat(64)

/** 自签名策略：钉了公钥，不要求链可信。这是项目的默认模式。 */
const SELF_SIGNED = { publisher: PUBLISHER, publicKeySha256: PINNED_KEY }
/** CA 策略：没钉公钥，靠 Windows 的链验证。 */
const CA_ISSUED = { publisher: PUBLISHER, publicKeySha256: '' }

/** 自签名证书在真实 Windows 上的典型探测：签名算对但链不到受信根，状态为 UnknownError 而非 Valid。 */
function selfSignedSignature(overrides = {}) {
  return {
    status: 'UnknownError',
    statusMessage: 'A certificate chain processed, but terminated in a root certificate which is not trusted.',
    subject: `CN=${PUBLISHER}`,
    issuer: `CN=${PUBLISHER}`,
    simpleName: PUBLISHER,
    thumbprint: 'A'.repeat(40),
    publicKeySha256: PINNED_KEY,
    timestamped: false,
    ...overrides,
  }
}

/** 一份 CA 签发证书的典型探测结果：链验证通过，带时间戳。 */
function caSignature(overrides = {}) {
  return {
    status: 'Valid',
    statusMessage: 'Signature verified.',
    subject: `CN=${PUBLISHER}, O=${PUBLISHER}, C=CN`,
    issuer: 'CN=Some Public CA',
    simpleName: PUBLISHER,
    thumbprint: 'A'.repeat(40),
    publicKeySha256: 'c'.repeat(64),
    timestamped: true,
    ...overrides,
  }
}

function codeOf(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdateError, `expected an UpdateError, got ${error}`)
    return error.code
  }
  return null
}

// ---- 版本判断 ----

test('only v<strict semver> tags are accepted', () => {
  assert.equal(versionFromTag('v0.1.0'), '0.1.0')
  assert.equal(versionFromTag('v10.20.30'), '10.20.30')
  // 预发布、build 元数据、前导零、别的前缀一律拒绝——版本比较的正确性建立在
  // "只有三段数字"这个前提上，放进来一个就得处理 semver 的全部优先级规则。
  assert.equal(versionFromTag('v0.1.0-beta'), null)
  assert.equal(versionFromTag('v0.1.0+build1'), null)
  assert.equal(versionFromTag('v01.1.0'), null)
  assert.equal(versionFromTag('release-0.1.0'), null)
  assert.equal(versionFromTag('0.1.0'), null)
  assert.equal(versionFromTag(''), null)
})

test('version comparison orders by numeric component, not lexically', () => {
  assert.ok(compareVersions('0.2.0', '0.10.0') < 0, '0.2.0 must sort before 0.10.0')
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(codeOf(() => compareVersions('0.1', '0.1.0')), 'invalid_version')
})

// ---- release 说明文本 ----

test('release notes are stripped of control characters and capped', () => {
  // release body 是仓库侧可控的任意字符串。退格/回车能用来在界面上伪造别的文字。
  assert.equal(sanitizeReleaseNotes('a\u0008b'), 'ab')
  // 换行和制表符要留着——它们是正常排版
  assert.equal(sanitizeReleaseNotes('a\tb'), 'a\tb')
  assert.equal(sanitizeReleaseNotes('line1\r\nline2'), 'line1\nline2')
  assert.equal(sanitizeReleaseNotes('  padded  '), 'padded')
  assert.equal(sanitizeReleaseNotes(undefined), '')
  assert.equal(sanitizeReleaseNotes({ evil: true }), '')
  const long = sanitizeReleaseNotes('x'.repeat(10_000))
  assert.ok(long.length < 10_000, 'an overlong body must be truncated')
})

// ---- 资产挑选 ----

function asset(name, extra = {}) {
  return { name, size: 1024, browser_download_url: `https://github.com/o/r/releases/download/v1.0.0/${name}`, sha256: null, ...extra }
}

test('each flavor picks its own build out of a release that carries both', () => {
  // 一个 release 里两个 exe：免安装版和安装包。挑错的后果不是"装不上"，而是
  // 把一个装好的应用替换成游离 exe（或反过来），而且全程看起来是成功的。
  const both = {
    assets: [asset('Tessera.exe'), asset('Tessera Setup.exe')],
  }
  assert.equal(selectUpdateAsset(both, 'portable').name, 'Tessera.exe')
  assert.equal(selectUpdateAsset(both, 'installer').name, 'Tessera Setup.exe')
})

test('flavor matching is case-insensitive on the Setup marker', () => {
  // 大小写靠约定维持不住——artifactName 是人写的，迟早有人写成 setup。
  const both = { assets: [asset('App.exe'), asset('App setup.exe')] }
  assert.equal(selectUpdateAsset(both, 'installer').name, 'App setup.exe')
  assert.equal(selectUpdateAsset(both, 'portable').name, 'App.exe')
})

test('a missing flavor is an error, never a fallback to the other one', () => {
  // 安装版拿不到 Setup 包时**绝不**退回去下免安装版：那会把一个装好的应用换成
  // 一个游离 exe，注册表项还在、快捷方式指向不存在的路径、卸载功能从此失效。
  const portableOnly = { assets: [asset('Tessera.exe')] }
  assert.equal(codeOf(() => selectUpdateAsset(portableOnly, 'installer')), 'missing_asset')

  const installerOnly = { assets: [asset('Tessera Setup.exe')] }
  assert.equal(codeOf(() => selectUpdateAsset(installerOnly, 'portable')), 'missing_asset')
})

test('no exe at all is an error rather than "no update"', () => {
  assert.equal(codeOf(() => selectUpdateAsset({ assets: [asset('README.md')] }, 'portable')), 'missing_asset')
})

test('two builds of the same flavor are rejected rather than guessed between', () => {
  // 手滑把上个版本也传上去是很常见的失误。随便挑一个意味着可能悄悄给用户装了
  // 个旧版本，而且表现得完全正常。
  const dupes = { assets: [asset('App.exe'), asset('App-old.exe')] }
  assert.equal(codeOf(() => selectUpdateAsset(dupes, 'portable')), 'ambiguous_asset')

  const dupeSetups = { assets: [asset('App Setup.exe'), asset('App Setup old.exe')] }
  assert.equal(codeOf(() => selectUpdateAsset(dupeSetups, 'installer')), 'ambiguous_asset')
})

test('asset digests are parsed only in the exact sha256:<hex> form', () => {
  assert.equal(parseDigest(`sha256:${'a'.repeat(64)}`), 'a'.repeat(64))
  assert.equal(parseDigest(`SHA256:${'A'.repeat(64)}`), 'a'.repeat(64))
  assert.equal(parseDigest(`sha256:${'a'.repeat(63)}`), null)
  assert.equal(parseDigest(`md5:${'a'.repeat(32)}`), null)
  assert.equal(parseDigest(undefined), null)
})

// ---- 签名者判定：整套机制的信任根 ----

test('a self-signed build accepts an untrusted chain when the pinned key matches', () => {
  // 这是自签名模式的**正常路径**：Windows 报"根不受信"是预期结果，不是错误。
  // 不同 Windows 版本对这件事报 UnknownError 或 NotTrusted 都有，两个都要收。
  for (const status of ['UnknownError', 'NotTrusted', 'Valid']) {
    assert.doesNotThrow(() => assertTrustedSigner(selfSignedSignature({ status }), SELF_SIGNED))
  }
})

test('a self-signed build rejects a different key even when everything else matches', () => {
  // 攻击者完全可以自己造一张 CN 一模一样的自签名证书——主体名是随便填的，没有
  // 任何人审核。所以自签名模式下真正拦住他的是公钥，不是名字。
  assert.equal(
    codeOf(() => assertTrustedSigner(selfSignedSignature({ publicKeySha256: 'd'.repeat(64) }), SELF_SIGNED)),
    'untrusted_certificate',
  )
  assert.equal(
    codeOf(() => assertTrustedSigner(selfSignedSignature({ publicKeySha256: null }), SELF_SIGNED)),
    'untrusted_certificate',
  )
})

test('key comparison is case-insensitive hex but exact', () => {
  assert.doesNotThrow(() =>
    assertTrustedSigner(selfSignedSignature({ publicKeySha256: PINNED_KEY.toUpperCase() }), SELF_SIGNED),
  )
  // 少一位、多一位都不行——绝不做前缀匹配
  assert.equal(
    codeOf(() => assertTrustedSigner(selfSignedSignature({ publicKeySha256: PINNED_KEY.slice(0, 63) }), SELF_SIGNED)),
    'untrusted_certificate',
  )
})

test('a self-signed build does not require a timestamp', () => {
  // 自签名证书的有效期是我们自己定的（脚本默认 20 年），不存在"证书到期把历史
  // 版本全废掉"的问题，所以不强制副署。
  assert.doesNotThrow(() => assertTrustedSigner(selfSignedSignature({ timestamped: false }), SELF_SIGNED))
})

test('a tampered file is rejected in both modes, chain trust notwithstanding', () => {
  // HashMismatch：WinVerifyTrust 先算摘要再走证书链，自签名也能拿到该状态；自签名模式“接受链错误”依赖这个顺序。
  for (const [policy, sig] of [[SELF_SIGNED, selfSignedSignature], [CA_ISSUED, caSignature]]) {
    for (const status of ['NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible', '']) {
      assert.equal(
        codeOf(() => assertTrustedSigner(sig({ status }), policy)),
        'bad_signature',
        `status "${status}" must be rejected`,
      )
    }
  }
})

test('publisher comparison is case-insensitive but never partial', () => {
  // X.500 名字比较本身不区分大小写
  assert.doesNotThrow(() => assertTrustedSigner(selfSignedSignature({ simpleName: 'IDEAL1 SOFTWARE' }), SELF_SIGNED))

  // 前缀/包含匹配会被"Ideal1 Software Evil Ltd"这种名字直接绕过。必须精确相等。
  for (const impostor of [`${PUBLISHER} Evil Ltd`, `Not ${PUBLISHER}`, 'Ideal1  Software']) {
    assert.equal(
      codeOf(() => assertTrustedSigner(selfSignedSignature({ simpleName: impostor }), SELF_SIGNED)),
      'untrusted_publisher',
      `"${impostor}" must not pass as "${PUBLISHER}"`,
    )
  }
})

test('an unreadable publisher name is rejected rather than treated as empty-matches-empty', () => {
  assert.equal(
    codeOf(() => assertTrustedSigner(selfSignedSignature({ simpleName: null }), SELF_SIGNED)),
    'untrusted_publisher',
  )
  assert.equal(
    codeOf(() => assertTrustedSigner(selfSignedSignature({ simpleName: '   ' }), SELF_SIGNED)),
    'untrusted_publisher',
  )
})

test('a CA-mode build still demands a valid chain and a timestamp', () => {
  assert.doesNotThrow(() => assertTrustedSigner(caSignature(), CA_ISSUED))

  // 没钉公钥时，"链不可信"就没有任何东西能兜底了，必须拒绝——这正是自签名模式
  // 非要钉公钥不可的原因。
  assert.equal(codeOf(() => assertTrustedSigner(caSignature({ status: 'UnknownError' }), CA_ISSUED)), 'bad_signature')
  assert.equal(codeOf(() => assertTrustedSigner(caSignature({ status: 'NotTrusted' }), CA_ISSUED)), 'bad_signature')
  // 没有副署的 CA 签名会随证书到期而集体失效，属于必然发生的定时炸弹
  assert.equal(codeOf(() => assertTrustedSigner(caSignature({ timestamped: false }), CA_ISSUED)), 'not_timestamped')
})

test('a build with no configured publisher refuses everything', () => {
  // 「没配就放行」是这类机制最常见的致命默认值。空发布者必须让每一次验证都失败，
  // 哪怕签名本身完全有效、公钥也对得上。
  for (const publisher of ['', '   ']) {
    assert.equal(
      codeOf(() => assertTrustedSigner(selfSignedSignature(), { publisher, publicKeySha256: PINNED_KEY })),
      'no_trusted_publisher',
    )
    assert.equal(codeOf(() => assertTrustedSigner(caSignature(), { publisher, publicKeySha256: '' })), 'no_trusted_publisher')
  }
})

// 更新只替换一个文件且不可逆，挑错就覆盖不该覆盖的，所以守优先级和“绝不瞎猜”。

test('the portable launcher wins over the remembered path', () => {
  // 同一次运行里两者通常一致，但用户把 exe 挪过位置之后，环境变量反映的是**这次
  // 实际启动的位置**，记忆反映的是上一次——后者已经过时了。
  const chosen = chooseUpdateTarget({ portable: 'D:\\Apps\\app.exe', remembered: 'C:\\Old\\app.exe' })
  assert.deepEqual(chosen, { path: 'D:\\Apps\\app.exe', source: 'portable' })
})

test('the remembered path is used only as a fallback, and is flagged as such', () => {
  // source 必须传出去：记忆是从一个当前用户可写的文件里读的，调用方要靠这个
  // 标记决定"覆盖它之前先验一次签名"。
  const chosen = chooseUpdateTarget({ portable: null, remembered: 'C:\\Old\\app.exe' })
  assert.deepEqual(chosen, { path: 'C:\\Old\\app.exe', source: 'remembered' })
})

test('with no candidate at all it refuses rather than guessing', () => {
  // 猜一个路径然后往上面写，是这段代码能犯的最严重的错误。
  assert.equal(chooseUpdateTarget({}), null)
  assert.equal(chooseUpdateTarget({ portable: null, remembered: null }), null)
  assert.equal(chooseUpdateTarget({ portable: '   ', remembered: '' }), null)
})

test('the space requirement covers new + preserved old + the moment both exist', () => {
  const asset = 145 * 1024 * 1024
  const needed = requiredFreeBytes(asset)
  // 光够放一个包是不够的：替换过程中磁盘上会同时有新包、被保留的 .previous、
  // 以及替换那一瞬间的两份。
  assert.ok(needed > asset * 2, 'must ask for more than twice the asset size')
  assert.ok(needed < asset * 4, 'but not so much that a normal disk fails the check')
})
