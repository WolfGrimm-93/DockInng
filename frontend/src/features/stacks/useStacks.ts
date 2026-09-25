// Carga de los stacks Compose (SIMULADOS: capacidad `stacks` no conectada aún) y de la disponibilidad de `docker compose`.
// Contrato: useStacks() -> { list, status: 'loading'|'ready'|'error', available: boolean|null, error, reload(), recheck() }
import { useCallback, useEffect, useState } from 'react'
import { apiErrorMessage } from '@/data/errors'
import { useEngineApi } from '@/data/store/hooks'
import type { StackSummary } from '@/data/types'

export function useStacks() {
  const api = useEngineApi()
  const [list, setList] = useState<StackSummary[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)

  const reload = useCallback(async () => {
    try {
      const [l, a] = await Promise.all([api.stacks.list(), api.stacks.composeAvailable()])
      setList(l)
      setAvailable(a)
      setError(null)
      setStatus('ready')
    } catch (e) {
      setError(apiErrorMessage(e).detail)
      setStatus('error')
    }
  }, [api])

  useEffect(() => {
    let alive = true
    Promise.all([api.stacks.list(), api.stacks.composeAvailable()]).then(
      ([l, a]) => { if (alive) { setList(l); setAvailable(a); setStatus('ready') } },
      (e) => { if (alive) { setError(apiErrorMessage(e).detail); setStatus('error') } },
    )
    return () => { alive = false }
  }, [api])

  const recheck = useCallback(async (): Promise<boolean> => {
    const a = await api.stacks.composeAvailable().catch(() => false)
    setAvailable(a)
    return a
  }, [api])

  return { list, status, available, error, reload, recheck }
}
