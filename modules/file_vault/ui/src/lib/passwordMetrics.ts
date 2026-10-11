import type { PasswordEntry } from '@/shared/ipcTypes'
import type { Tone } from '@/components/ui/page'

// 密码指标：金库可度量的维度集中定义在此，一个指标是一条数据（名称、算法、点击筛出哪些条目、数学含义）。
// 加新维度 = 往下面的表里加一条，界面、筛选、选择器、持久化自动跟上。
// 计数型（有 match）可点击筛选；汇总型（有 summary，如"平均熵"）不对应某几条记录，不挂点击。
// 全部在本机计算：判"弱"用本地启发式加内置烂密码表，不查在线泄露库（要上传密码或其哈希前缀，违背"金库密文不出设备"红线）。

/** 一天有多少秒。陈旧度用得上，写成常量免得散落一堆 86400。 */
const DAY_SECONDS = 86_400

/** 「太久没换」的门槛。一年是各家密码管理器和企业策略最常见的取值。 */
export const STALE_DAYS = 365

/** 「太短」的门槛。12 位是当前 NIST 与主流实践对高价值账号的建议下限。 */
export const SHORT_LENGTH = 12

/** 「熵太低」的门槛，单位比特。60 bit 以下在离线快哈希场景下算不上安全。 */
export const LOW_ENTROPY_BITS = 60

/** 内置的小型烂密码表，只挡最无争议的几十个，不是泄露库（联网违背"密码不出设备"）；判"一眼就烂"，与熵（穷举代价）互补。 */
const COMMON_WEAK_PASSWORDS = new Set([
  '123456', '123456789', 'password', 'qwerty', '111111', '12345678',
  'abc123', '1234567', 'password1', '123123', 'admin', 'letmein', '000000',
  'iloveyou', 'qwerty123', '1q2w3e4r', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'welcome', 'login', 'passw0rd', 'starwars',
  'master', 'hello', 'freedom', 'whatever', 'trustno1', 'zaq12wsx',
  'qazwsx', 'asdfgh', 'zxcvbnm', '654321', '666666', '888888', '123321',
])

export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong'

// 记忆化：强度和熵是纯函数，却被反复调用（每行渲染 × 20 多个指标 × 健康指数再扫 5 遍 × 排序筛选分组），
// 500 条密码 + 25 个指标一次重渲染就是上万次正则。缓存键是密码原文，命中率近 100%；
// 上限 4096 条，满了整批清空而非 LRU（访问模式是同批键反复命中，摊销成本可忽略）。
const MEMO_LIMIT = 4096

function memoize1<T>(fn: (pw: string) => T): (pw: string) => T {
  const cache = new Map<string, T>()
  return (pw: string): T => {
    const hit = cache.get(pw)
    if (hit !== undefined || cache.has(pw)) return hit as T
    const value = fn(pw)
    if (cache.size >= MEMO_LIMIT) cache.clear()
    cache.set(pw, value)
    return value
  }
}

const computeStrengthUncached = (pw: string): PasswordStrength | null => {
  if (!pw) return null
  if (COMMON_WEAK_PASSWORDS.has(pw.toLowerCase())) return 'weak'
  let variety = 0
  if (/[a-z]/.test(pw)) variety++
  if (/[A-Z]/.test(pw)) variety++
  if (/[0-9]/.test(pw)) variety++
  if (/[^a-zA-Z0-9]/.test(pw)) variety++
  if (pw.length < 8 || variety <= 1) return 'weak'
  const lengthScore = pw.length >= 16 ? 2 : pw.length >= 12 ? 1 : 0
  const score = lengthScore + (variety >= 3 ? 1 : 0)
  if (score <= 0) return 'fair'
  if (score === 1) return 'good'
  return 'strong'
}

export const computePasswordStrength = memoize1(computeStrengthUncached)

/** 各类字符贡献的字符集大小，即攻击者穷举时每位的可能数；33 为 ASCII 32–126 中去掉字母数字后的可打印符号数。 */
const CHARSET_SIZES: readonly (readonly [RegExp, number])[] = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9]/, 33],
]

/**
 * 口令熵（比特），H = L · log₂N。比"强/中/弱"多显示一个数：四档会跳变，熵连续，用户能看出自己改动的价值。
 * 只衡量穷举代价，不判是否在泄露库中，那由 COMMON_WEAK_PASSWORDS 单独判（`Tr0ub4dor&3` 熵不低但在字典里）。
 */
export const passwordEntropyBits = memoize1((pw: string): number | null => {
  if (!pw) return null
  let alphabet = 0
  for (const [re, size] of CHARSET_SIZES) if (re.test(pw)) alphabet += size
  if (alphabet === 0) return null
  return pw.length * Math.log2(alphabet)
})

// 结构性弱点：熵看不见的那一类

/** 常见键盘行。判"连续键"用，顺序敲出来的四个键跟随机四个字符不是一回事。 */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']

/**
 * 是否含「顺着来」的序列：连续 4 个递增/递减字符（abcd、4321）、键盘相邻键（qwer）或相同字符（aaaa）。
 * 不能靠熵代替：`abcd1234` 熵约 41 bit，但在字典攻击规则里排前几百，实际强度近零；熵默认攻击者不知道构造方式。
 */
export const hasSequentialRun = memoize1((pw: string): boolean => {
  if (pw.length < 4) return false
  const lower = pw.toLowerCase()
  for (let i = 0; i + 3 < lower.length; i++) {
    const a = lower.charCodeAt(i)
    const b = lower.charCodeAt(i + 1)
    const c = lower.charCodeAt(i + 2)
    const d = lower.charCodeAt(i + 3)
    // 递增 / 递减 / 全等，三种都算。
    if (b - a === 1 && c - b === 1 && d - c === 1) return true
    if (a - b === 1 && b - c === 1 && c - d === 1) return true
    if (a === b && b === c && c === d) return true
  }
  for (const row of KEYBOARD_ROWS) {
    for (let i = 0; i + 3 < row.length; i++) {
      const run = row.slice(i, i + 4)
      if (lower.includes(run)) return true
      if (lower.includes([...run].reverse().join(''))) return true
    }
  }
  return false
})

/** 邮箱取 @ 前那一半、其余原样。用来判"密码里有没有写着自己是谁"。 */
function identityTokens(name: string, username: string): string[] {
  const local = username.includes('@') ? username.slice(0, username.indexOf('@')) : username
  return [name, local]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 4)
}

/** 密码是否含账号名或站点名；4 字符起判，更短的巧合太多，假警报多了没人看指标。 */
export function containsIdentity(entry: { name: string; username: string; password: string }): boolean {
  if (!entry.password) return false
  const pw = entry.password.toLowerCase()
  return identityTokens(entry.name, entry.username).some((token) => pw.includes(token))
}

// 破解时间

/**
 * 攻击者模型：同一密码在四种场景下安全边际差十个数量级，必须说明前提。
 * 取值是公开的量级共识（Hashcat 实测榜 + OWASP 存储备忘单），用于判断属于哪一档，不是精确值。
 */
export type AttackerModel = 'onlineThrottled' | 'onlineFast' | 'offlineSlowHash' | 'offlineFastHash'

/** 每秒尝试次数 R。 */
export const ATTACKER_RATES: Record<AttackerModel, number> = {
  /** 有登录失败限速的正常网站。 */
  onlineThrottled: 10,
  /** 没做限速、或者攻击者绕过了限速的接口。 */
  onlineFast: 1_000,
  /** 数据库被拖走，但对方用的是 bcrypt/argon2 这类慢哈希。 */
  offlineSlowHash: 10_000,
  /** 数据库被拖走，且存的是 MD5/SHA-1 这类快哈希，攻击者有一柜子显卡。 */
  offlineFastHash: 100_000_000_000,
}

export const ATTACKER_MODELS: readonly AttackerModel[] = [
  'onlineThrottled',
  'onlineFast',
  'offlineSlowHash',
  'offlineFastHash',
]

/** 期望破解时间（秒），t = 2^H / (2R)；除以 2 因为期望只需搜完一半空间，且要与展示给用户的式子一致。 */
export function crackSeconds(bits: number, rate: number): number {
  return Math.pow(2, bits) / (2 * rate)
}

export type CrackUnit = 'instant' | 'seconds' | 'minutes' | 'hours' | 'days' | 'years' | 'eons'

/**
 * 把秒数折成「数 + 单位」交调用方翻译：单位进六份翻译文件，复数规则各语言不同（俄语三档），不能在这里拼字符串。
 * 上限 `eons`：超过百万年后差异对决策无意义，长数字反而读不出"已安全"。
 */
export function crackTimeParts(seconds: number): { n: number; unit: CrackUnit } {
  if (!Number.isFinite(seconds) || seconds > 1e6 * 3.15e7) return { n: 0, unit: 'eons' }
  if (seconds < 1) return { n: 0, unit: 'instant' }
  if (seconds < 60) return { n: Math.round(seconds), unit: 'seconds' }
  if (seconds < 3600) return { n: Math.round(seconds / 60), unit: 'minutes' }
  if (seconds < DAY_SECONDS) return { n: Math.round(seconds / 3600), unit: 'hours' }
  if (seconds < 365 * DAY_SECONDS) return { n: Math.round(seconds / DAY_SECONDS), unit: 'days' }
  return { n: Math.round(seconds / (365 * DAY_SECONDS)), unit: 'years' }
}

// 指标表

/** 算一批指标共用的中间结果：「哪些密码被重复用」要全表扫描，reused 指标、健康指数、爆炸半径三处共用，各算各的会出现"数字 3 条、筛出 2 条"。 */
export interface MetricContext {
  /** 被用在不止一个账号上的那些密码字符串。 */
  reusedPasswords: Set<string>
  /** 被用在不止一个站点上的那些账号名。 */
  reusedUsernames: Set<string>
  /** 当前时刻（秒）。传进来而不是在里面取，测试才能定住时间。 */
  nowSeconds: number
}

export function buildMetricContext(entries: PasswordEntry[], nowSeconds: number): MetricContext {
  // 一趟扫完两张计数表。分两趟写起来短一点，但这个函数在每次列表变化时都跑，
  // 而它是少数几个真的跟条目数成正比的地方之一。
  const pwCount = new Map<string, number>()
  const userCount = new Map<string, number>()
  for (const e of entries) {
    if (e.password) pwCount.set(e.password, (pwCount.get(e.password) ?? 0) + 1)
    const u = e.username.trim().toLowerCase()
    if (u) userCount.set(u, (userCount.get(u) ?? 0) + 1)
  }
  const overOne = (m: Map<string, number>) => new Set([...m].filter(([, n]) => n > 1).map(([k]) => k))
  return {
    reusedPasswords: overOne(pwCount),
    reusedUsernames: overOne(userCount),
    nowSeconds,
  }
}

export type MetricId =
  | 'health'
  | 'total'
  | 'weak'
  | 'reused'
  | 'short'
  | 'stale'
  | 'lowEntropy'
  | 'crackable'
  | 'noSymbol'
  | 'noDigit'
  | 'noUsername'
  | 'insecureUrl'
  | 'fair'
  | 'good'
  | 'strong'
  | 'avgEntropy'
  | 'minEntropy'
  | 'uniqueRatio'
  // —— 0.1.18 新增的十个 ——
  | 'sequential'
  | 'identityLeak'
  | 'singleCase'
  | 'veryStale'
  | 'freshlyChanged'
  | 'sharedUsername'
  | 'noUrl'
  | 'medianEntropy'
  | 'weakestCrackTime'
  | 'atRiskShare'

export interface PasswordMetricDef {
  id: MetricId
  /** `passwords` 命名空间里的翻译键。 */
  labelKey: string
  hintKey: string
  tone: Tone
  /** 计数型指标：哪些条目算命中；有它就能点击筛列表，与 `summary` 二选一。 */
  match?: (entry: PasswordEntry, ctx: MetricContext) => boolean
  /** 汇总型指标：直接算出要显示的东西。跟 `match` 二选一。 */
  summary?: (entries: PasswordEntry[], ctx: MetricContext) => string
  /** 这个指标背后的式子（KaTeX 源码）。有就在指标选择器里显示。 */
  formula?: string
  /** 数字越大越糟？决定磁贴语气色（`weak: 3` 红、`strong: 3` 不红）；汇总型指标不看。 */
  higherIsWorse?: boolean
}

/** 健康指数各分项的权重。见 healthIndex() 的注释。 */
const HEALTH_WEIGHTS: readonly (readonly [MetricId, number])[] = [
  ['weak', 0.3],
  ['reused', 0.25],
  ['lowEntropy', 0.2],
  ['short', 0.15],
  ['stale', 0.1],
  // 0.1.18 起把两个结构性弱点计入：把自己名字写进去或 `qwer1234` 这类密码熵可能不低、
  // 上面五项都不触发，实际强度却近零，不计入会使健康指数偏高。分母是 Σw，旧五项相对权重不变。
  ['sequential', 0.08],
  ['identityLeak', 0.05],
]

/**
 * 金库健康指数 0–100，把"总数/弱/重复"几个互不相关的数合成一个判断，权重由软件定。
 * 每项合格率 s = 1 − 命中数/总数，Score = 100 × (Σ wᵢsᵢ) / (Σ wᵢ)；
 * 权重按出事后果排：弱密码 > 重复使用 > 熵低 > 长度/陈旧度（提示性），可争议但必须有一套写下来的。
 * 空金库返回 100 而非 0：没有密码时说卫生有问题是假的。
 */
export function healthIndex(entries: PasswordEntry[], ctx: MetricContext): number {
  if (entries.length === 0) return 100
  let weighted = 0
  let totalWeight = 0
  for (const [id, w] of HEALTH_WEIGHTS) {
    const def = METRIC_BY_ID[id]
    if (!def?.match) continue
    const hit = entries.filter((e) => def.match!(e, ctx)).length
    weighted += w * (1 - hit / entries.length)
    totalWeight += w
  }
  if (totalWeight === 0) return 100
  return Math.round((100 * weighted) / totalWeight)
}

/** 陈旧：距离上次更新超过 STALE_DAYS 天。 */
function isStale(entry: PasswordEntry, ctx: MetricContext): boolean {
  return ctx.nowSeconds - entry.updated_at > STALE_DAYS * DAY_SECONDS
}

/** 全部指标；加新维度只需往这张表加一条。顺序即选择器里的显示顺序：整体、计数型、汇总型。 */
export const PASSWORD_METRICS: readonly PasswordMetricDef[] = [
  {
    id: 'health',
    labelKey: 'metricHealthLabel',
    hintKey: 'metricHealthHint',
    tone: 'accent',
    summary: (entries, ctx) => String(healthIndex(entries, ctx)),
    formula: '\\mathrm{Score} = 100 \\times \\frac{\\sum_i w_i s_i}{\\sum_i w_i}',
  },
  {
    id: 'total',
    labelKey: 'metricTotalLabel',
    hintKey: 'metricTotalHint',
    tone: 'neutral',
    match: () => true,
  },
  {
    id: 'weak',
    labelKey: 'metricWeakLabel',
    hintKey: 'metricWeakHint',
    tone: 'danger',
    higherIsWorse: true,
    match: (e) => computePasswordStrength(e.password) === 'weak',
  },
  {
    id: 'reused',
    labelKey: 'metricReusedLabel',
    hintKey: 'metricReusedHint',
    tone: 'warning',
    higherIsWorse: true,
    match: (e, ctx) => Boolean(e.password) && ctx.reusedPasswords.has(e.password),
  },
  {
    id: 'short',
    labelKey: 'metricShortLabel',
    hintKey: 'metricShortHint',
    tone: 'warning',
    higherIsWorse: true,
    match: (e) => Boolean(e.password) && e.password.length < SHORT_LENGTH,
  },
  {
    id: 'stale',
    labelKey: 'metricStaleLabel',
    hintKey: 'metricStaleHint',
    tone: 'info',
    higherIsWorse: true,
    match: isStale,
  },
  {
    id: 'lowEntropy',
    labelKey: 'metricLowEntropyLabel',
    hintKey: 'metricLowEntropyHint',
    tone: 'warning',
    higherIsWorse: true,
    formula: 'H = L \\cdot \\log_2 N < 60',
    match: (e) => {
      const bits = passwordEntropyBits(e.password)
      return bits !== null && bits < LOW_ENTROPY_BITS
    },
  },
  {
    id: 'crackable',
    labelKey: 'metricCrackableLabel',
    hintKey: 'metricCrackableHint',
    tone: 'danger',
    higherIsWorse: true,
    formula: 't = \\frac{2^{H}}{2R} < 24\\,\\mathrm{h}',
    match: (e) => {
      const bits = passwordEntropyBits(e.password)
      if (bits === null) return true
      return crackSeconds(bits, ATTACKER_RATES.offlineFastHash) < DAY_SECONDS
    },
  },
  {
    id: 'noSymbol',
    labelKey: 'metricNoSymbolLabel',
    hintKey: 'metricNoSymbolHint',
    tone: 'neutral',
    higherIsWorse: true,
    match: (e) => Boolean(e.password) && !/[^a-zA-Z0-9]/.test(e.password),
  },
  {
    id: 'noDigit',
    labelKey: 'metricNoDigitLabel',
    hintKey: 'metricNoDigitHint',
    tone: 'neutral',
    higherIsWorse: true,
    match: (e) => Boolean(e.password) && !/[0-9]/.test(e.password),
  },
  {
    id: 'noUsername',
    labelKey: 'metricNoUsernameLabel',
    hintKey: 'metricNoUsernameHint',
    tone: 'neutral',
    higherIsWorse: true,
    match: (e) => e.username.trim() === '',
  },
  {
    id: 'insecureUrl',
    labelKey: 'metricInsecureUrlLabel',
    hintKey: 'metricInsecureUrlHint',
    tone: 'warning',
    higherIsWorse: true,
    // 只判明写了 http:// 的；不带协议的多半只是省略了前缀，判不安全会造成假警报。
    match: (e) => /^\s*http:\/\//i.test(e.url),
  },
  // fair / good / strong 三档的作用是让筛选下拉框完整覆盖四档强度，使强度筛选被指标体系吸收，
  // 界面只剩一个筛选入口，避免"同一件事两处各写各的"。
  {
    id: 'fair',
    labelKey: 'metricFairLabel',
    hintKey: 'metricFairHint',
    tone: 'warning',
    match: (e) => computePasswordStrength(e.password) === 'fair',
  },
  {
    id: 'good',
    labelKey: 'metricGoodLabel',
    hintKey: 'metricGoodHint',
    tone: 'info',
    match: (e) => computePasswordStrength(e.password) === 'good',
  },
  {
    id: 'strong',
    labelKey: 'metricStrongLabel',
    hintKey: 'metricStrongHint',
    tone: 'success',
    match: (e) => computePasswordStrength(e.password) === 'strong',
  },
  {
    id: 'avgEntropy',
    labelKey: 'metricAvgEntropyLabel',
    hintKey: 'metricAvgEntropyHint',
    tone: 'info',
    formula: '\\bar{H} = \\frac{1}{n}\\sum_{i=1}^{n} H_i',
    summary: (entries) => {
      const bits = entries.map((e) => passwordEntropyBits(e.password)).filter((b): b is number => b !== null)
      if (bits.length === 0) return '—'
      return (bits.reduce((a, b) => a + b, 0) / bits.length).toFixed(1)
    },
  },
  {
    id: 'minEntropy',
    labelKey: 'metricMinEntropyLabel',
    hintKey: 'metricMinEntropyHint',
    tone: 'warning',
    formula: 'H_{\\min} = \\min_i H_i',
    // 最弱的那一条决定了整个金库的下限——攻击者不会去打最难的那条。
    summary: (entries) => {
      const bits = entries.map((e) => passwordEntropyBits(e.password)).filter((b): b is number => b !== null)
      if (bits.length === 0) return '—'
      return Math.min(...bits).toFixed(1)
    },
  },
  {
    id: 'uniqueRatio',
    labelKey: 'metricUniqueRatioLabel',
    hintKey: 'metricUniqueRatioHint',
    tone: 'success',
    formula: 'U = \\frac{\\left|\\{p_i\\}\\right|}{n} \\times 100\\%',
    summary: (entries) => {
      const withPassword = entries.filter((e) => e.password)
      if (withPassword.length === 0) return '—'
      const unique = new Set(withPassword.map((e) => e.password)).size
      return `${Math.round((100 * unique) / withPassword.length)}%`
    },
  },

  // 结构性弱点：熵和四档强度看不见的那一类
  {
    id: 'sequential',
    labelKey: 'metricSequentialLabel',
    hintKey: 'metricSequentialHint',
    tone: 'danger',
    higherIsWorse: true,
    match: (e) => Boolean(e.password) && hasSequentialRun(e.password),
  },
  {
    id: 'identityLeak',
    labelKey: 'metricIdentityLeakLabel',
    hintKey: 'metricIdentityLeakHint',
    tone: 'danger',
    higherIsWorse: true,
    match: (e) => containsIdentity(e),
  },
  {
    id: 'singleCase',
    labelKey: 'metricSingleCaseLabel',
    hintKey: 'metricSingleCaseHint',
    tone: 'warning',
    higherIsWorse: true,
    // 只用一种字母大小写。混用大小写把字母表从 26 扩到 52，每一位多 1 bit——
    // 12 位的密码就是白送 12 bit，而代价只是按一次 Shift。
    match: (e) => Boolean(e.password) && !(/[a-z]/.test(e.password) && /[A-Z]/.test(e.password)),
  },
  {
    id: 'sharedUsername',
    labelKey: 'metricSharedUsernameLabel',
    hintKey: 'metricSharedUsernameHint',
    tone: 'info',
    higherIsWorse: true,
    // 与"密码重复"不同：同一邮箱注册多站点本身正常，但一处泄露账号名即可在别处撞库，
    // 是"撞库面积"而非错误，所以语气色用 info 而不是 warning。
    match: (e, ctx) => {
      const u = e.username.trim().toLowerCase()
      return u !== '' && ctx.reusedUsernames.has(u)
    },
  },
  {
    id: 'veryStale',
    labelKey: 'metricVeryStaleLabel',
    hintKey: 'metricVeryStaleHint',
    tone: 'warning',
    higherIsWorse: true,
    match: (e, ctx) => ctx.nowSeconds - e.updated_at > 2 * STALE_DAYS * DAY_SECONDS,
  },
  {
    id: 'freshlyChanged',
    labelKey: 'metricFreshlyChangedLabel',
    hintKey: 'metricFreshlyChangedHint',
    tone: 'success',
    // 唯一一个"越多越好"的计数型指标。它存在的理由是：整块指标区如果全是
    // 坏消息，用户改了一批密码之后看不到任何正反馈，下次就不改了。
    match: (e, ctx) => ctx.nowSeconds - e.updated_at <= 30 * DAY_SECONDS,
  },
  {
    id: 'noUrl',
    labelKey: 'metricNoUrlLabel',
    hintKey: 'metricNoUrlHint',
    tone: 'neutral',
    higherIsWorse: true,
    // 没记网址的条目在需要改密码时找不到门在哪儿——这是纯粹的可用性缺口，
    // 不是安全问题，所以语气色是中性的。
    match: (e) => e.url.trim() === '',
  },

  // 汇总量
  {
    id: 'medianEntropy',
    labelKey: 'metricMedianEntropyLabel',
    hintKey: 'metricMedianEntropyHint',
    tone: 'info',
    formula: '\\tilde{H} = \\mathrm{median}\\,(H_1,\\dots,H_n)',
    // 中位数比平均值更能代表"典型的那一条"：一条 120 bit 的随机长密码能把
    // 平均值拉高十几个比特，而金库里其余全是 40 bit 也照样好看。
    summary: (entries) => {
      const bits = entries
        .map((e) => passwordEntropyBits(e.password))
        .filter((b): b is number => b !== null)
        .sort((a, b) => a - b)
      if (bits.length === 0) return '—'
      const mid = bits.length >> 1
      const median = bits.length % 2 ? bits[mid] : (bits[mid - 1] + bits[mid]) / 2
      return median.toFixed(1)
    },
  },
  {
    id: 'weakestCrackTime',
    labelKey: 'metricWeakestCrackTimeLabel',
    hintKey: 'metricWeakestCrackTimeHint',
    tone: 'danger',
    formula: 't_{\\min} = \\frac{2^{H_{\\min}}}{2R}',
    // 金库真实下限：固定用最狠的攻击者（离线快哈希），是"最坏情况"读数；
    // 详情面板里可切换的模型回答的是另一个问题（这一条在某场景下够不够）。
    summary: (entries) => {
      const bits = entries
        .map((e) => passwordEntropyBits(e.password))
        .filter((b): b is number => b !== null)
      if (bits.length === 0) return '—'
      const { n, unit } = crackTimeParts(crackSeconds(Math.min(...bits), ATTACKER_RATES.offlineFastHash))
      return unit === 'instant' ? '<1s' : unit === 'eons' ? '∞' : `${n}${CRACK_UNIT_SUFFIX[unit]}`
    },
  },
  {
    id: 'atRiskShare',
    labelKey: 'metricAtRiskShareLabel',
    hintKey: 'metricAtRiskShareHint',
    tone: 'warning',
    formula: 'R = \\frac{\\left|\\{i : \\exists\\, m \\in M,\\ m(p_i)\\}\\right|}{n} \\times 100\\%',
    // "至少踩了一条红线"的占比。四个坏指标各自的数字加起来会重复计数
    // （一条又弱又重复的密码被数两次），这个数是**去重后**的实际受影响比例。
    summary: (entries, ctx) => {
      if (entries.length === 0) return '—'
      const risky: MetricId[] = ['weak', 'reused', 'short', 'lowEntropy', 'sequential', 'identityLeak']
      const hit = entries.filter((e) =>
        risky.some((id) => METRIC_BY_ID[id]?.match?.(e, ctx) === true),
      ).length
      return `${Math.round((100 * hit) / entries.length)}%`
    },
  },
]

/** 汇总型指标里要把破解时间压成一格磁贴时用的短单位。磁贴宽度只够放几个字符。 */
const CRACK_UNIT_SUFFIX: Record<Exclude<CrackUnit, 'instant' | 'eons'>, string> = {
  seconds: 's',
  minutes: 'm',
  hours: 'h',
  days: 'd',
  years: 'y',
}

export const METRIC_BY_ID: Record<MetricId, PasswordMetricDef> = Object.fromEntries(
  PASSWORD_METRICS.map((m) => [m.id, m]),
) as Record<MetricId, PasswordMetricDef>

/**
 * 默认显示四个：标题行是横带，五个以上会折行把列表往下推（"页面自己会动"曾被抱怨）。
 * 即一个总判断（健康指数）、一个规模（总数）、两个最要命的问题（弱、重复）；用户可自行增加。
 */
export const DEFAULT_VISIBLE_METRICS: readonly MetricId[] = ['health', 'total', 'weak', 'reused']

/** 标题行最多摆几个。超过就折行，见上面注释。 */
export const MAX_VISIBLE_METRICS = 6

const STORAGE_KEY = 'ideal1-password-metrics'

/** 读用户选过的指标；存的是 id 列表，须逐个验证仍认识，否则删除某指标后旧 localStorage 里的 id 会让 `METRIC_BY_ID[id]` 为 undefined 而白屏（开发机上没有旧数据，难查）。 */
export function loadVisibleMetrics(): MetricId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_VISIBLE_METRICS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_VISIBLE_METRICS]
    const valid = parsed.filter((id): id is MetricId => typeof id === 'string' && id in METRIC_BY_ID)
    return valid.length > 0 ? valid.slice(0, MAX_VISIBLE_METRICS) : [...DEFAULT_VISIBLE_METRICS]
  } catch {
    return [...DEFAULT_VISIBLE_METRICS]
  }
}

export function saveVisibleMetrics(ids: MetricId[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 记不住就算了，本次会话内仍然生效。隐私模式下 localStorage 会抛，
    // 而"指标选择记不住"绝不该演变成整页白屏。
  }
}

/** 一条密码的爆炸半径：同一密码串还用在哪些别的账号上，即这条泄露后还有谁遭殃、先改哪条。 */
export function blastRadius(entry: PasswordEntry, entries: PasswordEntry[]): PasswordEntry[] {
  if (!entry.password) return []
  return entries.filter((e) => e.id !== entry.id && e.password === entry.password)
}
