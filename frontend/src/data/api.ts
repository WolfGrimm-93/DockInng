// INTERFAZ ÚNICA DE ACCESO A DATOS. La UI solo conoce `EngineApi` (nunca `invoke` ni Docker).
// Hay dos adaptadores: `adapters/tauri` (real, todo conectado desde la Ola 2) y `adapters/sim` (mundo simulado completo en memoria, para el navegador/Vite y los tests).
// Selección: `createEngineApi()` (isTauri()). Firma de cada método = comando IPC de PLAN_backend §4.3.
import type {
  ActionOutcome, ActionPlan, ActionRequest, BuildFeed, BuildPlan, BuildSpec, CleanupReport, ComposeInfo, ConnSpec, ConnTestResult,
  ConnectionProfile, ConnectionStatus, Container, ContainerDetail, ContainerStats, CreateContainerSpec, CreateNetworkSpec, CreatePlan,
  CreateResult, CreateVolumeSpec, EngineFeed, ExecOptions, ExecSession, GpuInfo, GroupOp, GroupsImportResult, GroupsSnapshot, HostKeyProbe,
  Image, LegacyGroupsPayload, LogFeed, Network, PodmanCandidate, PrefKey, PullFeed, RegistrySummary, RegistryTestResult, StackFiles,
  StackOpFeed, StackOpRequest, StackSummary, StackValidation, StatsSnapshotItem, SystemUsage, Unsubscribe, Volume,
  BusySummary, NotifyRequest, OpenPortScheme, TrayStatus, WindowEdge,
} from './types'

export type Feature =
  | 'connection' | 'containers' | 'images' | 'volumes' | 'networks' | 'actions' | 'events' | 'logs' | 'stats' | 'inspect' | 'system'
  | 'exec' | 'pull' | 'create' | 'stacks' | 'connections' | 'store' | 'registries' | 'build' | 'cleanup'
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
    /** Id de la conexión activa (síncrono; arranca siempre en 'local'). */
    activeId(): string
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
    /** `open_port_in_browser`: el BACKEND arma la URL (`scheme://127.0.0.1:port/`) a partir de los puertos realmente publicados (tcp) por ese contenedor y abre el navegador
     *  del sistema. Solo con conexión local y contenedor en ejecución. El renderizador nunca aporta host ni ruta. */
    openPort(id: string, port: number, scheme: OpenPortScheme): Promise<void>
  }
  /** Franja de consumo: `usage` = `system_usage` (CPU/RAM del equipo + disco de Docker); `gpu` = `gpu_status` (nunca lanza: sin GPU => []). */
  system: {
    usage(): Promise<SystemUsage>
    gpu(): Promise<GpuInfo[]>
    /** `cleanup_report`: informe de SOLO LECTURA de lo recuperable (sin ticket). `minAgeDays` filtra imágenes sin usar recientes. */
    cleanupReport(o: { minAgeDays: number }): Promise<CleanupReport>
    /** `podman_detect`: sockets de Podman candidatos (solo detección; no ejecuta `podman`). */
    podmanDetect(): Promise<PodmanCandidate[]>
  }
  images: {
    list(): Promise<Image[]>
    /** `build_plan`: valida el contexto y emite ticket si hace falta confirmar. Nunca construye. */
    planBuild(spec: BuildSpec): Promise<BuildPlan>
    /** `subscribe_build`. Cancelar = el `Unsubscribe` (el backend termina el build y emite `ended: canceled` si aún hay canal). */
    build(spec: BuildSpec, ticket: string | null, on: (f: BuildFeed) => void): Unsubscribe
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
  /** Conexiones guardadas y contexto activo (Ola 2). */
  connections: {
    /** `connection_list`: siempre incluye «local» (primero). */
    list(): Promise<ConnectionProfile[]>
    /** `connection_probe_host_key`: escanea la clave de host SIN conectar y dice si es desconocida/confiable/cambiada. */
    probeHostKey(spec: ConnSpec): Promise<HostKeyProbe>
    /** `connection_trust_host_key`: escribe la huella SOLO si sigue coincidiendo con la que vio el usuario. */
    trustHostKey(spec: ConnSpec, fingerprint: string): Promise<HostKeyProbe>
    /** `connection_forget_host_key`: quita la clave guardada del destino (known_hosts propio). NO confía en la nueva.
     *  `confirmedHost` debe ser el nombre exacto del host: lo valida el backend (confirmación escrita). */
    forgetHostKey(spec: ConnSpec, confirmedHost: string): Promise<void>
    /** `connection_test`: nunca lanza por fallos de conexión (van en el resultado). */
    test(spec: ConnSpec): Promise<ConnTestResult>
    /** `connection_save {spec, id?}`: sin `id` CREA (nombre repetido = conflict); con `id` EDITA esa conexión (la activa no se puede editar). */
    save(spec: ConnSpec, id?: string): Promise<ConnectionProfile>
    /** `connection_delete`: `confirmed` solo tras el ConfirmDialog (el backend exige decide==Allow). */
    remove(id: string, confirmed: boolean): Promise<void>
    /** `connection_select`: cambia el motor activo. Al fallar, el motor queda en el destino previo (lanza; no cambia `activeId`). */
    select(id: string): Promise<ConnectionStatus>
  }
  /** Registries con credenciales (llavero del sistema). El secreto entra por `save` y NUNCA sale. */
  registries: {
    list(): Promise<RegistrySummary[]>
    save(input: { server: string; username: string; secret: string }): Promise<RegistrySummary>
    remove(id: string, confirmed: boolean): Promise<void>
    test(id: string): Promise<RegistryTestResult>
  }
  /** Grupos, asignaciones y color de stacks persistentes en el almacén del backend. */
  groups: {
    load(): Promise<GroupsSnapshot>
    mutate(op: GroupOp): Promise<GroupsSnapshot>
    importLegacy(payload: LegacyGroupsPayload): Promise<GroupsImportResult>
    /** Exporta grupos, asignaciones y colores (sin secretos). El backend pide la ruta con el diálogo nativo; devuelve la ruta escrita o `null` si se canceló. */
    exportGroups(): Promise<string | null>
  }
  /** Bandeja, notificaciones nativas, ventana propia (sin marco) y cierre controlado (Ola 3). En el navegador/simulado los comandos de ventana no hacen nada. */
  window: {
    /** `tray_status`: ¿hay bandeja del sistema? (sin appindicator/host SNI no hay y `close_to_tray` se ignora). */
    trayStatus(): Promise<TrayStatus>
    /** `busy_summary`: operaciones en curso (stacks, descargas, builds, terminales). */
    busySummary(): Promise<BusySummary>
    /** `notify_user`: notificación nativa; el backend valida `kind`, respeta las prefs y decide si mostrarla según el foco. */
    notifyUser(n: NotifyRequest): Promise<void>
    /** `quit_app`: `true` sale siempre (tras el ConfirmDialog). OJO: `false` NO significa «cancelar»: es una petición de salida que, con operaciones en curso, vuelve a pedir confirmación (`quit_requested`). Cancelar = no llamar. */
    quitApp(confirmed: boolean): Promise<void>
    /** `window_set_decorations`: barra del sistema (true) o ventana sin marco con `WindowChrome` (false). */
    setDecorations(enabled: boolean): Promise<void>
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    /** Pasa por el cierre controlado del backend (respeta `close_to_tray` y las operaciones en curso). */
    close(): Promise<void>
    startDrag(): Promise<void>
    startResize(edge: WindowEdge): Promise<void>
    /** `subscribe_app_events`: mensaje `quit_requested` (cierre pedido con operaciones en curso; canal del backend, sin permisos de eventos de Tauri). Devuelve la baja. */
    onQuitRequested(cb: (summary: BusySummary) => void): Unsubscribe
  }
  /** Preferencias (lista blanca de claves). `get` devuelve `null` si nunca se guardó. */
  prefs: {
    get(key: PrefKey): Promise<unknown>
    set(key: PrefKey, value: unknown): Promise<void>
  }
}
