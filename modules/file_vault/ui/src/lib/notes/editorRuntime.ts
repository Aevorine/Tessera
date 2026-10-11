/**
 * 编辑器运行时桥：让 NotesScreen 不静态引用 CodeMirror 也能操作已挂载的编辑器。
 * `@uiw/react-codemirror` 约 395 KB，只要 NotesScreen 里还有一处 codemirror 的值引用
 * （如 `EditorView.scrollIntoView`），打包器就会把它塞回本分块，lazy 失效且不报错；`import type` 会被擦除不算。
 * 所以需要 codemirror 值的代码收进 reveal()，实现注册在懒加载的 NoteEditor 侧。
 * impl 未注册时什么都不做是安全的：调用点先取 `editorViewRef.current`，它只由 NoteEditor 的 onCreateEditor 填，
 * 有 view 即意味着已注册。
 */
import type { EditorView } from '@codemirror/view'

/** 滚动落点。语义与 CodeMirror `EditorView.scrollIntoView` 的第二个参数一致。 */
export interface RevealScrollTarget {
  pos: number
  y?: 'nearest' | 'start' | 'end' | 'center'
  yMargin?: number
}

export interface RevealOptions {
  /** 光标 / 选区。 */
  selection?: { anchor: number; head: number }
  /** 滚动到某个偏移处。 */
  scrollTo?: RevealScrollTarget
  /** "上次读到这里"的行标记（见 lib/positionMarkerExtension.ts）：数字=标在该偏移，`null`=清除，不传=不动；清除与无关是两回事。 */
  marker?: number | null
  /** 做完之后把焦点交给编辑器。 */
  focus?: boolean
}

export interface EditorRuntime {
  /** 把上述动作合成一个事务发出：拆成多次 dispatch 会多走 measure/update，大笔记可见，且 onUpdate 会观察到中间态。 */
  reveal(view: EditorView, options: RevealOptions): void
}

let impl: EditorRuntime | null = null

export function setEditorRuntime(runtime: EditorRuntime): void {
  impl = runtime
}

export function reveal(view: EditorView, options: RevealOptions): void {
  impl?.reveal(view, options)
}
