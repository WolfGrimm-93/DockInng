// Stacks Compose: envoltorio del store (FUENTE ÚNICA: la misma lista alimenta la página, la cabecera y el contador del menú).
// Contrato: useStacks() -> { list, status: 'loading'|'ready'|'error', available: boolean|null, compose, error, reload(), recheck() }
//   available: null = aún no comprobado; false = Docker Compose ausente o no soportado (v1).
import { useCallback } from 'react'
import { apiErrorMessage } from '@/data/errors'
import { useCompose, useEngineStoreApi, useStackList } from '@/data/store/hooks'

export function useStacks() {
  const store = useEngineStoreApi()
  const { list, status, error } = useStackList()
  const compose = useCompose()
  const reload = useCallback(async () => { await store.getState().refresh('stacks') }, [store])
  const recheck = useCallback(() => store.getState().checkCompose(true), [store])
  const s: 'loading' | 'ready' | 'error' = status === 'ready' ? 'ready' : status === 'error' ? 'error' : 'loading'
  const available = compose === null ? null : compose.available && compose.supported
  return { list, status: s, available, compose, error: error ? apiErrorMessage(error).detail : null, reload, recheck }
}
