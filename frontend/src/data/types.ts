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
  /** IP, puerta de enlace y MAC del contenedor en cada red (vacío/sin IP si está detenido; sin alias: esos solo vienen en el detalle). */
  endpoints: NetworkEndpoint[]
}

/** Un extremo de red de un contenedor (espejo de engine-core NetworkEndpoint). Los campos vacíos de Docker llegan como null. */
export interface NetworkEndpoint {
  /** Nombre de la red. */
  name: string
  ip_address: string | null
  ipv6_address: string | null
  gateway: string | null
  mac_address: string | null
  /** Alias de DNS en esa red: solo los da `inspect` (en el listado de contenedores vienen vacíos). */
  aliases: string[]
}
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
export type ConnectionCause =
  | 'socket_missing' | 'permission_denied' | 'daemon_down' | 'other'
  // Ola 2 (conexiones remotas SSH/TLS).
  | 'host_key_unknown' | 'host_key_changed' | 'auth_failed' | 'unreachable' | 'remote_docker_missing' | 'tls_invalid'
export type StepStatus = 'ok' | 'fail' | 'skipped'
export type DiagStepId = 'socket' | 'permissions' | 'daemon'
export interface DiagStepRaw { id: DiagStepId; status: StepStatus; detail: string }
/** Respuesta de `connection_status` / `reconnect` (nunca es un error IPC). */
export type ConnectionStatus =
  | { state: 'connected'; endpoint: string; server: EngineInfo }
  | { state: 'failed'; endpoint: string; cause: ConnectionCause; message: string; steps: DiagStepRaw[] }

/** Perfil de conexión. Ola 2: «Local» y las conexiones guardadas (`connection_list`) son reales; en el navegador (mundo simulado) son de ejemplo (`simulated:true`). */
export interface ConnectionProfile {
  id: string
  name: string
  target: string // p. ej. unix:///var/run/docker.sock
  kind: 'local' | 'ssh' | 'tls'
  icon: 'monitor' | 'server'
  remote: boolean
  version: string // "Docker 27.3.1 · API 1.47" ('' si desconocida)
  simulated: boolean
  /** Huella SHA256 de la clave de host aceptada (solo SSH). */
  host_key_fp?: string | null
  /** Solo perfiles simulados: si «Conectar» falla a propósito (staging-lab). */
  failsToConnect?: boolean
  /** Especificación editable, sin secretos: solo rutas de archivos para SSH/TLS. */
  spec?: ConnSpec
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
  // Ola 1 (contrato canónico del backend): Compose, imágenes y exec.
  | 'compose_missing' | 'compose_failed' | 'invalid_compose' | 'image_missing' | 'auth_required' | 'registry_unreachable' | 'no_shell'
/** `cause` siempre viaja (null salvo code = 'connection'). */
export interface ApiError {
  code: ApiErrorCode; message: string; cause?: ConnectionCause | null
  /** `connection_select` fallido: solo aparece como `true` cuando el backend YA abortó suscripciones, terminales y tickets antes de fallar (la UI debe reabrir sus streams). Ausente = no se tocó nada. */
  quiesced?: boolean
}

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
  /** Borra los archivos de un stack propio (irreversible: contiene .env). Confirmación escrita con el nombre. */
  | { type: 'stack_delete'; name: string }
  | { type: 'prune_system' }
  /** Limpieza guiada (Ola 2): SIEMPRE por elemento (nunca `prune`). Con volúmenes exige confirmación escrita (ELIMINAR). */
  | { type: 'cleanup'; selection: CleanupSelection }

export type DenyReason = 'forbidden' | 'needs_confirmation_non_interactive'
/** Verificado contra actions.rs: `{"type":"confirm_typed","expected":"x"}` y `{"type":"deny","reason":..}`. */
export type PlanDecision =
  | { type: 'allow' }
  | { type: 'confirm' }
  | { type: 'confirm_typed'; expected: string }
  | { type: 'deny'; reason: DenyReason }
/** Los 4 niveles de la UI (Libre / Confirmar / Confirmar con nombre / Bloqueado). */
export type ConfirmLevel = 'allow' | 'confirm' | 'confirm_typed' | 'blocked'

export type AffectedKind = 'container' | 'image' | 'volume' | 'network' | 'stack' // ItemKind del backend
export interface AffectedItem { kind: AffectedKind; id: string; name: string; state?: ContainerState | null; size_bytes?: number | null; detail?: string | null }
/** PlanWarning del backend (actions.rs): etiquetado por `type`. */
export type PlanWarning =
  | { type: 'running_force'; count: number }
  | { type: 'volumes_kept'; items: string[] }
  | { type: 'bind_mounts_kept'; items: string[] }
  | { type: 'in_use'; count: number }
  /** Plan de `cleanup`: elementos omitidos porque ya no existen o pasaron a estar en uso (el plan sale con el resto). */
  | { type: 'skipped'; items: string[] }
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

// ---------------------------------------------------------------- Comunes
export interface Unsubscribe { (): void }

// ---------------------------------------------------------------- Compose / Stacks (contrato backend Ola 1, snake_case)
/** `compose_info`. `flavor: 'standalone'` con `supported:false` = Compose v1 (no se usa). */
export interface ComposeInfo { available: boolean; flavor: 'plugin' | 'standalone' | 'missing'; version: string | null; supported: boolean; docker_cli: boolean }
/** managed = creado en la app (~/.local/share/dockinng/stacks/<n>) · linked = archivo compose externo vinculado · discovered = solo por etiquetas. */
export type StackOrigin = 'managed' | 'linked' | 'discovered'
export type StackStatus = 'running' | 'partial' | 'stopped' | 'declared'
export interface StackService { name: string; image: string; state: ContainerState; replicas: string; running: number; total: number }
export interface StackSummary {
  name: string
  origin: StackOrigin
  /** Primer archivo de configuración ('' si se desconoce). */
  path: string
  config_files: string[]
  working_dir: string | null
  editable: boolean
  status: StackStatus
  containers: number
  running: number
  services: StackService[]
}
/** `stack_read` / `stack_save`. `revision` = mtime_ns:len de ambos archivos (detecta cambios externos). */
export interface StackFiles { name: string; origin: StackOrigin; yaml: string; env: string; path: string; env_path: string; editable: boolean; config_files: string[]; revision: string }
export type ValidationKind = 'syntax' | 'schema' | 'interpolation' | 'other'
export interface ValidationIssue { line: number | null; column: number | null; kind: ValidationKind; message: string }
/** Riesgos informativos del YAML (banner, no bloquean). `path` solo en sensitive_bind. */
export type StackRiskType = 'privileged' | 'host_network' | 'docker_sock' | 'sensitive_bind' | 'pid_host' | 'cap_add_sys_admin' | 'remote_bind'
export interface StackRisk { type: StackRiskType; path?: string }  // remote_bind: `path` = ruta LOCAL ya resuelta que el daemon remoto interpretaría en su propio disco
export interface StackValidation { ok: boolean; issues: ValidationIssue[]; services: string[]; risks: StackRisk[] }
export type StackOpKind = 'up' | 'restart' | 'stop' | 'start' | 'pull'
export interface StackOpRequest { type: StackOpKind; services?: string[] }
export type ProgressKind = 'network' | 'container' | 'volume' | 'image' | 'service' | 'other'
export interface ProgressItem {
  id: string; kind: ProgressKind; name: string; status: 'working' | 'done' | 'warning' | 'error'; text: string
  details: string | null; current: number | null; total: number | null; percent: number | null; parent_id: string | null
}
export type ServicePhase = 'waiting' | 'pulling' | 'creating' | 'started'
/** Instantánea por servicio (= contrato de UpProgress de la plantilla). */
export interface ServiceProgressRow { name: string; percent: number; phase: ServicePhase }
export type StackOutcome = 'success' | 'failed' | 'canceled' | 'timeout'
export type StackOpFeed =
  | { type: 'started'; op: StackOpKind; stack: string; compose_version: string }
  | { type: 'progress'; items: ProgressItem[]; services: ServiceProgressRow[] }
  | { type: 'log'; text: string }
  | { type: 'ended'; outcome: StackOutcome; exit_code: number | null; error: ApiError | null; issues: ValidationIssue[] }
/** Estado de una operación de stack en el store (sobrevive a la navegación). */
export interface StackOpState {
  kind: StackOpKind
  state: 'running' | 'done' | 'error' | 'canceled'
  services: ServiceProgressRow[]
  log: string[]
  error: ApiError | null
  issues: ValidationIssue[]
  startedAt: number
}

// ---------------------------------------------------------------- Terminal (exec)
export interface ExecRisk { privileged: boolean; docker_socket: boolean; host_pid: boolean; host_network: boolean }
export interface ExecInfo { shell: string; risk: ExecRisk }
export type ExecEndReason = 'process_exited' | 'container_stopped' | 'closed' | 'no_shell' | 'error' | 'internal'
export interface ExecExit { reason: ExecEndReason; exit_code: number | null; error: ApiError | null }
/** Feed crudo del canal `subscribe_exec`. `data` = base64 de bytes crudos. */
export type ExecFeed =
  | { type: 'opened'; shell: string; risk: ExecRisk }
  | { type: 'output'; data: string }
  | { type: 'ended'; reason: ExecEndReason; exit_code: number | null; error: ApiError | null }
export interface ExecOptions { cols: number; rows: number }
/** Sesión de terminal. Los listeners se reproducen: lo emitido antes de suscribirse se entrega al suscribir. */
export interface ExecSession {
  write(data: string): void
  resize(cols: number, rows: number): void
  onOpen(cb: (info: ExecInfo) => void): Unsubscribe
  onOutput(cb: (chunk: Uint8Array) => void): Unsubscribe
  onExit(cb: (e: ExecExit) => void): Unsubscribe
  /** Idempotente: cierra el exec en el backend. */
  close(): void
}

// ---------------------------------------------------------------- Pull
export type LayerPhase = 'waiting' | 'downloading' | 'downloaded' | 'extracting' | 'complete'
export interface PullLayer { id: string; phase: LayerPhase; total: number; done: number }
export type PullFeed =
  | { type: 'started'; reference: string }
  | { type: 'progress'; layers: PullLayer[]; done_bytes: number; total_bytes: number }
  | { type: 'ended'; outcome: 'done' | 'error'; up_to_date: boolean; digest: string | null; error: ApiError | null }
/** Estado de una descarga en el store (por referencia; sobrevive a la navegación). */
export interface PullOp {
  reference: string
  state: 'pulling' | 'done' | 'error' | 'canceled'
  layers: PullLayer[]
  doneBytes: number
  totalBytes: number
  upToDate: boolean
  digest: string | null
  error: ApiError | null
}

// ---------------------------------------------------------------- Crear contenedor / volumen / red
export type Restart = 'no' | 'always' | 'unless-stopped' | 'on-failure'
export interface CreatePort { host_ip: string | null; host_port: number | null; container_port: number; protocol: 'tcp' | 'udp' }
export interface CreateVolumeMount { source: string; target: string; read_only: boolean }
export interface CreateContainerSpec {
  image: string
  name: string | null
  ports: CreatePort[]
  volumes: CreateVolumeMount[]
  env: { key: string; value: string }[]
  network: string | null
  restart: Restart
  restart_max_retries: number | null
  command: string | null
  labels: Record<string, string>
}
export interface FieldError { field: string; message: string }
export type CreateWarning =
  | { type: 'sensitive_bind'; source: string; reason: string }
  | { type: 'docker_socket' }
  | { type: 'host_network' }
  | { type: 'port_in_use'; port: number; by: string }
  | { type: 'published_all_interfaces'; port: number }
  /** Ola 2: la conexión activa es remota; este bind se resuelve en el equipo REMOTO. */
  | { type: 'remote_bind'; source: string }
/** `plan_create_container`. `decision` distinto de allow exige el ticket en `create_container`. */
export interface CreatePlan {
  ok: boolean
  field_errors: FieldError[]
  warnings: CreateWarning[]
  decision: PlanDecision
  ticket: string | null
  expires_in_secs: number
  normalized: CreateContainerSpec
}
export interface CreateResult { id: string; name: string; started: boolean; warnings: string[]; start_error: ApiError | null }
export interface CreateVolumeSpec { name: string; labels: Record<string, string> }
export interface CreateNetworkSpec { name: string; internal: boolean; subnet: string | null; gateway: string | null; labels: Record<string, string> }

// ---------------------------------------------------------------- Conexiones remotas (Ola 2). Espejo de engine-core/src/connections.rs (serde snake_case).
export type SshIdentity = { type: 'agent' } | { type: 'file'; path: string }
/** SSH: solo RUTAS de llave (nunca su contenido). `mode:'alias'` = `host` es un alias de ~/.ssh/config. */
export interface SshConnSpec { kind: 'ssh'; name: string; host: string; port: number; user: string; mode: 'explicit' | 'alias'; identity: SshIdentity }
/** TLS mutuo: 3 rutas a PEM. No existe opción «insecure». */
export interface TlsConnSpec { kind: 'tls'; name: string; host: string; port: number; ca_path: string; cert_path: string; key_path: string }
export type ConnSpec = SshConnSpec | TlsConnSpec
export type HostKeyState = 'unknown' | 'trusted' | 'changed'
/** `connection_probe_host_key`. Con `state:'changed'` `fingerprint_sha256` es la NUEVA; `known_fingerprint_sha256` (solo simulado, el backend no lo envía) sería la guardada. */
export interface HostKeyProbe { key_type: string; fingerprint_sha256: string; state: HostKeyState; known_fingerprint_sha256?: string | null }
/** `connection_test`: nunca es un error IPC por fallo de conexión; el motivo va en `cause`/`error`. */
export interface ConnTestResult { ok: boolean; server?: EngineInfo | null; error?: ApiError | null; cause?: ConnectionCause | null }

// ---------------------------------------------------------------- Registries (Ola 2). El secreto entra UNA vez (`registry_save`) y no vuelve a salir.
export interface RegistrySummary { id: string; server: string; username: string }
/** El comando `registry_test` devuelve `()` o un ApiError: el adaptador Tauri lo convierte en `{ok, error?}` (nunca lanza por credenciales inválidas). */
export interface RegistryTestResult { ok: boolean; error?: ApiError | null }

// ---------------------------------------------------------------- Grupos persistentes (Ola 2, `groups_*`)
export interface StoredGroup { id: string; name: string; hue: number }
export interface GroupAssignment { connection_id: string; container_name: string; group_id: string }
export interface GroupsSnapshot { groups: StoredGroup[]; assignments: GroupAssignment[]; stack_hues: Record<string, number>; legacy_imported: boolean }
/** `#[serde(tag="type")]` (engine-core/connections.rs `GroupOp`). `create_group` NO lleva id: lo genera el backend (UUID v7) y llega en el snapshot. */
export type GroupOp =
  | { type: 'create_group'; name: string; hue: number | null }
  | { type: 'rename_group'; id: string; name: string }
  | { type: 'set_group_hue'; id: string; hue: number }
  | { type: 'delete_group'; id: string }
  | { type: 'assign'; connection_id: string; names: string[]; group_id: string | null }
  | { type: 'set_stack_hue'; project: string; hue: number | null }
/** Carga útil de `groups_import_legacy` = lo que produce `loadGroups()` de `dockinng.groups.v1`. */
export interface LegacyGroupsPayload { v: 1; groups: StoredGroup[]; assign: Record<string, string>; stackHue: Record<string, number> }
/** `LegacyImportReport` de engine-core: con `already_imported:true` no se escribió nada. */
export interface GroupsImportResult { already_imported: boolean; imported_groups: number; imported_assignments: number; dropped_assignments: number; snapshot: GroupsSnapshot }
/** Claves permitidas de `prefs_get/prefs_set` (lista blanca validada también en Rust). */
export type PrefKey =
  | 'polling' | 'last_connection_id'
  // Ola 3: notificaciones, bandeja y ventana.
  | 'notify_enabled' | 'notify_events' | 'tray_enabled' | 'close_to_tray' | 'window_decorations' | 'start_minimized'

// ---------------------------------------------------------------- Ola 3: abrir puerto, bandeja, notificaciones, ventana
export type OpenPortScheme = 'http' | 'https'
/** `tray_status`. */
export interface TrayStatus { available: boolean; error: string | null }
/** `busy_summary` y payload de `app://quit-requested`: operaciones en curso que se perderían al salir. */
export interface BusySummary { stacks: number; pulls: number; builds: number; terminals: number }
/** Mensajes del backend a la UI por el canal de `subscribe_app_events` (`AppFeed` de backend/app/src/shell.rs). */
export type AppFeed = { type: 'quit_requested'; summary: BusySummary } | { type: 'window_visibility'; visible: boolean }
/** Tipos de notificación que el backend acepta (lista blanca). */
export type NotifyKind = 'die' | 'oom' | 'unhealthy' | 'op_done'
export interface NotifyRequest { kind: NotifyKind; title: string; body: string }
/** Qué eventos notifican (pref `notify_events`). */
export interface NotifyEvents { die: boolean; oom: boolean; unhealthy: boolean; op_done: boolean }
/** Borde/esquina para `window_start_resize {direction}` (snake_case, lista cerrada del backend). */
export type WindowEdge = 'north' | 'south' | 'east' | 'west' | 'north_east' | 'north_west' | 'south_east' | 'south_west'

// ---------------------------------------------------------------- Builds de imagen (Ola 2, `build_plan` / `subscribe_build`)
export interface BuildSpec {
  context_dir: string
  dockerfile: string | null
  tag: string | null
  build_args: [string, string][]
  target: string | null
  no_cache: boolean
  pull: boolean
}
/** `BuildWarning` de engine-core (etiquetado por `type`); un tipo futuro desconocido se muestra con su nombre. */
export type BuildWarning =
  | { type: 'sensitive_context'; path: string }
  | { type: 'secret_like_arg'; name: string }
  | { type: string; [k: string]: unknown }
export interface BuildPlan { warnings: BuildWarning[]; decision: PlanDecision; ticket: string | null; expires_in_secs?: number }
export type BuildOutcome = 'ok' | 'failed' | 'canceled'
export type BuildFeed =
  | { type: 'line'; text: string; stream?: 'stdout' | 'stderr' }
  | { type: 'lines'; lines: { text: string; stream?: 'stdout' | 'stderr' }[] }
  | { type: 'step'; n: number; total: number }
  | { type: 'ended'; outcome: BuildOutcome; image_id: string | null; error: ApiError | null }
/** Estado de la construcción en la página. */
export interface BuildRun {
  state: 'running' | 'done' | 'error' | 'canceled'
  step: { n: number; total: number } | null
  lines: { text: string; stream: 'stdout' | 'stderr' }[]
  imageId: string | null
  error: ApiError | null
}

// ---------------------------------------------------------------- Limpieza guiada (Ola 2, `cleanup_report`). Solo lectura.
export type CleanupCategoryId = 'stopped_containers' | 'dangling_images' | 'unused_images' | 'unused_volumes' | 'unused_networks' | 'build_cache'
/** exact = tamaño exacto · upper_bound = cota superior (capas compartidas) · unknown = no se sabe. */
export type CleanupEstimate = 'exact' | 'upper_bound' | 'unknown'
export type CleanupRisk = 'low' | 'medium' | 'high'
export interface CleanupItem {
  kind: AffectedKind
  id: string
  name: string
  size_bytes: number | null
  estimate: CleanupEstimate
  reason: string
  risk: CleanupRisk
  selected_by_default: boolean
}
export interface CleanupCategory { id: CleanupCategoryId; items: CleanupItem[]; reclaimable_bytes: number | null; executable: boolean }
/** `defaults_truncated`: había más de 500 recomendados y solo los primeros 500 vienen marcados por defecto (tope de 500 por limpieza). */
export interface CleanupReport { defaults_truncated?: boolean; categories: CleanupCategory[]; total_reclaimable_bytes: number | null; unknown_count: number; generated_at: string }
export interface CleanupSelection { containers: string[]; images: string[]; volumes: string[]; networks: string[] }

// ---------------------------------------------------------------- Podman (Ola 2, solo detección)
export interface PodmanCandidate { path: string; rootless: boolean; source: string }

// ---------------------------------------------------------------- Sistema (espejo de engine-core/src/system.rs)
/** CPU y memoria del equipo donde corre el motor. */
export interface HostResources { cpu_count: number; mem_total_bytes: number }
/** `null` = el motor no lo informó (desconocido, nunca cero). */
export interface DiskCategory { total_bytes: number | null; reclaimable_bytes: number | null }
/** Disco que usa DOCKER (no el disco del equipo). */
export interface DiskUsage { images: DiskCategory; containers: DiskCategory; volumes: DiskCategory; build_cache: DiskCategory }
/** Capa de escritura de un contenedor. */
export interface ContainerDisk { id: string; size_rw_bytes: number }
/** `system_usage`. `disk_known=false` => `df` falló o expiró: el disco es desconocido. */
export interface SystemUsage { host: HostResources; disk: DiskUsage; container_disk: ContainerDisk[]; disk_known: boolean }
/** `gpu_status` (solo NVIDIA vía nvidia-smi y solo con motor local; sin GPU = lista vacía). */
export interface GpuInfo {
  index: number
  name: string
  /** 0–100. */
  utilization_percent: number
  mem_used_bytes: number
  mem_total_bytes: number
  temperature_c: number | null
}
