// Reglas de notificación nativa (Ola 3). El frontend YA recibe el stream de eventos del motor y conoce los nombres; decide QUÉ merece un aviso
// y llama a `window.notifyUser` (el backend valida el tipo, respeta las prefs y decide si mostrarlo según el foco de la ventana).
//  - Contenedor: `die` con exitCode ≠ 0 y sin parada iniciada por la propia app · `oom` · `health_status: unhealthy`.
//  - Operación terminada con la ventana sin foco/oculta: descarga de imagen y operación de stack (up/down/restart…).
//  - Anti-ruido: máx. 1 aviso por contenedor y tipo cada 30 s; las caídas seguidas se agrupan («N contenedores cayeron»).
//  - Nunca se incluyen variables de entorno ni logs; los nombres son datos no confiables (una sola línea, recortados).
import { safeText } from '@/lib/safeText'
import { isIdle } from '@/lib/windowActivity'
import type { EngineApi } from './api'
import type { EngineStore } from './store/engineStore'
import { useShellPrefs } from './shellPrefs'
import type { EngineEvent, NotifyKind, NotifyRequest } from './types'

export const DEDUPE_MS = 30_000
export const BATCH_MS = 1_500
const NAME_MAX = 60

const label = (s: string | null | undefined): string => {
  const t = safeText(s ?? '', { singleLine: true })
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t || 'contenedor'
}

/** Regla pura: ¿este evento del motor merece un aviso? `expected` = la app inició esa parada/reinicio hace poco. */
export function ruleFor(ev: EngineEvent, expected: boolean): { kind: NotifyKind; name: string; key: string } | null {
  if (ev.kind !== 'container') return null
  const name = label(ev.attributes.name ?? ev.name)
  if (ev.action === 'oom') return { kind: 'oom', name, key: `oom:${ev.id}` }
  if (ev.action === 'die') {
    const code = ev.attributes.exitCode
    if (code === undefined || code === '0' || expected) return null
    return { kind: 'die', name, key: `die:${ev.id}` }
  }
  if (ev.action.startsWith('health_status') && /unhealthy\s*$/.test(ev.action)) return { kind: 'unhealthy', name, key: `unhealthy:${ev.id}` }
  return null
}

const TITLE: Record<Exclude<NotifyKind, 'op_done'>, string> = { die: 'Un contenedor se detuvo con error', oom: 'Un contenedor se quedó sin memoria', unhealthy: 'Un contenedor no está sano' }
const BATCH_TITLE: Record<Exclude<NotifyKind, 'op_done'>, string> = { die: 'contenedores cayeron', oom: 'contenedores se quedaron sin memoria', unhealthy: 'contenedores no están sanos' }

export interface NotifierOptions { now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; idle?: () => boolean }

/** Arranca las reglas. Devuelve la baja. */
export function startNotifications(api: EngineApi, store: EngineStore, opts: NotifierOptions = {}): () => void {
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const idle = opts.idle ?? (() => isIdle())
  const lastSent = new Map<string, number>()
  const expectedUntil = new Map<string, number>()
  let batch: { name: string; kind: Exclude<NotifyKind, 'op_done'> }[] = []
  let timerSet = false
  let stopped = false

  const send = (n: NotifyRequest) => { void api.window.notifyUser(n).catch(() => {}) }
  const enabled = (kind: NotifyKind): boolean => { const p = useShellPrefs.getState(); return p.notifyEnabled && p.notifyEvents[kind] }

  const flush = () => {
    timerSet = false
    const items = batch
    batch = []
    if (stopped || !items.length) return
    const byKind = new Map<Exclude<NotifyKind, 'op_done'>, typeof items>()
    for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item])
    for (const [kind, grouped] of byKind) {
      if (grouped.length === 1) { send({ kind, title: TITLE[kind], body: grouped[0].name }); continue }
      const names = grouped.slice(0, 3).map((i) => i.name).join(', ')
      send({ kind, title: `${grouped.length} ${BATCH_TITLE[kind]}`, body: grouped.length > 3 ? `${names} y ${grouped.length - 3} más` : names })
    }
  }

  const offEvents = api.events.subscribe((feed) => {
    if (feed.type !== 'events' || feed.resync) return
    for (const ev of feed.items) {
      const r = ruleFor(ev, (expectedUntil.get(ev.id) ?? 0) > now())
      if (!r || !enabled(r.kind)) continue
      const last = lastSent.get(r.key)
      if (last !== undefined && now() - last < DEDUPE_MS) continue
      lastSent.set(r.key, now())
      batch.push({ name: r.name, kind: r.kind as Exclude<NotifyKind, 'op_done'> })
      if (!timerSet) { timerSet = true; setTimer(flush, BATCH_MS) }
    }
  })

  // Paradas/reinicios que inicia la propia app: no son una «caída» (30 s de margen desde que empiezan).
  const offStore = store.subscribe((s, prev) => {
    for (const id of Object.keys(s.rowOps)) if (s.rowOps[id]?.busy && !prev.rowOps[id]?.busy) expectedUntil.set(id, now() + DEDUPE_MS)
    // Operaciones largas que terminan mientras la ventana no se mira.
    if (!enabled('op_done') || !idle()) return
    for (const [ref, p] of Object.entries(s.pulls)) {
      if (prev.pulls[ref]?.state === 'pulling' && (p.state === 'done' || p.state === 'error')) send({ kind: 'op_done', title: p.state === 'done' ? 'Descarga terminada' : 'La descarga falló', body: label(ref) })
    }
    for (const [proj, o] of Object.entries(s.stackOps)) {
      if (prev.stackOps[proj]?.state === 'running' && (o.state === 'done' || o.state === 'error')) send({ kind: 'op_done', title: o.state === 'done' ? `Stack ${label(proj)}: ${o.kind} terminado` : `Stack ${label(proj)}: ${o.kind} falló`, body: label(proj) })
    }
  })

  return () => { stopped = true; offEvents(); offStore() }
}
