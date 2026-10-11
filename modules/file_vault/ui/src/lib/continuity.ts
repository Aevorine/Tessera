/**
 * 「接着刚才」跨设备续做的界面侧；协议和状态在 Go（crossdevice/core/node/continuity.go），
 * 这里只负责播报本机活动（`publishActivity`）和订阅他机活动（`useContinuity`）。
 * 不自动跳转：跨设备 id 空间不通用，映射一旦错会带用户打开没要求的笔记；只承诺提示"那边还有事"。
 * 播报要节流：焦点变化高频，每次 IPC 都可能引发网络写；Go 侧去重发生在 IPC 之后，省 IPC 要在这层。
 */

import { useEffect, useState } from 'react'

export type ContinuityKind = 'none' | 'note' | 'transfer'

export interface ContinuityItem {
  device_id: string
  device_name: string
  kind: ContinuityKind
  title: string
  local_id: string
  /** 0-100；-1 表示未知（不该画进度条）。 */
  progress: number
  updated_at_ms: number
}

interface LocalActivity {
  kind: ContinuityKind
  title: string
  localId: string
  progress: number
}

const IDLE: LocalActivity = { kind: 'none', title: '', localId: '', progress: -1 }

let lastPublished: LocalActivity = IDLE

function sameActivity(a: LocalActivity, b: LocalActivity): boolean {
  return a.kind === b.kind && a.title === b.title && a.localId === b.localId && a.progress === b.progress
}

/** 播报"我现在正在做什么"，内容没变不发。守护进程没跑时调用会失败，属正常情况，静默吞掉。 */
export function publishActivity(activity: Partial<LocalActivity> & { kind: ContinuityKind }): void {
  const next: LocalActivity = {
    kind: activity.kind,
    title: activity.title ?? '',
    localId: activity.localId ?? '',
    progress: activity.progress ?? -1,
  }
  if (sameActivity(next, lastPublished)) return
  lastPublished = next
  void window.crossDeviceAPI
    ?.call('set_continuity', {
      kind: next.kind,
      title: next.title,
      local_id: next.localId,
      progress: next.progress,
    })
    .catch(() => {
      // 发失败就把记录清掉，下次还能重试。不清的话，守护进程重启之后
      // 第一条播报会被"内容没变"挡掉，提示永远出不来。
      lastPublished = IDLE
    })
}

/** 离开一个可续做的场景时调它（关掉笔记、传输结束）。 */
export function clearActivity(): void {
  publishActivity({ kind: 'none' })
}

/**
 * 订阅他机活动，三个触发点缺一不可：挂载时拉一次（错过的推送不会补）；收到事件时拉；
 * 定时轮询（Go 侧过期是懒删除，没人查就不过期，对端关机后提示会一直挂着）。
 */
export function useContinuity(pollMs = 30_000): ContinuityItem[] {
  const [items, setItems] = useState<ContinuityItem[]>([])

  useEffect(() => {
    let alive = true
    const api = window.crossDeviceAPI
    if (!api) return

    const refresh = (opts?: { skipWhenHidden?: boolean }) => {
      // 窗口最小化/后台时不轮询，没人看就白耗电和网络；回前台时 visibilitychange 会补一次。
      if (opts?.skipWhenHidden && document.visibilityState !== 'visible') return
      void api
        .call<{ items?: ContinuityItem[] }>('list_continuity')
        .then((res) => {
          if (alive) setItems(res?.items ?? [])
        })
        .catch(() => {
          // 守护进程没起来。清空而不是保留旧列表——保留的话，用户会看到一条
          // 指向"电脑"的提示，而电脑其实早就不在线了。
          if (alive) setItems([])
        })
    }

    refresh()
    const off = api.onEvent((payload) => {
      if (payload.event === 'continuity') refresh()
    })
    const timer = window.setInterval(() => refresh({ skipWhenHidden: true }), pollMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      off?.()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pollMs])

  return items
}
