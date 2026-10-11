// 密码生成器
// 内置是因为：只指出密码弱却不给解法，会把用户推去陌生在线生成器，明文经过陌生网站和剪贴板，
// 违背"密钥不出设备"。
// 随机数用 `crypto.getRandomValues`，不用 `Math.random`（V8 的 xorshift128+，状态可反推）：
// 熵公式 log₂N 假设每位等概率独立，后者不保证，算出的熵就是假的。

/** 各字符类。O/0 与 l/1/I 这类易混字符单独拎出来，方便"排除易混"那个开关。 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const LOWER_AMBIGUOUS = 'l'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const UPPER_AMBIGUOUS = 'IO'
const DIGITS = '23456789'
const DIGITS_AMBIGUOUS = '01'
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?/~'

export interface GeneratorOptions {
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
  /** 去掉 0/O/1/l/I 这几个在很多字体里分不清的字符。 */
  excludeAmbiguous: boolean
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: true,
}

export const GENERATOR_MIN_LENGTH = 8
export const GENERATOR_MAX_LENGTH = 64

/** 按当前开关拼出实际可用的字符表。 */
export function generatorAlphabet(options: GeneratorOptions): string {
  let out = ''
  if (options.lower) out += LOWER + (options.excludeAmbiguous ? '' : LOWER_AMBIGUOUS)
  if (options.upper) out += UPPER + (options.excludeAmbiguous ? '' : UPPER_AMBIGUOUS)
  if (options.digits) out += DIGITS + (options.excludeAmbiguous ? '' : DIGITS_AMBIGUOUS)
  if (options.symbols) out += SYMBOLS
  return out
}

/**
 * 从 [0, max) 取无偏随机整数。`value % max` 有偏（max 不整除 2³² 时前几个余数多出现一次），
 * 会降低界面上显示的熵；用拒绝采样：丢弃落在多出来那截尾巴的值并重抽。
 */
function unbiasedRandomInt(max: number): number {
  const limit = Math.floor(0xffffffff / max) * max
  const buf = new Uint32Array(1)
  let value: number
  do {
    crypto.getRandomValues(buf)
    value = buf[0]
  } while (value >= limit)
  return value % max
}

/**
 * 生成密码：每个勾选的字符类至少出现一次，剩余位自由填充，最后整体洗牌。
 * 否则"长度 12、四类全开"可能抽不出符号而被网站规则拒绝；洗牌用无偏的 Fisher–Yates，
 * 不洗则开头固定为 小写→大写→数字→符号，是可被利用的结构。
 */
export function generatePassword(options: GeneratorOptions): string {
  const alphabet = generatorAlphabet(options)
  if (alphabet.length === 0) return ''
  const length = Math.max(GENERATOR_MIN_LENGTH, Math.min(GENERATOR_MAX_LENGTH, options.length))

  const required: string[] = []
  const pools: string[] = []
  if (options.lower) pools.push(LOWER + (options.excludeAmbiguous ? '' : LOWER_AMBIGUOUS))
  if (options.upper) pools.push(UPPER + (options.excludeAmbiguous ? '' : UPPER_AMBIGUOUS))
  if (options.digits) pools.push(DIGITS + (options.excludeAmbiguous ? '' : DIGITS_AMBIGUOUS))
  if (options.symbols) pools.push(SYMBOLS)
  for (const pool of pools) {
    if (required.length >= length) break
    required.push(pool[unbiasedRandomInt(pool.length)])
  }

  const chars = [...required]
  while (chars.length < length) chars.push(alphabet[unbiasedRandomInt(alphabet.length)])

  for (let i = chars.length - 1; i > 0; i--) {
    const j = unbiasedRandomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/** 生成器理论上能产出的熵（比特）：我们确实从多大空间等概率抽取；与 `passwordEntropyBits`（观察字符串猜字符集）不同，生成时用这个才诚实。 */
export function generatorEntropyBits(options: GeneratorOptions): number {
  const alphabet = generatorAlphabet(options)
  if (alphabet.length === 0) return 0
  const length = Math.max(GENERATOR_MIN_LENGTH, Math.min(GENERATOR_MAX_LENGTH, options.length))
  return length * Math.log2(alphabet.length)
}
