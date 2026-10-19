import { createSearcher } from '../engine'
import type { RecoveryCodeGroup } from '@/shared/ipcTypes'

export const recoverySearcher = createSearcher<RecoveryCodeGroup>([
  { key: 'service', get: (g) => g.service, weight: 2, aliases: ['网站', '服务', 'name', 'site'] },
  { key: 'account', get: (g) => g.accountLabel, weight: 1.5, aliases: ['账号', 'user'] },
  { key: 'file', get: (g) => g.sourceFileName, aliases: ['文件', 'source'] },
  { key: 'note', get: (g) => g.note, weight: 0.7, aliases: ['备注', 'notes'] },
])
