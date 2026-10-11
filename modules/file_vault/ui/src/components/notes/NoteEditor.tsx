/**
 * 笔记正文编辑器，独立分块，首次打开/新建笔记时才下载（react-codemirror + basicSetup 压缩后约 395
 * KB）。不能只挪走 `<CodeMirror>`：NotesScreen 里对 `EditorView.scrollIntoView` /
 * `setPositionMarker.of` 的值引用会把 codemirror 拖回其分块且构建不报错。故这些能力由本模块求值时
 * 注册进 lib/notes/editorRuntime.ts，NotesScreen 只经该桥调用，自己只留 `import type`。字体参数接
 * 收已解析好的 fontFamily 字符串，枚举→字体族映射属界面偏好一侧。/
 */
import { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { positionMarkerExtension, setPositionMarker } from '@/lib/positionMarkerExtension'
import { setEditorRuntime } from '@/lib/notes/editorRuntime'

// 一个事务里可能同时带位置标记和滚动两种 effect，用两者的实际返回类型取并集，
// 不用 any——StateEffect 的类型参数不协变，写成 StateEffect<unknown>[] 通不过。
type RevealEffect = ReturnType<typeof setPositionMarker.of> | ReturnType<typeof EditorView.scrollIntoView>

// 模块求值时就注册（不是在组件 useEffect 里）——onCreateEditor 最早也要等本模块
// 加载完、组件挂载之后才会触发，所以注册一定早于任何一次 reveal 调用。
setEditorRuntime({
  reveal(view, options) {
    const effects: RevealEffect[] = []
    // 三态：不传 = 不动标记；null = 清除；数字 = 标在该偏移处。
    if (options.marker !== undefined) effects.push(setPositionMarker.of(options.marker))
    if (options.scrollTo) {
      const { pos, y, yMargin } = options.scrollTo
      effects.push(EditorView.scrollIntoView(pos, { y, yMargin }))
    }
    // 什么都没有就不要发空事务：空事务照样会走一遍 onUpdate，把
    // schedulePositionSave 的防抖白重置一次。
    if (options.selection || effects.length > 0) {
      view.dispatch({
        ...(options.selection ? { selection: options.selection } : {}),
        ...(effects.length > 0 ? { effects } : {}),
      })
    }
    if (options.focus) view.focus()
  },
})

// 字体族/字号/字重变化时生成新的 EditorView.theme() 扩展；纯函数，调用方用 useMemo 按三个值缓存。
function buildFontTheme(family: string | undefined, size: number, weight: number): Extension {
  return EditorView.theme({
    '&': { fontSize: `${size}px`, fontWeight: String(weight), ...(family ? { fontFamily: family } : {}) },
    '.cm-content': { fontFamily: 'inherit', fontWeight: 'inherit' },
    '.cm-gutters': { fontFamily: 'inherit' },
  })
}

export interface NoteEditorProps {
  value: string
  editable: boolean
  height: string
  theme: 'dark' | 'light'
  /** 已解析好的 CSS font-family；`undefined` = 不覆盖（等宽档就走 CodeMirror 原生栈）。 */
  fontFamily: string | undefined
  fontSize: number
  fontWeight: number
  /** 是不是 Markdown 笔记——决定要不要再懒加载一层语法高亮。 */
  syntaxHighlight: boolean
  placeholder: string
  onChange: (value: string) => void
  onUpdate: (viewUpdate: ViewUpdate) => void
  onCreateEditor: (view: EditorView) => void
}

export function NoteEditor({
  value,
  editable,
  height,
  theme,
  fontFamily,
  fontSize,
  fontWeight,
  syntaxHighlight,
  placeholder,
  onChange,
  onUpdate,
  onCreateEditor,
}: NoteEditorProps) {
  const fontExtension = useMemo(() => buildFontTheme(fontFamily, fontSize, fontWeight), [fontFamily, fontSize, fontWeight])

  // Markdown 语法高亮（lang-markdown 等）再按需加载一层：纯文本笔记用不到；加载前编辑器照常可用，只是
  // 无高亮。加载失败保持无高亮、不弹提示（纯装饰），但要留一行 console，免得"偶尔不高亮"查不出原因。
  const [markdownExtension, setMarkdownExtension] = useState<Extension | null>(null)
  useEffect(() => {
    if (!syntaxHighlight || markdownExtension) return
    let cancelled = false
    void import('@codemirror/lang-markdown').then(
      ({ markdown }) => {
        if (!cancelled) setMarkdownExtension(markdown())
      },
      (err) => {
        console.error('failed to load markdown syntax highlighting', err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [syntaxHighlight, markdownExtension])

  // extensions 数组必须缓存引用：@uiw/react-codemirror 在引用变化时会执行 StateEffect.reconfigure（全
  // 量重配，笔记越大越贵）。此前每次渲染新建内联数组，导致每敲一个字都重配，是大文件编辑慢的根因之一
  // 。只在字体、是否高亮变化时换新引用；positionMarkerExtension() 返回模块级 StateField，不参与依赖。
  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      fontExtension,
      positionMarkerExtension(),
      ...(markdownExtension ? [markdownExtension] : []),
    ],
    [fontExtension, markdownExtension],
  )

  return (
    <CodeMirror
      value={value}
      editable={editable}
      width="100%"
      height={height}
      theme={theme}
      extensions={extensions}
      onUpdate={onUpdate}
      onChange={onChange}
      onCreateEditor={onCreateEditor}
      placeholder={placeholder}
    />
  )
}

// React.lazy 只认默认导出；具名导出留着给可能的直接引用/用例。
export default NoteEditor
