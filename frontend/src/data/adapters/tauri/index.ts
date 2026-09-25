// ADAPTADOR TAURI: implementa EngineApi contra los comandos IPC del backend (PLAN_backend §4.3).
// Todo lo que el backend aún no expone (exec, pull, create, stacks, connections) se delega en el
// adaptador simulado con `mutateWorld:false` (no inserta datos falsos en listas reales).
//
// RECONCILIADO con el backend implementado (backend/app/src/commands.rs, command_names.rs y engine-core):
//  - 19 comandos: connection_status, reconnect, list_containers{all}, inspect_container{id}, list_images, list_volumes,
//    list_networks, start/stop/restart_container{id}, plan_action{request}, execute_action{ticket,typed}, cancel_action{ticket},
//    container_stats_snapshot{ids}, subscribe_engine_events{onEvent}, subscribe_logs{id,tail,follow,onEvent}, subscribe_stats{id,onEvent},
//    unsubscribe{subscriptionId}, reset_subscriptions. Args camelCase (Tauri v2).
//  - container_stats_snapshot{ids} (máx. 64): una muestra por contenedor SIN suscripciones (CPU% correcto).
//  - Errores: ApiError{code,message,cause}; un String antiguo se normaliza a code:'internal'.
import { invoke } from '@tauri-apps/api/core'
import type { EngineApi } from '../../api'
import { toApiError } from '../../errors'
import type {
  ActionOutcome, ActionPlan, ConnectionProfile, ConnectionStatus, Container, ContainerDetail, ContainerStats, EngineFeed, Image,
  LogFeed, Network, StatsFeed, StatsSnapshotItem, Volume,
} from '../../types'
import { createSimApi } from '../sim'
import { subscribe } from './streams'

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
      connection: 'live', containers: 'live', images: 'live', volumes: 'live', networks: 'live', actions: 'live', events: 'live', logs: 'live', stats: 'live', inspect: 'live',
      exec: 'simulated', pull: 'simulated', create: 'simulated', stacks: 'simulated', connections: 'simulated',
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
    },
    images: { list: () => call<Image[]>('list_images') },
    volumes: { list: () => call<Volume[]>('list_volumes') },
    networks: { list: () => call<Network[]>('list_networks') },
    actions: {
      plan: (request) => call<ActionPlan>('plan_action', { request }),
      execute: (ticket, typed) => call<ActionOutcome>('execute_action', { ticket, typed: typed ?? null }),
      cancel: (ticket) => call<void>('cancel_action', { ticket }),
    },
    events: {
      subscribe: (on) =>
        subscribe<EngineFeed>('subscribe_engine_events', {}, on, () => on({ type: 'ended', reason: 'error' })),
    },
    exec: sim.exec,
    pull: sim.pull,
    create: sim.create,
    stacks: sim.stacks,
    connections: sim.connections,
  }
}

/** Se llama una vez al arrancar la ventana: cierra suscripciones huérfanas de una recarga previa. */
export function resetSubscriptions(): Promise<void> {
  return invoke<void>('reset_subscriptions').catch(() => undefined)
}
