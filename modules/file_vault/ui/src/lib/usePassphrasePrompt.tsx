import { useCallback, useRef, useState, type ReactNode } from 'react'
import { PassphraseDialog, type PassphraseMode, type PassphraseRequest } from '@/components/files/PassphraseDialog'

/** 以 Promise 方式问一次口令，取消返回 null；口令只存在于对话框组件状态和本次调用，不进任何存储。 */
export function usePassphrasePrompt(): {
  ask: (mode: PassphraseMode, count: number, error?: string) => Promise<string | null>
  element: ReactNode
} {
  const [request, setRequest] = useState<PassphraseRequest | null>(null)
  const nextId = useRef(0)
  const ask = useCallback(
    (mode: PassphraseMode, count: number, error?: string) =>
      new Promise<string | null>((resolve) => {
        nextId.current += 1
        const id = nextId.current
        setRequest((current) => {
          // 上一个还没答的问题（比如解密流程还在读头部时又点了「校验」）
          // 按取消收尾，否则它的调用方会永远等下去。
          current?.resolve(null)
          return { id, mode, count, error, resolve }
        })
      }),
    [],
  )
  const finish = useCallback((value: string | null) => {
    setRequest((current) => {
      current?.resolve(value)
      return null
    })
  }, [])
  return { ask, element: <PassphraseDialog request={request} onDone={finish} /> }
}
