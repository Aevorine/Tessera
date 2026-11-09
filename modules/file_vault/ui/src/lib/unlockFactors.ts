import type { BiometricModality } from '../shared/ipcTypes'

/** 解锁因子。face/fingerprint/iris/biometric 都走同一个 Windows Hello（系统决定模态），分开只为按顺序与硬件显示。 */
export type UnlockFactor = BiometricModality | 'biometric' | 'password' | 'totp' | 'email' | 'recovery'

/** unlockFactorOrder 需要的最小状态（与 useBiometricStatus 的 BiometricStatus 兼容）。 */
export interface FactorProbe {
  available: boolean
  bound: boolean
  chain: BiometricModality[]
  factors?: Partial<Record<'password' | 'totp' | 'email' | 'recovery', boolean>>
}

const BIOMETRIC_FACTORS = new Set<UnlockFactor>(['face', 'fingerprint', 'iris', 'biometric'])
export const isBiometricFactor = (f: UnlockFactor): boolean => BIOMETRIC_FACTORS.has(f)

/**
 * 本机本金库的解锁顺序：人脸 → 指纹 → 虹膜 → 密码 → 验证器 → 邮箱 → 恢复密钥。
 * 与设备不匹配（无该传感器 / Hello 未配置 / 金库未绑定）或金库没配置的因子不出现。
 * Hello 可用且已绑定但枚举不出传感器类型时给一个中性的 Windows Hello 档。
 */
export function unlockFactorOrder(status: FactorProbe | null): UnlockFactor[] {
  const usable = Boolean(status?.available && status.bound)
  const bio: UnlockFactor[] = usable ? (status!.chain.length ? [...status!.chain] : ['biometric']) : []
  const f = status?.factors
  const rest: UnlockFactor[] = ['password']
  if (f?.totp !== false) rest.push('totp')
  if (f?.email !== false) rest.push('email')
  if (f?.recovery !== false) rest.push('recovery')
  return [...bio, ...rest]
}
