// TIPOS DE LA CAPA DE DATOS. Espejo de los tipos serde (snake_case) del backend
// (PLAN_backend.md §1, §3.5, §4): la UI recibe listo lo que se pinta y no deriva nada del motor.
// Supuestos donde el backend real puede diferir están marcados con «SUPUESTO IPC».

// ---------------------------------------------------------------- Contenedores
export type ContainerState =
  | 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'stopping' | 'exited' | 'dead' | 'unknown'
/** Los 6 estados visuales de la plantilla (icono + etiqueta propios). */
export type UiStatus = 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'created'
/** Operación en curso sobre una fila (spinner por fila). */
export type ContainerBusy = 'start' | 'stop' | 'restart' | 'remove'

export interface PortMapping { ip: string | null; private_port: number; public_port: number | null; protocol: string }
export interface MountInfo { kind: 'volume' | 'bind' | 'tmpfs' | 'other'; name: string | null; source: string; destination: string; read_write: boolean }

export interface Container {
  id: string // id completo (64 hex)
  names: string[] // sin "/" inicial
  image: string
  image_id: string
  state: ContainerState
  status: string // texto del daemon (inglés): traducir con lib/format.statusTextEs
  created: number // epoch s
  compose_project: string | null
  compose_service: string | null
  ports: PortMapping[]
  mounts: MountInfo[]
  networks: string[]
}

export interface NetworkEndpoint { name: string; ip_address: string | null; gateway: string | null }
export interface ContainerDetail {
  summary: Container
  created_at: string
  ip_address: string | null
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  pid: number | null
  oom_killed: boolean
  restart_count: number
  error: string | null
  tty: boolean
  restart_policy: string | null
  memory_limit_bytes: number | null
  cpu_limit: number | null
  networks: NetworkEndpoint[]
  raw: unknown // JSON de inspect (pestaña Inspeccionar)
}

export interface ContainerStats {
  read_at: string
  cpu_percent: number
  mem_used_bytes: number
  mem_limit_bytes: number
  mem_percent: number
  net_rx_bytes: number
  net_tx_bytes: number
  net_rx_bytes_per_sec: number
  net_tx_bytes_per_sec: number
  block_read_bytes: number
  block_write_bytes: number
  pids: number
}
/** `container_stats_snapshot` (backend): mismo orden que `ids`; `stats` null y `error` con el motivo si falló ese contenedor. */
export interface StatsSnapshotItem { id: string; stats: ContainerStats | null; error: ApiError | null }

// ---------------------------------------------------------------- Recursos
export interface Image {
  id: string // sha256:...
  reference: string // "repo:tag" (o el id si está colgada): lo que se pasa a remove
  repository: string // "<none>" si colgada
  tag: string
  size_bytes: number
  created: number
  containers: number // en uso
  dangling: boolean
}
export interface Volume {
  name: string
  driver: string
  mountpoint: string
  created_at: string | null
  labels: Record<string, string>
  compose_project: string | null
  size_bytes: number | null // null = desconocido
  used_by: string[]
  anonymous: boolean
}
export interface Network {
  id: string
  name: string
  driver: string
  scope: string
  subnets: string[]
  internal: boolean
  system: boolean
  connected: string[]
  compose_project: string | null
}

// ---------------------------------------------------------------- Conexión
export interface EngineInfo { version: string; api_version: string; os: string; arch: string }
export type ConnectionCause = 'socket_missing' | 'permission_denied' | 'daemon_down' | 'other'
export type StepStatus = 'ok' | 'fail' | 'skipped'
export type DiagStepId = 'socket' | 'permissions' | 'daemon'
export interface DiagStepRaw { id: DiagStepId; status: StepStatus; detail: string }
/** Respuesta de `connection_status` / `reconnect` (nunca es un error IPC). */
export type ConnectionStatus =
  | { state: 'connected'; endpoint: string; server: EngineInfo }
  | { state: 'failed'; endpoint: string; cause: ConnectionCause; message: string; steps: DiagStepRaw[] }

/** Perfil de conexión (solo «Local» es real; el resto es simulado en esta ronda). */
export interface ConnectionProfile {
  id: string
  name: string
  target: string // p. ej. unix:///var/run/docker.sock
  kind: 'local' | 'ssh' | 'tls'
  icon: 'monitor' | 'server'
  remote: boolean
  version: string // "Docker 27.3.1 · API 1.47" ('' si desconocida)
  simulated: boolean
  /** Solo perfiles simulados: si «Conectar» falla a propósito (staging-lab). */
  failsToConnect?: boolean
}

/** Motivo visible del error de conexión (los 3 paneles de la plantilla + 'lost'). */
export type ConnectionIssue = 'permission' | 'daemon' | 'ssh' | 'lost'
export interface DiagStep { state: 'ok' | 'fail' | 'skip'; title: string; detail: string; command?: string; hint?: string; tag: string }
export interface Diagnostic { issue: Exclude<ConnectionIssue, 'lost'>; title: string; lead: string; steps: DiagStep[] }
/** Estado de conexión consumido por la UI (derivado de ConnectionStatus + eventos). */
export type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; info: EngineInfo; endpoint: string }
  | { status: 'error'; issue: Exclude<ConnectionIssue, 'lost'>; diagnostic: Diagnostic; message: string }
  | { status: 'lost'; since: number; info: EngineInfo; endpoint: string }

// ---------------------------------------------------------------- Eventos, logs
export type EngineEventKind = 'container' | 'image' | 'volume' | 'network' | 'daemon' | 'other'
export interface EngineEvent {
  kind: EngineEventKind
  action: string
  id: string
  name: string | null
  time_nano: number
  attributes: Record<string, string>
}
/** Motivo de fin de un stream (enum `EndReason` de backend/app/src/streams.rs). */
export type EndReason = 'eof' | 'container_stopped' | 'error' | 'internal'
export type EngineFeed =
  | { type: 'events'; items: EngineEvent[]; resync: boolean }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'ended'; reason: EndReason }

export type LogStream = 'stdout' | 'stderr' | 'console'
export interface LogLine { stream: LogStream; timestamp: string | null; message: string; truncated: boolean }
export type LogFeed =
  | { type: 'lines'; lines: LogLine[]; dropped: number }
  | { type: 'ended'; reason: EndReason; error: ApiError | null }
export type StatsFeed =
  | { type: 'sample'; stats: ContainerStats }
  | { type: 'ended'; reason: EndReason; error: ApiError | null }

// ---------------------------------------------------------------- Errores
export type ApiErrorCode =
  | 'connection' | 'not_found' | 'conflict' | 'invalid_input' | 'engine' | 'timeout' | 'policy_denied'
  | 'ticket_invalid' | 'ticket_expired' | 'typed_mismatch' | 'state_changed' | 'not_implemented' | 'internal'
/** `cause` siempre viaja (null salvo code = 'connection'). */
export interface ApiError { code: ApiErrorCode; message: string; cause?: ConnectionCause | null }

// ---------------------------------------------------------------- Política: plan -> ticket -> ejecutar
/** Verificado contra backend/crates/engine-core/src/actions.rs (`#[serde(tag="type")]`, campos en línea). */
export type ActionRequest =
  | { type: 'remove_containers'; ids: string[] }
  | { type: 'remove_image'; reference: string }
  | { type: 'prune_images' }
  | { type: 'remove_volume'; name: string }
  | { type: 'prune_volumes' }
  | { type: 'remove_network'; id: string }
  | { type: 'stack_down'; project: string }
  | { type: 'prune_system' }

export type DenyReason = 'forbidden' | 'needs_confirmation_non_interactive'
/** Verificado contra actions.rs: `{"type":"confirm_typed","expected":"x"}` y `{"type":"deny","reason":..}`. */
export type PlanDecision =
  | { type: 'allow' }
  | { type: 'confirm' }
  | { type: 'confirm_typed'; expected: string }
  | { type: 'deny'; reason: DenyReason }
/** Los 4 niveles de la UI (Libre / Confirmar / Confirmar con nombre / Bloqueado). */
export type ConfirmLevel = 'allow' | 'confirm' | 'confirm_typed' | 'blocked'

export type AffectedKind = 'container' | 'image' | 'volume' | 'network' // ItemKind del backend
export interface AffectedItem { kind: AffectedKind; id: string; name: string; state?: ContainerState | null; size_bytes?: number | null; detail?: string | null }
/** PlanWarning del backend (actions.rs): etiquetado por `type`. */
export type PlanWarning =
  | { type: 'running_force'; count: number }
  | { type: 'volumes_kept'; items: string[] }
  | { type: 'bind_mounts_kept'; items: string[] }
  | { type: 'in_use'; count: number }
export interface ActionPlan {
  decision: PlanDecision
  ticket: string | null // UUID v7; null si allow o deny
  expires_in_secs: number
  affected: AffectedItem[]
  warnings: PlanWarning[]
  total_size_bytes: number | null
}
export interface ItemRef { kind: AffectedKind; id: string; name: string }
export interface ActionOutcome {
  succeeded: ItemRef[]
  failed: { item: ItemRef; error: ApiError }[]
  freed_bytes: number | null
}

// ---------------------------------------------------------------- Simulados (no conectados aún)
export interface TerminalSession { write(data: string): void; onData(cb: (chunk: string) => void): Unsubscribe; close(): void }
export interface Unsubscribe { (): void }
export interface PullProgress { state: 'pulling' | 'done' | 'error'; layers: { id: string; total: number; done: number }[]; error?: string }
export interface UpProgress { state: 'running' | 'done'; services: { name: string; percent: number; phase: 'waiting' | 'pulling' | 'creating' | 'started' }[] }
export interface StackService { name: string; image: string; state: UiStatus; replicas: string }
export interface StackSummary { name: string; path: string; services: StackService[] }
export interface CreateSpec {
  image: string
  name: string
  ports: { host: string; container: string; protocol: 'tcp' | 'udp' }[]
  volumes: { host: string; container: string; readOnly: boolean }[]
  env: { key: string; value: string }[]
  network: string
  restart: 'no' | 'always' | 'unless-stopped' | 'on-failure'
}
export interface ConnSpec { kind: 'ssh' | 'tls'; name: string; host: string; port: string; user: string; key: string }
