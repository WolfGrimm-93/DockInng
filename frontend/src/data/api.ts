// INTERFAZ ÚNICA DE ACCESO A DATOS. La UI solo conoce `EngineApi` (nunca `invoke` ni Docker).
// Hay dos adaptadores: `adapters/tauri` (real donde el backend ya expone el comando, simulado en el
// resto) y `adapters/sim` (mundo simulado completo en memoria, para el navegador/Vite y los tests).
// Selección: `createEngineApi()` (isTauri()). Firma de cada método = comando IPC de PLAN_backend §4.3.
import type {
  ActionOutcome, ActionPlan, ActionRequest, ConnSpec, ConnectionProfile, ConnectionStatus, Container,
  ContainerDetail, ContainerStats, CreateSpec, EngineFeed, GpuInfo, Image, LogFeed, Network, PullProgress,
  StackSummary, StatsSnapshotItem, SystemUsage, TerminalSession, Unsubscribe, UpProgress, Volume,
} from './types'

export type Feature =
  | 'connection' | 'containers' | 'images' | 'volumes' | 'networks' | 'actions' | 'events' | 'logs' | 'stats' | 'inspect' | 'system'
  | 'exec' | 'pull' | 'create' | 'stacks' | 'connections'
/** 'simulated' => la UI muestra <SimulatedTag/> «No conectado aún». */
export type Capability = 'live' | 'simulated'

export interface EngineApi {
  readonly mode: 'tauri' | 'browser'
  readonly capabilities: Record<Feature, Capability>

  connection: {
    /** `connection_status`: nunca lanza; los fallos vienen como `state:'failed'`. */
    status(): Promise<ConnectionStatus>
    /** `reconnect`. */
    reconnect(): Promise<ConnectionStatus>
    profiles(): Promise<ConnectionProfile[]>
    activeId(): string
    /** Cambia de conexión activa. En modo tauri solo «local» es real: las demás se simulan (D6: solo toast). */
    select(id: string): Promise<ConnectionStatus>
  }
  containers: {
    list(all?: boolean): Promise<Container[]>
    inspect(id: string): Promise<ContainerDetail>
    start(id: string): Promise<void>
    stop(id: string): Promise<void>
    restart(id: string): Promise<void>
    /** Una muestra por contenedor (tabla: CPU/Memoria). Tauri lo compone con subscribe_stats (máx. 12 ids); el simulado lo calcula. */
    statsSnapshot(ids: string[]): Promise<StatsSnapshotItem[]>
    /** `subscribe_logs`. `on` recibe LogFeed (lotes de líneas y el fin del stream). Devuelve la cancelación. */
    streamLogs(id: string, o: { tail: number; follow: boolean }, on: (feed: LogFeed) => void): Unsubscribe
    /** `subscribe_stats`. */
    streamStats(id: string, on: (s: ContainerStats) => void): Unsubscribe
  }
  /** Franja de consumo: `usage` = `system_usage` (CPU/RAM del equipo + disco de Docker); `gpu` = `gpu_status` (nunca lanza: sin GPU => []). */
  system: { usage(): Promise<SystemUsage>; gpu(): Promise<GpuInfo[]> }
  images: { list(): Promise<Image[]> }
  volumes: { list(): Promise<Volume[]> }
  networks: { list(): Promise<Network[]> }
  /** Política: el frontend NUNCA calcula la decisión. plan -> (diálogo) -> execute. */
  actions: {
    plan(request: ActionRequest): Promise<ActionPlan>
    execute(ticket: string, typed?: string | null): Promise<ActionOutcome>
    cancel(ticket: string): Promise<void>
  }
  /** `subscribe_engine_events` (incluye cambios de conexión). */
  events: { subscribe(on: (feed: EngineFeed) => void): Unsubscribe }

  // ---- NO conectados aún: simulados en ambos modos (capabilities = 'simulated') ----
  exec: { open(containerId: string): TerminalSession }
  pull: { start(ref: string, on: (p: PullProgress) => void): Unsubscribe } // cancelar = Unsubscribe
  create: { submit(spec: CreateSpec, mode: 'start' | 'only'): Promise<{ simulated: true; name: string }> }
  stacks: {
    list(): Promise<StackSummary[]>
    up(name: string, on: (p: UpProgress) => void): Unsubscribe
    down(name: string): Promise<void>
    restart(name: string): Promise<void>
    read(name: string): Promise<{ yaml: string; env: string; path: string }>
    save(name: string, f: { yaml: string; env: string }): Promise<void>
    composeAvailable(): Promise<boolean>
  }
  connections: { test(spec: ConnSpec): Promise<'ok' | 'fail'>; save(spec: ConnSpec): Promise<ConnectionProfile> }
}
