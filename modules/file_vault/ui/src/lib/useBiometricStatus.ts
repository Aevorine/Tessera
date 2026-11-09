import { useEffect, useState } from 'react'
import { vaultApi } from '@/lib/vaultApi'
import type { BiometricModality } from '@/shared/ipcTypes'

export type SecretFactor = 'password' | 'totp' | 'email' | 'recovery'

/** 后端 `biometric_status` 的返回。`chain` 已按 人脸 → 指纹 → 虹膜 排好序，前端不重排。 */
export interface BiometricStatus {
  available: boolean
  chain: BiometricModality[]
  preferred: BiometricModality | null
  bound: boolean
  /** 金库配了哪些非生物识别因子 */
  factors: Record<SecretFactor, boolean>
  /** 这份答案是真探测结果；false = 后端没答上（重启中/超时），不能据此判"本机没有生物识别" */
  probed: boolean
}

const ALL_FACTORS: Record<SecretFactor, boolean> = { password: true, totp: true, email: true, recovery: true }
const UNKNOWN: BiometricStatus = {
  available: false,
  chain: [],
  preferred: null,
  bound: false,
  factors: ALL_FACTORS,
  probed: false,
}
const STORAGE_KEY = 'tessera.biometricStatus'
const MODALITIES: readonly BiometricModality[] = ['face', 'fingerprint', 'iris']
const RETRY_DELAYS_MS = [400, 1200, 3000, 6000]

function normalize(v: Partial<BiometricStatus> & { factors?: Partial<Record<SecretFactor, boolean>> }, probed: boolean): BiometricStatus {
  const chain = Array.isArray(v.chain) ? v.chain.filter((m): m is BiometricModality => MODALITIES.includes(m)) : []
  const factors = { ...ALL_FACTORS }
  for (const k of Object.keys(ALL_FACTORS) as SecretFactor[]) {
    if (typeof v.factors?.[k] === 'boolean') factors[k] = v.factors[k] as boolean
  }
  factors.password = true
  return { available: v.available === true, chain, preferred: chain[0] ?? null, bound: v.bound === true, factors, probed }
}

function readStored(): BiometricStatus | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? normalize(JSON.parse(raw), true) : null
  } catch {
    return null
  }
}

function writeStored(status: BiometricStatus) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(status))
  } catch {
    /* 记不住只是下次多等一次探测 */
  }
}

let sessionStatus: BiometricStatus | null = null
let inflight: Promise<BiometricStatus> | null = null
const listeners = new Set<(status: BiometricStatus) => void>()

async function probeOnce(refresh: boolean): Promise<BiometricStatus | null> {
  try {
    const res = await vaultApi.call('biometric_status', refresh ? { refresh: true } : {})
    return res.ok ? normalize(res as Partial<BiometricStatus>, true) : null
  } catch {
    return null
  }
}

function publish(status: BiometricStatus) {
  sessionStatus = status
  for (const listener of listeners) listener(status)
}

/** 探测失败不写缓存、不当成"没有生物识别"，退避重试；全失败才发一个 probed=false 的保守答案。 */
function fetchStatus(refresh = false): Promise<BiometricStatus> {
  if (inflight) return inflight
  inflight = (async () => {
    let status = await probeOnce(refresh)
    for (let i = 0; !status && i < RETRY_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]))
      status = await probeOnce(refresh)
    }
    const final = status ?? sessionStatus ?? readStored() ?? UNKNOWN
    if (status) writeStored(status)
    inflight = null
    publish(final)
    return final
  })()
  return inflight
}

/** 启动时就发出去，跟 identity_exists 并行。 */
export function primeBiometricStatus(): void {
  if (!sessionStatus) void fetchStatus()
}

/** 强制重新探测（插拔传感器、在设置里重绑之后）。 */
export function refreshBiometricStatus(): Promise<BiometricStatus> {
  return fetchStatus(true)
}


/**
 * 这台机器可用的生物识别、金库是否已绑定、配了哪些因子。有缓存同步返回并后台刷新，都没有返回 null（探测中）。
 */
export function useBiometricStatus(): BiometricStatus | null {
  const [status, setStatus] = useState<BiometricStatus | null>(() => sessionStatus ?? readStored())

  useEffect(() => {
    let cancelled = false
    const listener = (next: BiometricStatus) => {
      if (!cancelled) setStatus(next)
    }
    listeners.add(listener)
    void fetchStatus()
    return () => {
      cancelled = true
      listeners.delete(listener)
    }
  }, [])

  return status
}
