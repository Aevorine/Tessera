/**
 * 笔记编辑器分块拆分。`@uiw/react-codemirror` + basicSetup 压缩后约 395 KB，原先静态挂在 NotesScreen，
 * 点开笔记本须先解析整个编辑器；现为独立分块 components/notes/NoteEditor，打开笔记才下载（NotesScreen 分块 523 KB → 113 KB）。
 * 坏掉时一声不响，两种坏法：
 *   1. NotesScreen 补了 `@codemirror/view` 的值引用（如 `import { EditorView }`），打包器就把整个 codemirror
 *      塞回该分块，lazy 白做，构建无警告、功能全对。只允许 `import type`（被 TS 擦掉）。
 *   2. NoteEditor 忘了调 `setEditorRuntime(...)`，NotesScreen 的所有 `reveal(...)` 静默 no-op：
 *      章节目录不跳转、查找不滚动、「上次读到这里」标记不出现。
 * 跑法：`npm run test:update`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf-8')

const notesScreen = read('../src/components/NotesScreen.tsx')
const noteEditor = read('../src/components/notes/NoteEditor.tsx')
const editorRuntime = read('../src/lib/notes/editorRuntime.ts')

/** 抓出一个文件里所有 import 语句，连同它是不是 type-only。 */
function importsOf(source) {
  return [...source.matchAll(/^import\s+(type\s+)?([\s\S]*?)from\s+'([^']+)'/gm)].map((m) => ({
    typeOnly: Boolean(m[1]),
    clause: m[2],
    module: m[3],
  }))
}

const CODEMIRROR = /^(@codemirror\/|@uiw\/react-codemirror$)/

test('NotesScreen 对 codemirror 只有 type-only 引用', () => {
  const offenders = importsOf(notesScreen)
    .filter((i) => CODEMIRROR.test(i.module))
    // `import { type X }` 这种内联 type 说明符也算 type-only：整条 import 里
    // 没有一个不带 type 的说明符，编译后同样不会留下 require。
    .filter((i) => !i.typeOnly && i.clause.split(',').some((s) => s.trim() && !/^\{?\s*type\s/.test(s.trim())))
    .map((i) => i.module)

  assert.deepEqual(
    offenders,
    [],
    `NotesScreen 出现了 codemirror 的值引用（${offenders.join(', ')}）——` +
      '这会把整个编辑器拖回 NotesScreen 分块、让懒加载失效，而且不报错。' +
      '要对编辑器动手请走 lib/notes/editorRuntime 的 reveal()。',
  )
})

test('编辑器经由 React.lazy + 动态 import 加载，并有等高的 Suspense 兜底', () => {
  assert.match(
    notesScreen,
    /const NoteEditor = lazy\(\(\) => import\('@\/components\/notes\/NoteEditor'\)\)/,
    'NoteEditor 必须是 lazy(() => import(...))，静态 import 会让分块拆分失效',
  )
  // 兜底高度必须跟编辑器一致，否则第一次打开笔记时下面的内容会先挤上来再被推回去。
  const editorHeight = /height=\{fullscreen \? '72vh' : '50vh'\}/
  const fallbackHeight = /style=\{\{ height: fullscreen \? '72vh' : '50vh' \}\}/
  assert.match(notesScreen, editorHeight, '编辑器高度表达式变了，兜底占位要跟着改')
  assert.match(notesScreen, fallbackHeight, 'Suspense 兜底占位必须和编辑器一样高')
})

test('NoteEditor 在模块求值时就注册 reveal 实现', () => {
  // 放模块顶层而非 useEffect：onCreateEditor 最早也在模块加载、组件挂载后触发，顶层注册必早于任何 reveal；
  // 同一轮 commit 里 effect 的执行顺序不可控。
  assert.match(noteEditor, /^setEditorRuntime\(\{/m, 'setEditorRuntime 必须在 NoteEditor 模块顶层调用')
  assert.match(noteEditor, /reveal\(view, options\)/, 'reveal 实现缺失，NotesScreen 的所有编辑器操作都会静默失效')
  // 这两个才是"必须待在懒加载那一侧"的值引用，实现真的用到了它们。
  assert.match(noteEditor, /EditorView\.scrollIntoView\(/, 'reveal 的滚动应由 EditorView.scrollIntoView 实现')
  assert.match(noteEditor, /setPositionMarker\.of\(/, 'reveal 的位置标记应由 setPositionMarker 实现')
})

test('editorRuntime 这座桥本身不引用任何 codemirror 值', () => {
  // 它被 NotesScreen 静态 import，一旦它自己拖进 codemirror，等于 NotesScreen
  // 间接拖进 codemirror——比第 1 条更隐蔽，因为 NotesScreen 里看不见。
  const valueImports = importsOf(editorRuntime).filter((i) => CODEMIRROR.test(i.module) && !i.typeOnly)
  assert.deepEqual(valueImports.map((i) => i.module), [], 'editorRuntime 只允许 import type')
})

test('reveal 不发空事务', () => {
  // 空事务照样会走一遍 onUpdate，把 schedulePositionSave 的 500ms 防抖白重置一次。
  assert.match(
    noteEditor,
    /if \(options\.selection \|\| effects\.length > 0\)/,
    'reveal 在既没有选区也没有 effect 时应当直接跳过 dispatch',
  )
})
