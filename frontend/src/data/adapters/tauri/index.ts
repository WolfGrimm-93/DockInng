// ADAPTADOR TAURI: implementa EngineApi contra los 72 comandos IPC del backend (40 de la Ola 1 + 20 de la Ola 2 + 12 de la Ola 3: abrir puerto, bandeja/avisos, ventana). Todo es real: ya no hay
// delegación en el adaptador simulado. Args camelCase (Tauri v2); errores = ApiError{code,message,cause}
// (un String antiguo se normaliza a code:'internal'). Lo de la Ola 2 vive en ./store.ts.
//  Conexión/motor:  connection_status, reconnect, system_usage, gpu_status, reset_subscriptions, unsubscribe
//  Contenedores:    list_containers{all}, inspect_container{id}, start_container/stop_container/restart_container{id}, container_stats_snapshot{ids} (máx. 64)
//  Recursos:        list_images, list_volumes, list_networks, create_volume{spec}, create_network{spec}
//  Política:        plan_action{request}, execute_action{ticket,typed}, cancel_action{ticket}
//  Streams:         subscribe_engine_events{onEvent}, subscribe_logs{id,tail,follow,onEvent}, subscribe_stats{id,onEvent}
//  Crear:           plan_create_container{spec}, create_container{spec,start,ticket}
//  Pull:            subscribe_pull{reference,onEvent}
//  Terminal:        subscribe_exec{id,cols,rows,onEvent}, exec_write{subscriptionId,data}, exec_resize{subscriptionId,cols,rows}, exec_close{subscriptionId}
//  Stacks:          compose_info{recheck?}, list_stacks, stack_read{name}, stack_save{name,yaml,env,expectedRevision}, stack_validate{name,yaml,env},
//                   stack_create{name,yaml,env}, stack_link{path}, stack_unlink{name}, run_stack_op{name,op,onEvent}, cancel_stack_op{subscriptionId}
//  Ola 2:           groups_load, groups_mutate{op}, groups_import_legacy{payload}, prefs_get{key}, prefs_set{key,value},
//                   connection_list, connection_probe_host_key{spec}, connection_trust_host_key{spec,fingerprint}, connection_test{spec}, connection_save{spec},
//                   connection_delete{id,confirmed}, connection_select{id}, registry_list, registry_save{server,username,secret}, registry_delete{id,confirmed},
//                   registry_test{id}, build_plan{spec}, subscribe_build{spec,ticket,onEvent}, cleanup_report{minAgeDays}, podman_detect
//  Ola 3:           open_port_in_browser{id,port,scheme}, tray_status, busy_summary, notify_user{kind,title,body}, quit_app{confirmed},
//                   window_set_decorations{enabled}, window_minimize, window_toggle_maximize, window_close, window_start_drag, window_start_resize{direction},
//                   subscribe_app_events{onEvent} (quit_requested; ver ./window.ts)
import { invoke } from '@tauri-apps/api/core'
import type { EngineApi } from '../../api'
import { toApiError } from '../../errors'
import type {
  ActionOutcome, ActionPlan, BuildFeed, BuildPlan, CleanupReport, ComposeInfo, ConnTestResult, HostKeyProbe, PodmanCandidate, ConnectionStatus, Container, ContainerDetail, ContainerStats, CreatePlan, CreateResult,
  EngineFeed, GpuInfo, Image, LogFeed, Network, PullFeed, StackFiles, StackOpFeed, StackSummary, StackValidation, StatsFeed, StatsSnapshotItem,
  SystemUsage, Volume,
} from '../../types'
import { openExec } from './exec'
import { subscribe, subscribeHandle } from './streams'
import { createTauriWindow } from './window'
import { createTauriStore, normalizeProfile, type RawProfile } from './store'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toApiError(e)
  }
}

export function createTauriApi(): EngineApi {
  const store = createTauriStore()
  const windowApi = createTauriWindow()
  let active = 'local'
  let lastEndpoint = 'unix:///var/run/docker.sock' // último destino visto (respaldo de un estado «failed» sin endpoint)
  let lastVersion = '' // versión del motor ACTIVO
  let localEndpoint = 'unix:///var/run/docker.sock' // destino/versión del motor LOCAL (no se pisan al cambiar a una conexión remota)
  let localVersion = ''

  const remember = (s: ConnectionStatus): ConnectionStatus => {
    lastEndpoint = s.endpoint
    if (s.state === 'connected') lastVersion = `Docker ${s.server.version} · API ${s.server.api_version}`
    if (active === 'local') {
      localEndpoint = s.endpoint
      if (s.state === 'connected') localVersion = lastVersion
    }
    return s
  }

  return {
    mode: 'tauri',
    capabilities: {
      connection: 'live', containers: 'live', images: 'live', volumes: 'live', networks: 'live', actions: 'live', events: 'live', logs: 'live', stats: 'live', inspect: 'live', system: 'live',
      exec: 'live', pull: 'live', create: 'live', stacks: 'live', connections: 'live', store: 'live', registries: 'live', build: 'live', cleanup: 'live',
    },
    connection: {
      async status() {
        // El backend nunca devuelve Err aquí; si el IPC falla del todo, se describe como fallo genérico.
        try {
          return remember(await invoke<ConnectionStatus>('connection_status'))
        } catch (e) {
          const a = toApiError(e)
          return { state: 'failed', endpoint: lastEndpoint, cause: a.cause ?? 'other', message: a.message, steps: [] }
        }
      },
      async reconnect() {
        try {
          return remember(await invoke<ConnectionStatus>('reconnect'))
        } catch (e) {
          const a = toApiError(e)
          return { state: 'failed', endpoint: lastEndpoint, cause: a.cause ?? 'other', message: a.message, steps: [] }
        }
      },
      activeId: () => active,
    },
    containers: {
      list: (all = true) => call<Container[]>('list_containers', { all }),
      inspect: (id) => call<ContainerDetail>('inspect_container', { id }),
      start: (id) => call<void>('start_container', { id }),
      stop: (id) => call<void>('stop_container', { id }),
      restart: (id) => call<void>('restart_container', { id }),
      // Comando propio del backend (máx. 64 ids, 8 en paralelo, tope 5 s; devuelve cpu_percent válido: usa stream=false).
      statsSnapshot: (ids) => call<StatsSnapshotItem[]>('container_stats_snapshot', { ids }),
      streamLogs: (id, o, on) =>
        subscribe<LogFeed>('subscribe_logs', { id, tail: o.tail, follow: o.follow }, on, (error) => on({ type: 'ended', reason: 'error', error })),
      streamStats: (id, on) =>
        subscribe<StatsFeed>('subscribe_stats', { id }, (f) => {
          if (f.type === 'sample') on(f.stats as ContainerStats)
        }),
      planCreate: (spec) => call<CreatePlan>('plan_create_container', { spec }),
      create: (spec, start, ticket) => call<CreateResult>('create_container', { spec, start, ticket }),
      openPort: (id, port, scheme) => call<void>('open_port_in_browser', { id, port, scheme }),
    },
    system: {
      usage: () => call<SystemUsage>('system_usage'),
      cleanupReport: (o) => call<CleanupReport>('cleanup_report', { minAgeDays: o.minAgeDays }),
      podmanDetect: () => call<PodmanCandidate[]>('podman_detect'),
      // La GPU es opcional: cualquier fallo del IPC se trata como «sin GPU», nunca como error visible.
      async gpu() {
        try {
          const r = await invoke<GpuInfo[]>('gpu_status')
          return Array.isArray(r) ? r : []
        } catch {
          return []
        }
      },
    },
    images: {
      list: () => call<Image[]>('list_images'),
      planBuild: (spec) => call<BuildPlan>('build_plan', { spec }),
      build: (spec, ticket, on) =>
        subscribe<BuildFeed>('subscribe_build', { spec, ticket }, on, (error) => on({ type: 'ended', outcome: 'failed', image_id: null, error })),
      pull: (reference, on) =>
        subscribe<PullFeed>('subscribe_pull', { reference }, on, (error) => on({ type: 'ended', outcome: 'error', up_to_date: false, digest: null, error })),
    },
    volumes: { list: () => call<Volume[]>('list_volumes'), create: (spec) => call<Volume>('create_volume', { spec }) },
    networks: { list: () => call<Network[]>('list_networks'), create: (spec) => call<Network>('create_network', { spec }) },
    actions: {
      plan: (request) => call<ActionPlan>('plan_action', { request }),
      execute: (ticket, typed) => call<ActionOutcome>('execute_action', { ticket, typed: typed ?? null }),
      cancel: (ticket) => call<void>('cancel_action', { ticket }),
    },
    events: {
      subscribe: (on) =>
        subscribe<EngineFeed>('subscribe_engine_events', {}, on, () => on({ type: 'ended', reason: 'error' })),
    },
    exec: { open: (containerId, o) => openExec(containerId, o) },
    stacks: {
      composeInfo: (recheck) => call<ComposeInfo>('compose_info', recheck ? { recheck: true } : undefined),
      list: () => call<StackSummary[]>('list_stacks'),
      runOp(name, op, on) {
        const h = subscribeHandle<StackOpFeed>('run_stack_op', { name, op }, on, (error) =>
          on({ type: 'ended', outcome: 'failed', exit_code: null, error, issues: [] }))
        return {
          // Cancelación limpia: SIGTERM al subproceso y `ended: canceled`. El id puede llegar tarde.
          cancel: () => { void h.id().then((id) => { if (id) return invoke('cancel_stack_op', { subscriptionId: id }) }).catch(() => {}) },
          dispose: h.unsubscribe,
        }
      },
      read: (name) => call<StackFiles>('stack_read', { name }),
      save: (name, f) => call<StackFiles>('stack_save', { name, yaml: f.yaml, env: f.env, expectedRevision: f.expectedRevision }),
      validate: (name, yaml, env) => call<StackValidation>('stack_validate', { name, yaml, env }),
      create: (name, yaml, env) => call<StackSummary>('stack_create', { name, yaml, env }),
      link: (path) => call<StackSummary>('stack_link', { path }),
      unlink: (name) => call<void>('stack_unlink', { name }),
    },
    connections: {
      list: async () => (await store.listProfiles()).map((p) => (p.id === 'local' ? { ...p, target: localEndpoint, version: localVersion || p.version } : p.id === active ? { ...p, version: lastVersion || p.version } : p)),
      probeHostKey: (spec) => call<HostKeyProbe>('connection_probe_host_key', { spec }),
      trustHostKey: (spec, fingerprint) => call<HostKeyProbe>('connection_trust_host_key', { spec, fingerprint }),
      forgetHostKey: (spec) => call<void>('connection_forget_host_key', { spec }),
      test: (spec) => call<ConnTestResult>('connection_test', { spec }),
      save: async (spec, id) => normalizeProfile(await call<RawProfile>('connection_save', id ? { spec, id } : { spec })),
      remove: (id, confirmed) => call<void>('connection_delete', { id, confirmed }),
      async select(id) {
        // Si falla (Err), el backend deja el motor en el destino previo: `active` NO cambia.
        const status = await call<ConnectionStatus>('connection_select', { id })
        active = id
        return remember(status)
      },
    },
    registries: store.registries,
    groups: store.groups,
    prefs: store.prefs,
    window: windowApi,
  }
}

/** Se llama una vez al arrancar la ventana: cierra suscripciones huérfanas de una recarga previa. */
export function resetSubscriptions(): Promise<void> {
  return invoke<void>('reset_subscriptions').catch(() => undefined)
}
