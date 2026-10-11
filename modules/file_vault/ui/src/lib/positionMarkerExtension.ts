// 轻量 CodeMirror 扩展：恢复"上次阅读/编辑位置"后给该行加短暂高亮（细左边框），几秒后自动清除，不干扰阅读。
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export const setPositionMarker = StateEffect.define<number | null>()

const markerDecoration = Decoration.line({ attributes: { class: 'cm-last-position-marker' } })

const positionMarkerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPositionMarker)) {
        if (effect.value === null) return Decoration.none
        const pos = Math.min(Math.max(effect.value, 0), tr.state.doc.length)
        const line = tr.state.doc.lineAt(pos)
        return Decoration.set([markerDecoration.range(line.from)])
      }
    }
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function positionMarkerExtension() {
  return positionMarkerField
}
