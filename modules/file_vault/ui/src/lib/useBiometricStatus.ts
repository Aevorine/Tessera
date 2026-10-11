import { useEffect, useState } from 'react'
import { vaultApi } from '@/lib/vaultApi'
import type { BiometricModality } from '@/shared/ipcTypes'

/** 后端 `biometric_status` 的返回。`chain` 已按 人脸 → 指纹 → 虹膜 排好序，
 *  前端不再重排一遍——排序规则只应该有一处。 */
export interface BiometricStatus {
  available: boolean
  chain: BiometricModality[]
  preferred: BiometricModality | null
  bound: boolean
}

const NONE: BiometricStatus = { available: false, chain: [], preferred: null, bound: false }
const STORAGE_KEY = 'tessera.biometricStatus'
const MODALITIES: readonly BiometricModality[] = ['face', 'fingerprint', 'iris']

function parseStored(raw: string | null): BiometricStatus | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<BiometricStatus>
    const chain = Array.isArray(v.chain) ? v.chain.filter((m): m is BiometricModality => MODALITIES.includes(m)) : []
    return {
      available: v.available === true,
      chain,
      preferred: chain[0] ?? null,
      bound: v.bound === true,
    }
  } catch {
    return null
  }
}

function readStored(): BiometricStatus | null {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY))
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

/**
 * 本次会话最新的答案与上次会话留下的答案，模块级缓存。
 * 登录页每次锁定都重新挂载，先用缓存直接发起验证，后端答案回来再校正；缓存错了验证会报「不可用」并降到密码。
 */
let sessionStatus: BiometricStatus | null = null
let inflight: Promise<BiometricStatus> | null = null
const listeners = new Set<(status: BiometricStatus) => void>()

function fetchStatus(): Promise<BiometricStatus> {
  if (inflight) return inflight
  inflight = vaultApi
    .call('biometric_status', {})
    .then((res) =>
      res.ok
        ? {
            available: Boolean(res.available),
            chain: (res.chain ?? []) as BiometricModality[],
            preferred: (res.preferred ?? null) as BiometricModality | null,
            bound: Boolean(res.bound),
          }
        : NONE,
    )
    .catch(() => NONE)
    .then((status) => {
      sessionStatus = status
      writeStored(status)
      inflight = null
      for (const listener of listeners) listener(status)
      return status
    })
  return inflight
}

/** 启动时就发出去，跟 identity_exists 并行，登录页挂载时答案多半已经在了。 */
export function primeBiometricStatus(): void {
  if (!sessionStatus) void fetchStatus()
}

/**
 * 这台机器可用的生物识别及金库是否已绑定。有缓存同步返回并后台刷新，都没有返回 null（探测中）。
 * 拉取失败返回「什么都没有」而不抛错，解锁页必须始终能渲染。
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
