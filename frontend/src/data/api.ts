// INTERFAZ ÚNICA DE ACCESO A DATOS. La UI solo conoce `EngineApi` (nunca `invoke` ni Docker).
// Hay dos adaptadores: `adapters/tauri` (real; solo `connections` sigue simulado hasta la Ola 2) y `adapters/sim` (mundo simulado completo en memoria, para el navegador/Vite y los tests).
// Selección: `createEngineApi()` (isTauri()). Firma de cada método = comando IPC de PLAN_backend §4.3.
import type {
  ActionOutcome, ActionPlan, ActionRequest, ComposeInfo, ConnSpec, ConnectionProfile, ConnectionStatus, Container,
  ContainerDetail, ContainerStats, CreateContainerSpec, CreateNetworkSpec, CreatePlan, CreateResult, CreateVolumeSpec, EngineFeed,
  ExecOptions, ExecSession, GpuInfo, Image, LogFeed, Network, PullFeed, StackFiles, StackOpFeed, StackOpRequest, StackSummary,
  StackValidation, StatsSnapshotItem, SystemUsage, Unsubscribe, Volume,
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
    /** `plan_create_container`: valida (errores por campo), avisa de riesgos y, si hace falta confirmar, emite el ticket. Nunca crea nada. */
    planCreate(spec: CreateContainerSpec): Promise<CreatePlan>
    /** `create_container`. NUNCA descarga la imagen: si falta lanza `image_missing` (la UI enruta al pull). `ticket` solo si el plan lo exigió. */
    create(spec: CreateContainerSpec, start: boolean, ticket: string | null): Promise<CreateResult>
  }
  /** Franja de consumo: `usage` = `system_usage` (CPU/RAM del equipo + disco de Docker); `gpu` = `gpu_status` (nunca lanza: sin GPU => []). */
  system: { usage(): Promise<SystemUsage>; gpu(): Promise<GpuInfo[]> }
  images: {
    list(): Promise<Image[]>
    /** `subscribe_pull`. Cancelar = el `Unsubscribe` (aborta la descarga en el daemon; no hay `ended` tras un abort). */
    pull(reference: string, on: (f: PullFeed) => void): Unsubscribe
  }
  volumes: { list(): Promise<Volume[]>; /** `create_volume` (driver local; Conflict si ya existe). */ create(spec: CreateVolumeSpec): Promise<Volume> }
  networks: { list(): Promise<Network[]>; /** `create_network` (bridge; Conflict si ya existe). */ create(spec: CreateNetworkSpec): Promise<Network> }
  /** Política: el frontend NUNCA calcula la decisión. plan -> (diálogo) -> execute. */
  actions: {
    plan(request: ActionRequest): Promise<ActionPlan>
    execute(ticket: string, typed?: string | null): Promise<ActionOutcome>
    cancel(ticket: string): Promise<void>
  }
  /** `subscribe_engine_events` (incluye cambios de conexión). */
  events: { subscribe(on: (feed: EngineFeed) => void): Unsubscribe }

  /** `subscribe_exec` + `exec_write/resize/close`. Async: falla con `conflict` si el contenedor no está en ejecución. */
  exec: { open(containerId: string, o: ExecOptions): Promise<ExecSession> }
  stacks: {
    /** `compose_info`. `recheck` fuerza a saltarse la caché de 60 s del backend («Volver a comprobar»). */
    composeInfo(recheck?: boolean): Promise<ComposeInfo>
    /** `list_stacks`: NO requiere Compose instalado (descubre por etiquetas). Es la fuente única del contador del menú. */
    list(): Promise<StackSummary[]>
    /** `run_stack_op` (up/restart/stop/start/pull). `cancel()` = cancelación limpia (llega `ended: canceled`); `dispose()` = abort duro. */
    runOp(name: string, op: StackOpRequest, on: (f: StackOpFeed) => void): { cancel(): void; dispose(): void }
    /** `stack_read`. */
    read(name: string): Promise<StackFiles>
    /** `stack_save` (solo managed/linked; `state_changed` si `expectedRevision` ya no coincide). */
    save(name: string, f: { yaml: string; env: string; expectedRevision: string | null }): Promise<StackFiles>
    /** `stack_validate` (`compose config` sobre temporales; nunca escribe en el stack). */
    validate(name: string | null, yaml: string, env: string): Promise<StackValidation>
    /** `stack_create` (stack propio nuevo). */
    create(name: string, yaml: string, env: string): Promise<StackSummary>
    /** `stack_link` (registra un compose existente por ruta absoluta). */
    link(path: string): Promise<StackSummary>
    /** `stack_unlink` (no borra los archivos del usuario). */
    unlink(name: string): Promise<void>
  }
  // `stack_down` y `stack_delete` NO están aquí: pasan por actions.plan -> execute (confirmación escrita).
  connections: { test(spec: ConnSpec): Promise<'ok' | 'fail'>; save(spec: ConnSpec): Promise<ConnectionProfile> }
}
