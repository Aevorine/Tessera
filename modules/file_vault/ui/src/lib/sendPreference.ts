interface SendPreference {
  fanout: 'one' | 'many'
  soloTarget: string | null
  selected: string[]
}
const KEY = 'tessera.send-targets.v1'
export function loadSendPreference(): SendPreference {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || '{}')
    return {
      fanout: p.fanout === 'many' ? 'many' : 'one',
      soloTarget: typeof p.soloTarget === 'string' ? p.soloTarget : null,
      selected: Array.isArray(p.selected) ? p.selected.filter((id: unknown): id is string => typeof id === 'string') : [],
    }
  } catch { return { fanout: 'one', soloTarget: null, selected: [] } }
}
export function saveSendPreference(preference: SendPreference) {
  try { localStorage.setItem(KEY, JSON.stringify(preference)) } catch { /* Storage may be unavailable. */ }
}
