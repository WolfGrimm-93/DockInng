// STORE NORMALIZADO del motor (zustand vanilla: usable dentro y fuera de React, testeable sin DOM).
// Contrato público:
//   createEngineStore(api, opts?) -> EngineStore   (getState()/subscribe()/setState de zustand)
//   Estado:  connection · profiles · activeProfileId · containers/images/volumes/networks (Entity) · stats · rowOps · polling
//   Acciones (getState().x): bootstrap() · dispose() · retry() · selectProfile(id) · refresh(kind?) · runContainerOp(id, op) · runContainerOps(ids, op, {concurrency})
//                            setRowBusy(id, busy?) · clearRowError(id) · markLost() · setPolling(on)
// Flujo (PLAN_frontend §2.5): bootstrap -> connection_status; si conectado -> 4 list() en paralelo + events.subscribe + stats.
// Evento de contenedor => invalidate + refetch en lote (debounce 150 ms); destroy elimina al instante. Eventos de
// imagen/volumen/red => refetch de esa colección (300 ms). Conexión perdida => se CONSERVAN los datos y las acciones se bloquean.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { buildDiagnostic } from '../diagnostics'
import type { EngineApi } from '../api'
import { toApiError } from '../errors'
import { safeStorage } from '@/lib/safeStorage'
import { toast } from '@/lib/toastStore'
import type {
  ApiError, ConnectionIssue, ConnectionProfile, ConnectionState, ConnectionStatus, Container, ContainerBusy, ContainerStats, EngineFeed, EngineInfo,
  Image, Network, Unsubscribe, Volume, GpuInfo, SystemUsage } from '../types'
import { planRefresh } from './eventReducer'

export interface Entity<T> {
  byId: Record<string, T>
  ids: string[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: ApiError
  updatedAt?: number
}
export interface RowOp { busy?: ContainerBusy; error?: string; tried?: boolean }
export type EntityKind = 'containers' | 'images' | 'volumes' | 'networks'

export interface EngineStoreState {
  connection: ConnectionState
  profiles: ConnectionProfile[]
  activeProfileId: string
  containers: Entity<Container>
  images: Entity<Image>
  volumes: Entity<Volume>
  networks: Entity<Network>
  stats: Record<string, ContainerStats>
  /** Recursos del equipo y disco de Docker (se refresca cada ~60 s); null = aún no cargado. */
  system: SystemUsage | null
  /** GPU del equipo (se refresca con el muestreo de stats); vacío = sin GPU detectada. */
  gpu: GpuInfo[]
  rowOps: Record<string, RowOp>
  polling: boolean

  bootstrap(): Promise<void>
  dispose(): void
  retry(): Promise<void>
  selectProfile(id: string): Promise<void>
  refresh(kind?: EntityKind | 'all'): Promise<void>
  runContainerOp(id: string, op: 'start' | 'stop' | 'restart'): Promise<boolean>
  /** Operación masiva: concurrencia limitada (6), UN refresco de contenedores al final y UN toast resumen. */
  runContainerOps(ids: string[], op: 'start' | 'stop' | 'restart', opts?: { concurrency?: number }): Promise<{ ok: number; failed: { id: string; error: ApiError }[] }>
  setRowBusy(id: string, busy?: ContainerBusy): void
  clearRowError(id: string): void
  /** Vista previa de un estado de conexión (dev/simulado): muestra el panel sin tocar el motor. null = volver a conectar. */
  previewConnection(kind: ConnectionIssue | null): void
  /** Simula/aplica «conexión perdida»: se conservan los datos, se bloquean las acciones. */
  markLost(): void
  setPolling(on: boolean): void
}
export type EngineStore = StoreApi<EngineStoreState>

export interface EngineStoreOptions {
  /** ms de muestreo de CPU/Mem (0 = apagado; por defecto 4000). */
  statsIntervalMs?: number
  /** ms de debounce de eventos (por defecto 150 contenedores / 300 resto). */
  debounce?: { containers?: number; others?: number }
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

const emptyEntity = <T,>(): Entity<T> => ({ byId: {}, ids: [], status: 'idle' })
const POLL_KEY = 'dockinng.poll'

function toEntity<T>(rows: T[], key: (r: T) => string, prev?: Entity<T>): Entity<T> {
  const byId: Record<string, T> = {}
  const ids: string[] = []
  for (const r of rows) {
    const k = key(r)
    if (!(k in byId)) ids.push(k)
    byId[k] = r
  }
  void prev
  return { byId, ids, status: 'ready', updatedAt: Date.now() }
}

export const containerName = (c: Pick<Container, 'names' | 'id'>): string => c.names[0] ?? c.id.slice(0, 12)

export function deriveConnection(status: ConnectionStatus, profile: ConnectionProfile): ConnectionState {
  if (status.state === 'connected') return { status: 'connected', info: status.server, endpoint: status.endpoint }
  const diagnostic = buildDiagnostic(status, profile)
  return { status: 'error', issue: diagnostic.issue, diagnostic, message: status.message }
}

export function createEngineStore(api: EngineApi, opts: EngineStoreOptions = {}): EngineStore {
  const statsMs = opts.statsIntervalMs ?? 4000
  const dContainers = opts.debounce?.containers ?? 150
  const dOthers = opts.debounce?.others ?? 300
  const storage = opts.storage === undefined ? safeStorage() : opts.storage

  let unsubEvents: Unsubscribe | null = null
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let statsTick: (() => Promise<void>) | null = null
  let sysTimer: ReturnType<typeof setInterval> | null = null
  let sysTick: (() => Promise<void>) | null = null
  let gpuTick: (() => Promise<void>) | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const timers: Partial<Record<EntityKind, ReturnType<typeof setTimeout>>> = {}
  let generation = 0 // invalida respuestas tardías tras dispose()/cambio de conexión

  let readPoll = false
  try { readPoll = storage?.getItem(POLL_KEY) === '1' } catch { /* sin storage */ }

  const store: EngineStore = createStore<EngineStoreState>((set, get) => {
    const profileOf = (): ConnectionProfile =>
      get().profiles.find((p) => p.id === get().activeProfileId) ??
      { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: '', simulated: false }

    const fetchKind = async (kind: EntityKind): Promise<void> => {
      const gen = generation
      const cur = get()[kind]
      if (cur.status === 'idle') set({ [kind]: { ...cur, status: 'loading' } } as Partial<EngineStoreState>)
      try {
        let next: Entity<Container> | Entity<Image> | Entity<Volume> | Entity<Network>
        if (kind === 'containers') next = toEntity(await api.containers.list(true), (c) => c.id)
        else if (kind === 'images') next = toEntity(await api.images.list(), (i) => i.reference)
        else if (kind === 'volumes') next = toEntity(await api.volumes.list(), (v) => v.name)
        else next = toEntity(await api.networks.list(), (n) => n.id)
        if (gen !== generation) return
        set({ [kind]: next } as Partial<EngineStoreState>)
      } catch (e) {
        if (gen !== generation) return
        set({ [kind]: { ...get()[kind], status: get()[kind].status === 'ready' ? 'ready' : 'error', error: toApiError(e) } } as Partial<EngineStoreState>)
      }
    }
    const fetchAll = async () => {
      await Promise.all((['containers', 'images', 'volumes', 'networks'] as const).map(fetchKind))
    }
    const schedule = (kind: EntityKind, ms: number) => {
      if (timers[kind]) return
      timers[kind] = setTimeout(() => {
        timers[kind] = undefined
        void fetchKind(kind)
      }, ms)
    }

    const applyFeed = (feed: EngineFeed) => {
      if (feed.type === 'events') {
        const p = planRefresh(feed.items, feed.resync)
        if (p.removedContainerIds.length) {
          const c = get().containers
          const byId = { ...c.byId }
          for (const id of p.removedContainerIds) delete byId[id]
          set({ containers: { ...c, byId, ids: c.ids.filter((id) => id in byId) } })
        }
        if (p.containers) schedule('containers', dContainers)
        if (p.images) schedule('images', dOthers)
        if (p.volumes) schedule('volumes', dOthers)
        if (p.networks) schedule('networks', dOthers)
      } else if (feed.type === 'connection') {
        const cur = get().connection
        if (feed.status.state === 'failed' && cur.status === 'connected') {
          set({ connection: { status: 'lost', since: Date.now(), info: cur.info, endpoint: cur.endpoint } })
        } else if (feed.status.state === 'connected' && cur.status === 'lost') {
          set({ connection: { status: 'connected', info: feed.status.server, endpoint: feed.status.endpoint } })
          void fetchAll() // resync completo
        }
      } else if (feed.type === 'ended') {
        const cur = get().connection
        if (cur.status === 'connected') set({ connection: { status: 'lost', since: Date.now(), info: cur.info, endpoint: cur.endpoint } })
      }
    }

    const stopLive = () => {
      unsubEvents?.()
      unsubEvents = null
      if (statsTimer) clearInterval(statsTimer)
      statsTimer = null
      statsTick = null
      if (sysTimer) clearInterval(sysTimer)
      sysTimer = null
      sysTick = null
      gpuTick = null
      for (const k of Object.keys(timers) as EntityKind[]) {
        if (timers[k]) clearTimeout(timers[k])
        timers[k] = undefined
      }
    }
    const startLive = () => {
      stopLive()
      unsubEvents = api.events.subscribe(applyFeed)
      if (statsMs > 0) {
        let inFlight = false // un único vuelo: si el muestreo anterior sigue en curso no se lanza otro
        const tick = async () => {
          if (inFlight || get().connection.status !== 'connected') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          const ids = get().containers.ids.filter((id) => get().containers.byId[id]?.state === 'running').slice(0, 64)
          if (!ids.length) return
          const gen = generation
          inFlight = true
          try {
            const rows = await api.containers.statsSnapshot(ids)
            if (gen !== generation) return
            const stats: Record<string, ContainerStats> = {}
            for (const r of rows) if (r.stats) stats[r.id] = r.stats
            set({ stats })
          } catch { /* el muestreo es opcional: la tabla muestra «—» */ } finally { inFlight = false }
        }
        // El primer muestreo lo lanza connect() DESPUÉS de fetchAll (la lista de contenedores ya existe).
        statsTick = tick

        // GPU del equipo: mismo ritmo que las stats, un único vuelo y sin error visible (sin GPU => []).
        let gpuBusy = false
        gpuTick = async () => {
          if (gpuBusy || get().connection.status !== 'connected') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          const gen = generation
          gpuBusy = true
          try {
            const gpu = await api.system.gpu()
            if (gen === generation) set({ gpu: Array.isArray(gpu) ? gpu : [] })
          } catch { /* opcional */ } finally { gpuBusy = false }
        }
        statsTimer = setInterval(() => { void tick(); void gpuTick?.() }, statsMs)
      }

      // Recursos del equipo y disco de Docker: `df` es pesado, se pide cada 60 s (y tras cada conexión).
      let sysBusy = false
      const stick = async () => {
        if (sysBusy || get().connection.status !== 'connected') return
        const gen = generation
        sysBusy = true
        try {
          const system = await api.system.usage()
          if (gen === generation && system && typeof system === 'object') set({ system })
        } catch { /* opcional: la franja muestra «—» */ } finally { sysBusy = false }
      }
      sysTick = stick
      sysTimer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void stick() }, 60_000)
    }
    const applyPolling = (on: boolean) => {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      if (on) pollTimer = setInterval(() => { if (get().connection.status === 'connected') void fetchAll() }, 5000)
    }

    const connect = async (status: ConnectionStatus) => {
      const profile = profileOf()
      const conn = deriveConnection(status, profile)
      set({ connection: conn })
      if (conn.status === 'connected') {
        startLive()
        await fetchAll()
        void statsTick?.()
        void sysTick?.()
        void gpuTick?.()
      } else stopLive()
    }

    return {
      connection: { status: 'connecting' },
      profiles: [],
      activeProfileId: api.connection.activeId(),
      containers: emptyEntity(),
      images: emptyEntity(),
      volumes: emptyEntity(),
      networks: emptyEntity(),
      stats: {},
      system: null,
      gpu: [],
      rowOps: {},
      polling: readPoll,

      async bootstrap() {
        const gen = ++generation
        set({ connection: { status: 'connecting' } })
        const profiles = await api.connection.profiles()
        if (gen !== generation) return
        set({ profiles, activeProfileId: api.connection.activeId() })
        const status = await api.connection.status()
        if (gen !== generation) return
        await connect(status)
        applyPolling(get().polling)
      },
      dispose() {
        generation++
        stopLive()
        applyPolling(false)
      },
      async retry() {
        const cur = get().connection
        const wasLost = cur.status === 'lost'
        set({ connection: wasLost ? cur : { status: 'connecting' } })
        const status = await api.connection.reconnect()
        const conn = deriveConnection(status, profileOf())
        if (conn.status === 'connected') {
          await connect(status)
          toast.ok(`Reconectado con ${profileOf().name}`, { sub: profileOf().version || undefined })
        } else {
          // Estando «lost» se conservan la conexión perdida y la lista (no se sustituye por «error» perdiendo los datos).
          if (!wasLost) set({ connection: conn })
          toast.err('Sigue sin conectar', { sub: 'El diagnóstico no ha cambiado.' })
        }
      },
      async selectProfile(id) {
        const target = get().profiles.find((p) => p.id === id)
        if (!target) return
        try {
          const status = await api.connection.select(id)
          generation++
          set({ activeProfileId: id, containers: emptyEntity(), images: emptyEntity(), volumes: emptyEntity(), networks: emptyEntity(), stats: {}, system: null, gpu: [], rowOps: {} })
          await connect(status)
          if (get().connection.status === 'connected') toast.ok(`Conectado a ${target.name}`, { sub: target.version || undefined })
          else toast.err(`No se pudo conectar con ${target.name}`, { sub: 'Revisa el diagnóstico en pantalla.' })
        } catch (e) {
          const a = toApiError(e)
          if (a.code === 'not_implemented') toast.warn('Simulado — no conectado aún', { sub: `«${target.name}» es una conexión de ejemplo: la conexión activa no cambia.` })
          else toast.err(`No se pudo conectar con ${target.name}`, { sub: a.message })
        }
      },
      async refresh(kind = 'all') {
        if (kind === 'all') await fetchAll()
        else await fetchKind(kind)
      },
      async runContainerOp(id, op) {
        const c = get().containers.byId[id]
        const name = c ? containerName(c) : id.slice(0, 12)
        if (get().connection.status !== 'connected') return false
        if (get().rowOps[id]?.busy) return false
        set({ rowOps: { ...get().rowOps, [id]: { busy: op, tried: get().rowOps[id]?.tried } } })
        try {
          await api.containers[op](id)
          const { [id]: _drop, ...rest } = get().rowOps
          void _drop
          set({ rowOps: rest })
          await fetchKind('containers')
          toast.ok(`${name} ${op === 'start' ? 'iniciado' : op === 'stop' ? 'detenido' : 'reiniciado'}`)
          return true
        } catch (e) {
          const a = toApiError(e)
          set({ rowOps: { ...get().rowOps, [id]: { error: a.message, tried: true } } })
          toast.err(`No se pudo ${op === 'start' ? 'iniciar' : op === 'stop' ? 'detener' : 'reiniciar'} ${name}`, { sub: a.message })
          return false
        }
      },
      async runContainerOps(ids, op, o = {}) {
        const uniq = [...new Set(ids)]
        const failed: { id: string; error: ApiError }[] = []
        let ok = 0
        if (get().connection.status !== 'connected' || !uniq.length) return { ok, failed }
        const conc = Math.max(1, Math.min(o.concurrency ?? 6, 32))
        const verbs = { start: ['iniciado', 'iniciar', 'iniciados'], stop: ['detenido', 'detener', 'detenidos'], restart: ['reiniciado', 'reiniciar', 'reiniciados'] }[op]
        const queue = uniq.filter((id) => !get().rowOps[id]?.busy)
        const setOp = (id: string, v: RowOp | null) => {
          const rest = { ...get().rowOps }
          if (v) rest[id] = v
          else delete rest[id]
          set({ rowOps: rest })
        }
        const worker = async () => {
          for (;;) {
            const id = queue.shift()
            if (id === undefined) return
            setOp(id, { busy: op, tried: get().rowOps[id]?.tried })
            try {
              await api.containers[op](id)
              setOp(id, null)
              ok++
            } catch (e) {
              const err = toApiError(e)
              setOp(id, { error: err.message, tried: true })
              failed.push({ id, error: err })
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, worker))
        await fetchKind('containers') // UN solo refresco
        const first = failed[0]
        if (!failed.length) toast.ok(ok === 1 ? `1 contenedor ${verbs[0]}` : `${ok} contenedores ${verbs[2]}`)
        else if (ok) toast.warn(`${ok} ${verbs[2]}, ${failed.length} con error`, { sub: first.error.message })
        else toast.err(`No se pudo ${verbs[1]} ${failed.length === 1 ? 'el contenedor' : `${failed.length} contenedores`}`, { sub: first.error.message })
        return { ok, failed }
      },
      setRowBusy(id, busy) {
        const rest = { ...get().rowOps }
        if (busy) rest[id] = { ...rest[id], busy, error: undefined }
        else if (rest[id]) {
          const { busy: _b, ...others } = rest[id]
          void _b
          if (Object.keys(others).length) rest[id] = others
          else delete rest[id]
        }
        set({ rowOps: rest })
      },
      clearRowError(id) {
        const rest = { ...get().rowOps }
        if (rest[id]) rest[id] = { ...rest[id], error: undefined }
        set({ rowOps: rest })
      },
      previewConnection(kind) {
        if (!kind) {
          void get().bootstrap()
          return
        }
        if (kind === 'lost') {
          get().markLost()
          return
        }
        const profiles = get().profiles
        const remote = profiles.find((p) => p.kind !== 'local')
        const base = profileOf()
        const profile = kind === 'ssh' ? (remote ?? base) : base.kind === 'local' ? base : { ...base, kind: 'local' as const, remote: false, target: 'unix:///var/run/docker.sock' }
        const failed: Extract<ConnectionStatus, { state: 'failed' }> = {
          state: 'failed', endpoint: profile.target, cause: kind === 'permission' ? 'permission_denied' : kind === 'daemon' ? 'daemon_down' : 'other', message: '(vista previa)',
          steps: kind === 'permission'
            ? [{ id: 'socket', status: 'ok', detail: '' }, { id: 'permissions', status: 'fail', detail: 'permission denied' }, { id: 'daemon', status: 'skipped', detail: '' }]
            : kind === 'daemon'
              ? [{ id: 'socket', status: 'fail', detail: 'connection refused' }, { id: 'permissions', status: 'skipped', detail: '' }, { id: 'daemon', status: 'fail', detail: 'connection refused' }]
              : [],
        }
        set({ connection: deriveConnection(failed, profile) })
      },
      markLost() {
        const cur = get().connection
        if (cur.status === 'connected') set({ connection: { status: 'lost', since: Date.now(), info: cur.info as EngineInfo, endpoint: cur.endpoint } })
      },
      setPolling(on) {
        set({ polling: on })
        try { storage?.setItem(POLL_KEY, on ? '1' : '0') } catch { /* sin storage */ }
        applyPolling(on)
      },
    }
  })
  return store
}
