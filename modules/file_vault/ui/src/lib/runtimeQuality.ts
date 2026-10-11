type QualityTier = 'full' | 'balanced' | 'lean'

type SchedulingNavigator = Navigator & {
  deviceMemory?: number
  scheduling?: { isInputPending?: () => boolean }
}

const LONG_TASK_WINDOW_MS = 12_000
const DOWNGRADE_PRESSURE = 0.08
const UPGRADE_PRESSURE = 0.025
const EMA_WEIGHT = 0.24

function hardwareTier(): QualityTier {
  const runtime = navigator as SchedulingNavigator
  const cores = runtime.hardwareConcurrency || 4
  const memory = runtime.deviceMemory || 4
  if (cores <= 2 || memory <= 2) return 'lean'
  if (cores <= 4 || memory <= 4) return 'balanced'
  return 'full'
}

function applyTier(tier: QualityTier) {
  document.documentElement.dataset.quality = tier
}

export function installRuntimeQualityController(): () => void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const baseTier = reduceMotion.matches ? 'lean' : hardwareTier()
  let tier = baseTier
  let pressure = 0
  let busyTime = 0
  let windowStarted = performance.now()

  applyTier(tier)

  const update = () => {
    const now = performance.now()
    const elapsed = now - windowStarted
    if (elapsed < LONG_TASK_WINDOW_MS) return

    const sample = Math.min(1, busyTime / elapsed)
    pressure += EMA_WEIGHT * (sample - pressure)
    busyTime = 0
    windowStarted = now

    if (pressure >= DOWNGRADE_PRESSURE) tier = 'lean'
    else if (pressure <= UPGRADE_PRESSURE) tier = baseTier
    else if (baseTier === 'full') tier = 'balanced'
    applyTier(tier)
  }

  const observer = typeof PerformanceObserver === 'undefined'
    ? null
    : new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) busyTime += entry.duration
        update()
      })

  try {
    observer?.observe({ type: 'longtask', buffered: true })
  } catch {
    observer?.disconnect()
  }
  const sampler = window.setInterval(update, LONG_TASK_WINDOW_MS)

  const onVisibility = () => {
    document.documentElement.toggleAttribute('data-background', document.hidden)
    if (!document.hidden) {
      busyTime = 0
      windowStarted = performance.now()
    }
  }
  const onMotionChange = () => {
    tier = reduceMotion.matches ? 'lean' : hardwareTier()
    applyTier(tier)
  }

  onVisibility()
  document.addEventListener('visibilitychange', onVisibility)
  reduceMotion.addEventListener('change', onMotionChange)

  return () => {
    window.clearInterval(sampler)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    reduceMotion.removeEventListener('change', onMotionChange)
  }
}

export function scheduleIdleWork(work: () => void, timeout = 2_000): () => void {
  let cancelled = false
  const run = () => {
    if (cancelled) return
    const pending = (navigator as SchedulingNavigator).scheduling?.isInputPending?.() === true
    if (document.hidden || pending) {
      timer = window.setTimeout(run, 160)
      return
    }
    work()
  }

  let timer = 0
  if (typeof window.requestIdleCallback === 'function') {
    const idle = window.requestIdleCallback(run, { timeout })
    return () => {
      cancelled = true
      window.cancelIdleCallback(idle)
    }
  }

  timer = window.setTimeout(run, 240)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}
