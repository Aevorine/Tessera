import { createSearcher } from '../engine'
import type { PasswordEntry } from '@/shared/ipcTypes'

// 密码页可搜字段。密码本身绝不进索引：搜索框、最近搜索都是明文，按密码搜等于把密码写进 localStorage。
export const passwordSearcher = createSearcher<PasswordEntry>([
  { key: 'name', get: (e) => e.name, weight: 2, aliases: ['网站', '名称', '标题', 'site', 'title'] },
  { key: 'username', get: (e) => e.username, weight: 1.5, aliases: ['账号', '用户名', '用户', 'user', 'account'] },
  { key: 'url', get: (e) => e.url, aliases: ['网址', '链接', '域名', 'link', 'host'] },
  { key: 'notes', get: (e) => e.notes, weight: 0.7, aliases: ['备注', 'note'] },
])
