/**
 * 命令面板（Ctrl+K）全局搜索结果的分组。后端 `global_search` 返回带 `module` 的平铺列表且不截断，
 * 界面按模块分组并标真实总数，分组须满足：
 * 1. 组间顺序固定，与侧边栏一致，不随后端或 Map 插入顺序漂移；
 * 2. 组内保持后端原序（笔记和剪贴板是 bm25 相关度排序，重排会静默丢掉相关度）。
 * 放 lib 以便 node 用例直接断言（tests/globalSearchGrouping.test.mjs）。
 */
import type { GlobalSearchResult } from '@/shared/ipcTypes'

export type SearchModule = GlobalSearchResult['module']

/** 分组显示顺序。跟侧边栏的模块顺序一致，也跟后端拼结果的顺序一致。 */
export const SEARCH_MODULE_ORDER: SearchModule[] = ['clipboard', 'notes', 'passwords']

export interface SearchResultGroup {
  module: SearchModule
  items: GlobalSearchResult[]
}

/** 按模块分组，空分组不返回（界面上不显示"剪贴板 · 共 0 条"这种空壳）。 */
export function groupSearchResults(results: GlobalSearchResult[]): SearchResultGroup[] {
  const buckets = new Map<SearchModule, GlobalSearchResult[]>()
  for (const result of results) {
    const bucket = buckets.get(result.module)
    if (bucket) bucket.push(result)
    else buckets.set(result.module, [result])
  }
  return SEARCH_MODULE_ORDER.map((module) => ({ module, items: buckets.get(module) ?? [] })).filter(
    (group) => group.items.length > 0,
  )
}
