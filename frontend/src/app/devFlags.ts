// PARÁMETROS DE DEPURACIÓN de la plantilla (?state= ?compose= ?ctx= ?dialog= ?toast= ?policy= ?menu= ?sel= ?group=
// ?theme= ?sidebar=). Solo se interpretan en modo simulado (navegador) o import.meta.env.DEV.
// Contrato:
//   getDevFlags(): DevFlags                 (parseado una vez de location.search; vacío si !devFlagsEnabled)
//   devFlagsEnabled(api): boolean
//   usePreviewState(): 'empty'|'loading'|null   vista previa POR VISTA; se limpia al cambiar de ruta (como la plantilla)
//   setPreviewState(v) · useComposeMissing(): boolean · setComposeMissing(b)
//   applyPrepare(api) / applyReady(api, store): las usan EngineProvider (prepare/onReady) para ?state=error|daemon|ssh|lost y ?ctx=
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { EngineApi } from '@/data/api'
import { asSim } from '@/data/createEngineApi'
import type { EngineStore } from '@/data/store/engineStore'

export interface DevFlags {
  state: 'empty' | 'loading' | 'error' | 'daemon' | 'ssh' | 'lost' | null
  compose: 'missing' | null
  ctx: string | null
  dialog: string | null
  toast: boolean
  policy: 'denied' | null
  menu: boolean
  sel: number
  group: boolean
}

const EMPTY: DevFlags = { state: null, compose: null, ctx: null, dialog: null, toast: false, policy: null, menu: false, sel: 0, group: false }
let cached: DevFlags | null = null

export function parseDevFlags(search: string): DevFlags {
  const p = new URLSearchParams(search)
  const st = p.get('state')
  return {
    state: st === 'empty' || st === 'loading' || st === 'error' || st === 'daemon' || st === 'ssh' || st === 'lost' ? st : null,
    compose: p.get('compose') === 'missing' ? 'missing' : null,
    ctx: p.get('ctx'),
    dialog: p.get('dialog'),
    toast: !!p.get('toast'),
    policy: p.get('policy') === 'denied' ? 'denied' : null,
    menu: p.get('menu') === '1',
    sel: Math.max(0, parseInt(p.get('sel') || '0', 10) || 0),
    group: p.get('group') === '1',
  }
}

export const devFlagsEnabled = (api: EngineApi): boolean => api.mode === 'browser' || import.meta.env.DEV

/** Se fija al arrancar (AppShell/EngineProvider); antes de eso devuelve vacío. */
export function initDevFlags(api: EngineApi): DevFlags {
  cached = devFlagsEnabled(api) ? parseDevFlags(window.location.search) : EMPTY
  const s = cached
  devState.setState({ preview: s.state === 'empty' || s.state === 'loading' ? s.state : null, composeMissing: s.compose === 'missing' })
  return cached
}
export const getDevFlags = (): DevFlags => cached ?? EMPTY

interface DevState { preview: 'empty' | 'loading' | null; composeMissing: boolean }
export const devState = createStore<DevState>(() => ({ preview: null, composeMissing: false }))

export const usePreviewState = (): DevState['preview'] => useStore(devState, (s) => s.preview)
export const setPreviewState = (v: DevState['preview']): void => devState.setState({ preview: v })
export const useComposeMissing = (): boolean => useStore(devState, (s) => s.composeMissing)
export const setComposeMissing = (b: boolean): void => devState.setState({ composeMissing: b })

/** Antes de bootstrap: fallos de conexión simulados y conexión activa (?state=error|daemon|ssh, ?ctx=). */
export function applyPrepare(api: EngineApi): void {
  const f = initDevFlags(api)
  const sim = asSim(api)
  if (!sim) return
  if (f.state === 'error') sim.setFault('permission')
  else if (f.state === 'daemon') sim.setFault('daemon')
  const ctx = f.state === 'ssh' ? 'staging' : f.ctx
  if (ctx) void api.connections.select(ctx).catch(() => undefined)
}
/** Tras bootstrap: ?state=lost. */
export function applyReady(_api: EngineApi, store: EngineStore): void {
  // ?state=error|daemon|ssh simula «se cayó la conexión»: como la plantilla, el sidebar conserva los últimos contadores conocidos.
  if (['error', 'daemon', 'ssh'].includes(getDevFlags().state ?? '')) void store.getState().refresh('all')
  if (getDevFlags().state === 'lost') store.getState().markLost()
}

