import type { LucideIcon } from 'lucide-react'
import { createSearcher } from '../engine'

/** 设备与同步主页一处搜全部：设备、传输、同步记录、功能格。条目由页面映射成中性结构，这里不认识守护进程类型。 */
export interface HubEntry {
  key: string
  group: string
  title: string
  sub?: string
  /** 只参与搜索不显示的文字（状态码、英文类型等）。 */
  extra?: string
  at?: number
  tone?: 'ok' | 'warn' | 'error'
  icon: LucideIcon
}

export interface HubGroup {
  id: string
  label: string
  icon: LucideIcon
}

export const hubSearcher = createSearcher<HubEntry>([
  { key: 'title', get: (e) => e.title, weight: 2, aliases: ['名称', 'name'] },
  { key: 'sub', get: (e) => e.sub, weight: 1.2 },
  { key: 'extra', get: (e) => e.extra, weight: 0.8 },
])
