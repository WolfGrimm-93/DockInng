// Hook de logs en vivo con BUFFER CIRCULAR (5 000 líneas) y volcado agrupado (no re-renderiza por línea).
// Contrato: useLogStream(containerId | null, { tail?: 300, follow?: true, max?: 5000 }) -> { lines: LogLine[], dropped: number, ended: EndReason | null, clear() }
//   - `dropped` = líneas descartadas: por límite de caudal del backend Y por el tope local de `pending` (se refleja en la UI: «N líneas omitidas»).
//   - El volcado usa requestAnimationFrame CON timer de respaldo (con la ventana oculta rAF no dispara): `pending` nunca crece sin límite.
//   - Cancela el stream al desmontar/cambiar de id. El estado se asocia al id (sin setState síncrono en el efecto).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEngineApi } from '@/data/store/hooks'
import type { EndReason, LogFeed, LogLine } from '@/data/types'

export const LOG_BUFFER_MAX = 5000
/** Tope de líneas pendientes de volcar (protege la memoria si el volcado se retrasa). */
export const LOG_PENDING_MAX = 2000
const FLUSH_FALLBACK_MS = 250

/** Añade líneas manteniendo solo las últimas `max` (puro: testeable). */
export function appendRing<T>(prev: T[], add: T[], max: number = LOG_BUFFER_MAX): T[] {
  if (!add.length) return prev
  return prev.length + add.length > max ? prev.concat(add).slice(-max) : prev.concat(add)
}

/** Añade a `pending` respetando el tope; devuelve cuántas líneas se descartaron (las más antiguas). */
export function pushPending<T>(pending: T[], add: T[], cap: number = LOG_PENDING_MAX): number {
  pending.push(...add)
  const over = pending.length - cap
  if (over > 0) pending.splice(0, over)
  return Math.max(0, over)
}

interface State { id: string | null; lines: LogLine[]; dropped: number; ended: EndReason | null }
const EMPTY = (id: string | null): State => ({ id, lines: [], dropped: 0, ended: null })

export function useLogStream(containerId: string | null, o: { tail?: number; follow?: boolean; max?: number } = {}) {
  const api = useEngineApi()
  const { tail = 300, follow = true, max = LOG_BUFFER_MAX } = o
  const [state, setState] = useState<State>(() => EMPTY(containerId))
  const pending = useRef<LogLine[]>([])
  const pendingDropped = useRef(0)
  const raf = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    pending.current = []
    pendingDropped.current = 0
    if (!containerId) return
    const cancelFlush = () => {
      if (raf.current != null) cancelAnimationFrame(raf.current)
      if (timer.current != null) clearTimeout(timer.current)
      raf.current = null
      timer.current = null
    }
    const flush = () => {
      cancelFlush()
      const add = pending.current
      const drop = pendingDropped.current
      pending.current = []
      pendingDropped.current = 0
      if (!add.length && !drop) return
      setState((prev) => {
        const base = prev.id === containerId ? prev : EMPTY(containerId)
        return { ...base, lines: appendRing(base.lines, add, max), dropped: base.dropped + drop }
      })
    }
    const schedule = () => {
      if (raf.current == null) raf.current = requestAnimationFrame(flush)
      if (timer.current == null) timer.current = setTimeout(flush, FLUSH_FALLBACK_MS)
    }
    const off = api.containers.streamLogs(containerId, { tail, follow }, (feed: LogFeed) => {
      if (feed.type === 'lines') {
        pendingDropped.current += feed.dropped + pushPending(pending.current, feed.lines)
        schedule()
      } else {
        flush()
        setState((prev) => ({ ...(prev.id === containerId ? prev : EMPTY(containerId)), ended: feed.reason }))
      }
    })
    return () => {
      off()
      cancelFlush()
    }
  }, [api, containerId, tail, follow, max])

  const clear = useCallback(() => setState((p) => ({ ...EMPTY(p.id), ended: p.ended })), [])
  const cur = state.id === containerId ? state : EMPTY(containerId)
  return { lines: cur.lines, dropped: cur.dropped, ended: cur.ended, clear }
}
