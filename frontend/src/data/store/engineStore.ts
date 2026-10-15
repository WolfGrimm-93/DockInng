// STORE NORMALIZADO del motor (zustand vanilla: usable dentro y fuera de React, testeable sin DOM).
// Contrato público:
//   createEngineStore(api, opts?) -> EngineStore   (getState()/subscribe()/setState de zustand)
//   Estado:  connection · profiles · activeProfileId · containers/images/volumes/networks/stacks (Entity) · compose · stackOps · pulls · stats · rowOps · polling
//   Ola 1: `stacks` es la FUENTE ÚNICA (página, cabecera y contador del menú); `stackOps[proyecto]` y `pulls[referencia]` sobreviven a la navegación;
//          runStackOp/cancelStackOp/dismissStackOp/noteStackDown · startPull/cancelPull/dismissPull · checkCompose. La política (confirmación de bajar/borrar) NO vive aquí.
//   Ola 2: `retainStats()` (los consumidores de CPU/RAM/GPU/disco la llaman al montar; sin consumidores NO se muestrea) · `refreshProfiles()`.
//          Ritmo de stats: solo con consumidor, en pausa con la ventana oculta, ≥ slowStatsMs tras BLUR_GRACE_MS sin foco y refresco inmediato al volver.
//   Acciones (getState().x): bootstrap() · dispose() · retry() · selectProfile(id) · refresh(kind?) · runContainerOp(id, op) · runContainerOps(ids, op, {concurrency})
//                            setRowBusy(id, busy?) · clearRowError(id) · markLost() · setPolling(on)
// Flujo (PLAN_frontend §2.5): bootstrap -> connection_status; si conectado -> 4 list() en paralelo + events.subscribe + stats.
// Evento de contenedor => invalidate + refetch en lote (debounce 150 ms); destroy elimina al instante. Eventos de
// imagen/volumen/red => refetch de esa colección (300 ms). Conexión perdida => se CONSERVAN los datos y las acciones se bloquean.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { buildDiagnostic, connectionFailText } from '../diagnostics'
import type { EngineApi } from '../api'
import { toApiError } from '../errors'
import { safeStorage } from '@/lib/safeStorage'
import { installWindowActivity, isIdle, onWake } from '@/lib/windowActivity'
import { toast } from '@/lib/toastStore'
import type { PrefKey } from '../types'
import type {
  ApiError, ComposeInfo, ConnectionIssue, ConnectionProfile, ConnectionState, ConnectionStatus, Container, ContainerBusy, ContainerStats, EngineFeed, EngineInfo,
  Image, Network, PullFeed, PullOp, StackOpFeed, StackOpState, StackSummary, Unsubscribe, Volume, GpuInfo, SystemUsage } from '../types'
import { planRefresh } from './eventReducer'

export interface Entity<T> {
  byId: Record<string, T>
  ids: string[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: ApiError
  updatedAt?: number
}
/** `failedOp`: la operación que falló, para que «Reintentar» repita esa misma (no un arranque). */
export interface RowOp { busy?: ContainerBusy; error?: string; tried?: boolean; failedOp?: 'start' | 'stop' | 'restart' }
export type EntityKind = 'containers' | 'images' | 'volumes' | 'networks' | 'stacks'
/** Máximo de líneas de la salida de docker compose que se conservan por operación. */
export const STACK_LOG_LIMIT = 300

export interface EngineStoreState {
  connection: ConnectionState
  profiles: ConnectionProfile[]
  activeProfileId: string
  /** Id de la conexión a la que se está cambiando (spinner del selector; null = ninguno). */
  switchingProfileId: string | null
  containers: Entity<Container>
  images: Entity<Image>
  volumes: Entity<Volume>
  networks: Entity<Network>
  /** Stacks Compose (list_stacks): NO depende de que Compose esté instalado. */
  stacks: Entity<StackSummary>
  /** Estado de Docker Compose; null = aún no comprobado. */
  compose: ComposeInfo | null
  /** Operaciones up/restart por proyecto (sobreviven a la navegación). */
  stackOps: Record<string, StackOpState>
  /** Descargas de imagen por referencia (sobreviven a la navegación). */
  pulls: Record<string, PullOp>
  stats: Record<string, ContainerStats>
  /** Recursos del equipo y disco de Docker (se refresca cada ~60 s); null = aún no cargado. */
  system: SystemUsage | null
  /** GPU del equipo (se refresca con el muestreo de stats); vacío = sin GPU detectada. */
  gpu: GpuInfo[]
  rowOps: Record<string, RowOp>
  polling: boolean
  /** Las muestras de `stats`/GPU son antiguas (se acaba de volver a consumirlas): la UI las atenúa hasta que llegue la nueva. */
  statsStale: boolean

  bootstrap(): Promise<void>
  dispose(): void
  retry(): Promise<void>
  selectProfile(id: string): Promise<void>
  /** Relee `connection_list` (tras guardar/borrar una conexión). */
  refreshProfiles(): Promise<void>
  /** Un consumidor de stats/GPU/disco (Contenedores, franja de consumo) declara que las necesita. Devuelve la baja; idempotente. */
  retainStats(): () => void
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

  /** `recheck` salta la caché del backend (botón «Volver a comprobar»). */
  checkCompose(recheck?: boolean): Promise<boolean>
  /** Levanta/reinicia un stack con progreso en vivo. Ignora la petición si ya hay una operación en curso para ese proyecto. */
  runStackOp(project: string, kind: 'up' | 'restart' | 'stop' | 'start' | 'pull'): void
  /** Cancelación limpia (SIGTERM): llega `ended: canceled`; el estado puede haber quedado a medias. */
  cancelStackOp(project: string): void
  dismissStackOp(project: string): void
  /** Tras un `stack_down` ejecutado por la política: limpia la operación y refresca. */
  noteStackDown(project: string): void
  startPull(reference: string): void
  cancelPull(reference: string): void
  dismissPull(reference: string): void
}
export type EngineStore = StoreApi<EngineStoreState>

export interface EngineStoreOptions {
  /** ms de muestreo de CPU/Mem (0 = apagado; por defecto 4000). */
  statsIntervalMs?: number
  /** ms de debounce de eventos (por defecto 150 contenedores / 300 resto). */
  debounce?: { containers?: number; others?: number }
  /** ms mínimos entre dos listados del mismo tipo (por defecto 400). Acota los refrescos durante una acción masiva. */
  minRefreshGapMs?: number
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** ms mínimos entre muestreos con la ventana sin foco (por defecto 8000). */
  slowStatsMs?: number
  /** false = muestrea siempre (sin exigir consumidores; tests/CLI). Por defecto true. */
  requireStatsConsumer?: boolean
}

/** B-10: «Local» siempre existe en la lista (si `connection_list` falla o no lo trae, se sintetiza) para poder volver desde un remoto. */
const LOCAL_PROFILE: ConnectionProfile = { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: '', simulated: false }
export const withLocal = (list: ConnectionProfile[]): ConnectionProfile[] => (list.some((p) => p.id === 'local') ? list : [LOCAL_PROFILE, ...list])

const emptyEntity = <T,>(): Entity<T> => ({ byId: {}, ids: [], status: 'idle' })

/** Igualdad de dos muestras ignorando `read_at` (la hora cambia siempre; lo que se pinta son los valores). */
export function sameStatsValues(a: ContainerStats, b: ContainerStats): boolean {
  return a.cpu_percent === b.cpu_percent && a.mem_used_bytes === b.mem_used_bytes && a.mem_limit_bytes === b.mem_limit_bytes && a.mem_percent === b.mem_percent
    && a.net_rx_bytes === b.net_rx_bytes && a.net_tx_bytes === b.net_tx_bytes && a.net_rx_bytes_per_sec === b.net_rx_bytes_per_sec
    && a.net_tx_bytes_per_sec === b.net_tx_bytes_per_sec && a.block_read_bytes === b.block_read_bytes && a.block_write_bytes === b.block_write_bytes && a.pids === b.pids
}

/**
 * Mezcla las muestras nuevas conservando la IDENTIDAD de los objetos cuyos valores no cambiaron (las filas memoizadas no se repintan).
 * Devuelve `null` si no cambió nada (mismos ids y mismos valores): el store no debe notificar.
 */
export function mergeStats(prev: Record<string, ContainerStats>, next: Record<string, ContainerStats>): Record<string, ContainerStats> | null {
  const nextIds = Object.keys(next)
  let changed = nextIds.length !== Object.keys(prev).length
  const out: Record<string, ContainerStats> = {}
  for (const id of nextIds) {
    const p = prev[id]
    if (p && sameStatsValues(p, next[id])) out[id] = p
    else { out[id] = next[id]; changed = true }
  }
  return changed ? out : null
}
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

/**
 * Guarda una preferencia en el almacén del backend. Si falla, avisa sin bloquear: la app sigue con el valor en memoria,
 * pero el usuario debe saber que no se conservará al reiniciar (antes el fallo se silenciaba).
 */
function guardarPref(api: EngineApi, clave: PrefKey, valor: unknown): void {
  api.prefs.set(clave, valor).catch((e) => {
    toast.warn('No se pudo guardar una preferencia', { sub: `«${clave}»: ${toApiError(e).message}` })
  })
}

export function createEngineStore(api: EngineApi, opts: EngineStoreOptions = {}): EngineStore {
  const statsMs = opts.statsIntervalMs ?? 4000
  const dContainers = opts.debounce?.containers ?? 150
  const dOthers = opts.debounce?.others ?? 300
  const storage = opts.storage === undefined ? safeStorage() : opts.storage

  let unsubEvents: Unsubscribe | null = null
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let statsTick: ((force?: boolean) => Promise<void>) | null = null
  let sysTimer: ReturnType<typeof setInterval> | null = null
  let sysTick: ((force?: boolean) => Promise<void>) | null = null
  let gpuTick: ((force?: boolean) => Promise<void>) | null = null
  let unsubWake: (() => void) | null = null
  let consumers = 0 // consumidores de stats (retainStats)
  let lastStatsAt = 0
  let lastGpuAt = 0
  let lastSysAt = 0
  const slowMs = opts.slowStatsMs ?? 8000
  const needStats = () => opts.requireStatsConsumer === false || consumers > 0
  /** Con la ventana inactiva se muestrea como mucho cada `slowMs`; con foco, en cada tick. */
  /** B-8: si la última muestra es vieja (más de 3 ciclos) se marca obsoleta hasta que llegue la nueva. */
  const markStaleIfOld = () => {
    if (lastStatsAt > 0 && statsMs > 0 && Date.now() - lastStatsAt > 3 * statsMs && Object.keys(store.getState().stats).length) store.setState({ statsStale: true })
  }
  const due = (last: number) => !isIdle() || Date.now() - last >= slowMs
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const timers: Partial<Record<EntityKind, ReturnType<typeof setTimeout>>> = {}
  const minGap = opts.minRefreshGapMs ?? 400
  const lastFetchAt: Partial<Record<EntityKind, number>> = {}
  const opHandles = new Map<string, { cancel(): void; dispose(): void }>()
  const pullHandles = new Map<string, Unsubscribe>()
  let generation = 0 // invalida respuestas tardías tras dispose()/cambio de conexión

  let readPoll = false
  try { readPoll = storage?.getItem(POLL_KEY) === '1' } catch { /* sin storage */ }

  const store: EngineStore = createStore<EngineStoreState>((set, get) => {
    const profileOf = (): ConnectionProfile =>
      get().profiles.find((p) => p.id === get().activeProfileId) ??
      { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: '', simulated: false }

    const fetchKind = async (kind: EntityKind): Promise<void> => {
      const gen = generation
      lastFetchAt[kind] = Date.now()
      const cur = get()[kind]
      if (cur.status === 'idle') set({ [kind]: { ...cur, status: 'loading' } } as Partial<EngineStoreState>)
      try {
        let next: Entity<Container> | Entity<Image> | Entity<Volume> | Entity<Network> | Entity<StackSummary>
        if (kind === 'stacks') next = toEntity(await api.stacks.list(), (x) => x.name)
        else if (kind === 'containers') next = toEntity(await api.containers.list(true), (c) => c.id)
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
      await Promise.all((['containers', 'images', 'volumes', 'networks', 'stacks'] as const).map(fetchKind))
    }
    // Un evento que llega con el temporizador ya armado se ignora (una sola pasada pendiente). Además, dos listados del
    // mismo tipo nunca quedan a menos de `minGap` ms: una acción masiva emite ráfagas largas y, sin este límite, cada
    // 150 ms dispararía un listado completo de todos los contenedores.
    const schedule = (kind: EntityKind, ms: number) => {
      if (timers[kind]) return
      const wait = Math.max(ms, (lastFetchAt[kind] ?? 0) + minGap - Date.now())
      timers[kind] = setTimeout(() => {
        timers[kind] = undefined
        void fetchKind(kind)
      }, wait)
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
        if (p.stacks) schedule('stacks', dContainers)
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
      unsubWake?.()
      unsubWake = null
      for (const k of Object.keys(timers) as EntityKind[]) {
        if (timers[k]) clearTimeout(timers[k])
        timers[k] = undefined
      }
    }
    const startLive = () => {
      stopLive()
      unsubEvents = api.events.subscribe(applyFeed)
      installWindowActivity()
      if (statsMs > 0) {
        let inFlight = false // un único vuelo: si el muestreo anterior sigue en curso no se lanza otro
        const tick = async (force = false) => {
          if (inFlight || get().connection.status !== 'connected') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          // Solo se muestrea si alguna vista lo consume y, con la ventana inactiva, a ritmo lento (salvo refresco forzado al volver).
          if (!needStats() || (!force && !due(lastStatsAt))) return
          const ids = get().containers.ids.filter((id) => get().containers.byId[id]?.state === 'running').slice(0, 64)
          if (!ids.length) return
          const gen = generation
          inFlight = true
          lastStatsAt = Date.now()
          try {
            const rows = await api.containers.statsSnapshot(ids)
            if (gen !== generation) return
            const stats: Record<string, ContainerStats> = {}
            for (const r of rows) if (r.stats) stats[r.id] = r.stats
            // Conserva la identidad de lo que no cambió y no notifica si nada cambió.
            const merged = mergeStats(get().stats, stats)
            if (merged) set({ stats: merged, statsStale: false })
            else if (get().statsStale) set({ statsStale: false })
          } catch { /* el muestreo es opcional: la tabla muestra «—» */ } finally { inFlight = false }
        }
        // El primer muestreo lo lanza connect() DESPUÉS de fetchAll (la lista de contenedores ya existe).
        statsTick = tick

        // GPU del equipo: misma política que las stats, un único vuelo y sin error visible (sin GPU => []).
        let gpuBusy = false
        gpuTick = async (force = false) => {
          if (gpuBusy || get().connection.status !== 'connected') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (!needStats() || (!force && !due(lastGpuAt))) return
          const gen = generation
          gpuBusy = true
          lastGpuAt = Date.now()
          try {
            const gpu = await api.system.gpu()
            const next = Array.isArray(gpu) ? gpu : []
            if (gen === generation && JSON.stringify(next) !== JSON.stringify(get().gpu)) set({ gpu: next })
          } catch { /* opcional */ } finally { gpuBusy = false }
        }
        statsTimer = setInterval(() => { void tick(); void gpuTick?.() }, statsMs)
      }

      // Recursos del equipo y disco de Docker: `df` es pesado, se pide cada 60 s (y tras cada conexión) y solo si alguien lo consume.
      let sysBusy = false
      const stick = async (force = false) => {
        if (sysBusy || get().connection.status !== 'connected') return
        if (!needStats() && !force) return
        const gen = generation
        sysBusy = true
        lastSysAt = Date.now()
        try {
          const system = await api.system.usage()
          if (gen === generation && system && typeof system === 'object') set({ system })
        } catch { /* opcional: la franja muestra «—» */ } finally { sysBusy = false }
      }
      sysTick = stick
      sysTimer = setInterval(() => { if (typeof document === 'undefined' || (document.visibilityState !== 'hidden' && !isIdle())) void stick() }, 60_000)
      // Al recuperar foco/visibilidad tras un periodo inactivo: refresco inmediato (si alguna vista lo consume).
      unsubWake = onWake(() => {
        if (!needStats()) return
        markStaleIfOld()
        void statsTick?.(true)
        void gpuTick?.(true)
        void sysTick?.(true)
      })
    }
    // Aborta (duro) los Channels abiertos de operaciones de stack y descargas.
    const abortAll = () => {
      for (const h of opHandles.values()) h.dispose()
      opHandles.clear()
      for (const u of pullHandles.values()) u()
      pullHandles.clear()
    }
    const patchOp = (project: string, patch: Partial<StackOpState>) => {
      const cur = get().stackOps[project]
      if (cur) set({ stackOps: { ...get().stackOps, [project]: { ...cur, ...patch } } })
    }
    const patchPull = (ref: string, patch: Partial<PullOp>) => {
      const cur = get().pulls[ref]
      if (cur) set({ pulls: { ...get().pulls, [ref]: { ...cur, ...patch } } })
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
        void get().checkCompose()
        await fetchAll()
        void statsTick?.()
        void sysTick?.()
        void gpuTick?.()
      } else stopLive()
    }

    /** Cambio de conexión (el estado `switchingProfileId` lo gestiona la acción). */
    const switchTo = async (id: string, target: ConnectionProfile): Promise<void> => {
      // En Tauri, al fallar el cambio el backend deja el motor en el destino previo (pero ya abortó los streams): no se cambia de
      // conexión en la UI y se reanuda la conexión previa. En el simulado (navegador) se activa el perfil para enseñar su diagnóstico.
      // M-1: `quiesced:true` (solo aparece con ese valor) = el backend YA abortó suscripciones/terminales/tickets antes de fallar: se abortan
      // también las operaciones locales y se reabren los streams. Sin el campo, el backend no tocó nada: NO se aborta nada (stackOps/pulls siguen vivos).
      const resumePrevious = async (quiesced: boolean | undefined) => {
        if (quiesced !== true) return
        generation++
        abortAll()
        await connect(await api.connection.status())
      }
      try {
        const status = await api.connections.select(id)
        if (status.state === 'failed' && api.mode === 'tauri' && id !== 'local') {
          toast.err(`No se pudo conectar con ${target.name}`, { sub: connectionFailText(status.cause, status.message) })
          return
        }
        generation++
        abortAll()
        set({ activeProfileId: id, containers: emptyEntity(), images: emptyEntity(), volumes: emptyEntity(), networks: emptyEntity(), stacks: emptyEntity(), compose: null, stackOps: {}, pulls: {}, stats: {}, system: null, gpu: [], rowOps: {} })
        lastStatsAt = 0; lastGpuAt = 0; lastSysAt = 0
        await connect(status)
        if (get().connection.status === 'connected') {
          toast.ok(`Conectado a ${target.name}`, { sub: target.version || undefined })
          guardarPref(api, 'last_connection_id', id)
        } else toast.err(`No se pudo conectar con ${target.name}`, { sub: 'Revisa el diagnóstico en pantalla.' })
      } catch (e) {
        const a = toApiError(e)
        toast.err(`No se pudo conectar con ${target.name}`, { sub: connectionFailText(a.cause ?? null, a.message) })
        if (api.mode === 'tauri') await resumePrevious(a.quiesced).catch(() => undefined)
      }
    }

    return {
      connection: { status: 'connecting' },
      profiles: [],
      activeProfileId: api.connection.activeId(),
      switchingProfileId: null,
      containers: emptyEntity(),
      images: emptyEntity(),
      volumes: emptyEntity(),
      networks: emptyEntity(),
      stacks: emptyEntity(),
      compose: null,
      stackOps: {},
      pulls: {},
      stats: {},
      system: null,
      gpu: [],
      rowOps: {},
      polling: readPoll,
      statsStale: false,

      async bootstrap() {
        const gen = ++generation
        set({ connection: { status: 'connecting' } })
        const profiles = withLocal(await api.connections.list().catch(() => [] as ConnectionProfile[]))
        if (gen !== generation) return
        set({ profiles, activeProfileId: api.connection.activeId() })
        // Preferencia guardada en el almacén del backend (fuente de verdad); si nunca se guardó, se migra la de localStorage.
        try {
          const p = await api.prefs.get('polling')
          if (gen !== generation) return
          if (typeof p === 'boolean') set({ polling: p })
          else if (get().polling) guardarPref(api, 'polling', true)
        } catch { /* sin almacén: vale localStorage */ }
        const status = await api.connection.status()
        if (gen !== generation) return
        await connect(status)
        applyPolling(get().polling)
      },
      dispose() {
        generation++
        stopLive()
        applyPolling(false)
        abortAll()
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
      async refreshProfiles() {
        try { set({ profiles: withLocal(await api.connections.list()), activeProfileId: api.connection.activeId() }) } catch { set({ profiles: withLocal(get().profiles) }) }
      },
      retainStats() {
        consumers++
        if (consumers === 1) {
          markStaleIfOld()
          // Primer consumidor: muestreo inmediato (la lista y la conexión pueden no estar listas: entonces lo lanza connect()).
          void statsTick?.(true)
          void gpuTick?.(true)
          if (!get().system || Date.now() - lastSysAt > 30_000) void sysTick?.(true)
        }
        let released = false
        return () => {
          if (released) return
          released = true
          consumers = Math.max(0, consumers - 1)
        }
      },
      async selectProfile(id) {
        const target = get().profiles.find((p) => p.id === id)
        if (!target || get().switchingProfileId) return
        set({ switchingProfileId: id })
        try { await switchTo(id, target) } finally { set({ switchingProfileId: null }) }
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
          set({ rowOps: { ...get().rowOps, [id]: { error: a.message, tried: true, failedOp: op } } })
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
      async checkCompose(recheck = false) {
        const gen = generation
        try {
          const info = await api.stacks.composeInfo(recheck)
          if (gen === generation) set({ compose: info })
          return info.available && info.supported
        } catch {
          // Si el comando falla se trata como «no comprobado»: la página lo reintenta con «Reintentar».
          if (gen === generation) set({ compose: { available: false, flavor: 'missing', version: null, supported: false, docker_cli: false } })
          return false
        }
      },
      runStackOp(project, kind) {
        if (get().connection.status !== 'connected' || get().stackOps[project]?.state === 'running') return
        const label = { up: 'levantado', restart: 'reiniciado', stop: 'detenido', start: 'iniciado', pull: 'con imágenes actualizadas' }[kind]
        set({ stackOps: { ...get().stackOps, [project]: { kind, state: 'running', services: [], log: [], error: null, issues: [], startedAt: Date.now() } } })
        const gen = generation
        const onFeed = (f: StackOpFeed) => {
          if (gen !== generation) return
          if (f.type === 'progress') patchOp(project, { services: f.services })
          else if (f.type === 'log') {
            const cur = get().stackOps[project]
            if (cur) patchOp(project, { log: [...cur.log, f.text].slice(-STACK_LOG_LIMIT) })
          } else if (f.type === 'ended') {
            opHandles.delete(project)
            if (f.outcome === 'success') {
              const cur = get().stackOps[project]
              patchOp(project, { state: 'done', services: cur ? cur.services.map((s) => ({ ...s, percent: 100, phase: 'started' as const })) : [] })
              toast.ok(`Stack ${project} ${label}`)
            } else if (f.outcome === 'canceled') {
              patchOp(project, { state: 'canceled' })
              toast.warn(`Operación sobre ${project} cancelada`, { sub: 'Puede haber quedado a medias: revisa los servicios.' })
            } else {
              patchOp(project, { state: 'error', error: f.error ?? { code: 'compose_failed', message: f.outcome === 'timeout' ? 'La operación tardó demasiado.' : 'Docker Compose terminó con un error.' }, issues: f.issues })
              toast.err(`No se pudo ${{ up: 'levantar', restart: 'reiniciar', stop: 'detener', start: 'iniciar', pull: 'actualizar las imágenes de' }[kind]} ${project}`, { sub: f.error?.message })
            }
            // Refresco explícito (no depender solo de los eventos del motor).
            void fetchKind('containers')
            void fetchKind('stacks')
          }
        }
        opHandles.set(project, api.stacks.runOp(project, { type: kind }, onFeed))
      },
      cancelStackOp(project) {
        opHandles.get(project)?.cancel()
      },
      dismissStackOp(project) {
        const { [project]: _drop, ...rest } = get().stackOps
        void _drop
        if (get().stackOps[project]?.state === 'running') return
        set({ stackOps: rest })
      },
      noteStackDown(project) {
        const { [project]: _drop, ...rest } = get().stackOps
        void _drop
        set({ stackOps: rest })
        void fetchKind('containers')
        void fetchKind('stacks')
        void fetchKind('volumes')
        void fetchKind('networks')
      },
      startPull(reference) {
        const ref = reference.trim()
        if (!ref || get().connection.status !== 'connected' || get().pulls[ref]?.state === 'pulling') return
        pullHandles.get(ref)?.()
        set({ pulls: { ...get().pulls, [ref]: { reference: ref, state: 'pulling', layers: [], doneBytes: 0, totalBytes: 0, upToDate: false, digest: null, error: null } } })
        const gen = generation
        const onFeed = (f: PullFeed) => {
          if (gen !== generation) return
          if (f.type === 'progress') patchPull(ref, { layers: f.layers, doneBytes: f.done_bytes, totalBytes: f.total_bytes })
          else if (f.type === 'ended') {
            pullHandles.delete(ref)
            if (f.outcome === 'done') {
              patchPull(ref, { state: 'done', upToDate: f.up_to_date, digest: f.digest, layers: get().pulls[ref]?.layers.map((l) => ({ ...l, phase: 'complete' as const, done: l.total })) ?? [] })
              toast.ok(f.up_to_date ? `${ref} ya estaba al día` : `${ref} descargada`)
              void fetchKind('images')
            } else {
              patchPull(ref, { state: 'error', error: f.error ?? { code: 'engine', message: 'La descarga falló.' } })
              toast.err(`No se pudo descargar ${ref}`, { sub: f.error?.message })
            }
          }
        }
        pullHandles.set(ref, api.images.pull(ref, onFeed))
      },
      cancelPull(reference) {
        const ref = reference.trim()
        const u = pullHandles.get(ref)
        if (!u) return
        u()
        pullHandles.delete(ref)
        // Tras un abort duro no hay `ended`: se marca localmente.
        patchPull(ref, { state: 'canceled' })
      },
      dismissPull(reference) {
        const ref = reference.trim()
        if (get().pulls[ref]?.state === 'pulling') return
        const { [ref]: _drop, ...rest } = get().pulls
        void _drop
        set({ pulls: rest })
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
        guardarPref(api, 'polling', on)
        applyPolling(on)
      },
    }
  })
  return store
}
