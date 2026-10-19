import { createSearcher } from '../engine'
import type { ClipboardEntry } from '@/shared/ipcTypes'

export const clipboardSearcher = createSearcher<ClipboardEntry>([
  { key: 'text', get: (e) => e.content_text, weight: 2, aliases: ['内容', 'text', 'clip'] },
  { key: 'app', get: (e) => e.source_app, weight: 1.5, aliases: ['应用', '来源', 'source'] },
  { key: 'type', get: (e) => e.content_type, aliases: ['类型'] },
  { key: 'date', get: (e) => e.created_at, aliases: ['日期'] },
])
