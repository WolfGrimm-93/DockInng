// ADAPTADOR TAURI: implementa EngineApi contra los 40 comandos IPC del backend. Solo `connections` (perfiles remotos, Ola 2) se delega en el
// adaptador simulado con `mutateWorld:false` (no inserta datos falsos en listas reales). Args camelCase (Tauri v2); errores = ApiError{code,message,cause}
// (un String antiguo se normaliza a code:'internal').
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
import { invoke } from '@tauri-apps/api/core'
import type { EngineApi } from '../../api'
import { toApiError } from '../../errors'
import type {
  ActionOutcome, ActionPlan, ComposeInfo, ConnectionProfile, ConnectionStatus, Container, ContainerDetail, ContainerStats, CreatePlan, CreateResult,
  EngineFeed, GpuInfo, Image, LogFeed, Network, PullFeed, StackFiles, StackOpFeed, StackSummary, StackValidation, StatsFeed, StatsSnapshotItem,
  SystemUsage, Volume,
} from '../../types'
import { createSimApi } from '../sim'
import { openExec } from './exec'
import { subscribe, subscribeHandle } from './streams'

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toApiError(e)
  }
}

export function createTauriApi(): EngineApi {
  // Mundo simulado SOLO para lo no conectado y para los perfiles no locales.
  const sim = createSimApi({ mutateWorld: false })
  let active = 'local'
  let lastEndpoint = 'unix:///var/run/docker.sock'
  let lastVersion = ''

  const remember = (s: ConnectionStatus): ConnectionStatus => {
    lastEndpoint = s.endpoint
    if (s.state === 'connected') lastVersion = `Docker ${s.server.version} · API ${s.server.api_version}`
    return s
  }

  return {
    mode: 'tauri',
    capabilities: {
      connection: 'live', containers: 'live', images: 'live', volumes: 'live', networks: 'live', actions: 'live', events: 'live', logs: 'live', stats: 'live', inspect: 'live', system: 'live',
      exec: 'live', pull: 'live', create: 'live', stacks: 'live', connections: 'simulated',
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
      async profiles(): Promise<ConnectionProfile[]> {
        const others = (await sim.connection.profiles()).filter((p) => p.id !== 'local')
        const local: ConnectionProfile = { id: 'local', name: 'Local', target: lastEndpoint, kind: 'local', icon: 'monitor', remote: false, version: lastVersion, simulated: false }
        return [local, ...others]
      },
      activeId: () => active,
      async select(id) {
        // D6: solo «Local» es real. Las demás no cambian la conexión activa (la UI muestra un toast simulado).
        if (id !== 'local') throw { code: 'not_implemented', message: 'Conexión simulada: todavía no se puede conectar a hosts remotos.' }
        active = 'local'
        return remember(await invoke<ConnectionStatus>('connection_status'))
      },
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
    },
    system: {
      usage: () => call<SystemUsage>('system_usage'),
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
    connections: sim.connections,
  }
}

/** Se llama una vez al arrancar la ventana: cierra suscripciones huérfanas de una recarga previa. */
export function resetSubscriptions(): Promise<void> {
  return invoke<void>('reset_subscriptions').catch(() => undefined)
}
