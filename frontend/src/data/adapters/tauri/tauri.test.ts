import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = []
let handler: (cmd: string, args?: Record<string, unknown>) => unknown = () => undefined

vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> {
    onmessage: (m: T) => void = () => {}
  }
  return {
    Channel,
    isTauri: () => true,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args })
      const r = handler(cmd, args)
      if (r instanceof Error) throw r
      if (r && typeof r === 'object' && 'reject' in r) throw (r as { reject: unknown }).reject
      return r
    },
  }
})

import { createEngineApi } from '../../createEngineApi'
import { createTauriApi } from '.'

beforeEach(() => {
  calls.length = 0
  handler = () => undefined
})

describe('adaptador Tauri (contrato IPC del backend)', () => {
  it('createEngineApi elige Tauri cuando isTauri() es true', () => {
    expect(createEngineApi().mode).toBe('tauri')
  })
  it('comandos y argumentos (camelCase de Tauri v2)', async () => {
    const api = createTauriApi()
    await api.containers.list(true)
    await api.containers.inspect('abc')
    await api.containers.start('abc')
    await api.containers.stop('abc')
    await api.containers.restart('abc')
    await api.images.list()
    await api.volumes.list()
    await api.networks.list()
    await api.actions.plan({ type: 'remove_volume', name: 'v' })
    await api.actions.execute('tk', 'v')
    await api.actions.execute('tk2')
    await api.actions.cancel('tk')
    expect(calls).toEqual([
      { cmd: 'list_containers', args: { all: true } },
      { cmd: 'inspect_container', args: { id: 'abc' } },
      { cmd: 'start_container', args: { id: 'abc' } },
      { cmd: 'stop_container', args: { id: 'abc' } },
      { cmd: 'restart_container', args: { id: 'abc' } },
      { cmd: 'list_images', args: undefined },
      { cmd: 'list_volumes', args: undefined },
      { cmd: 'list_networks', args: undefined },
      { cmd: 'plan_action', args: { request: { type: 'remove_volume', name: 'v' } } },
      { cmd: 'execute_action', args: { ticket: 'tk', typed: 'v' } },
      { cmd: 'execute_action', args: { ticket: 'tk2', typed: null } },
      { cmd: 'cancel_action', args: { ticket: 'tk' } },
    ])
  })
  it('el destructivo NO envía objetivos: solo ticket (+ typed)', async () => {
    const api = createTauriApi()
    await api.actions.execute('tk', 'ELIMINAR')
    expect(Object.keys(calls[0].args!).sort()).toEqual(['ticket', 'typed'])
  })
  it('normaliza errores: ApiError tal cual, String antiguo -> internal', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'conflict', message: 'en uso' } })
    await expect(api.containers.start('x')).rejects.toEqual({ code: 'conflict', message: 'en uso' })
    handler = () => ({ reject: 'boom' })
    await expect(api.containers.start('x')).rejects.toEqual({ code: 'internal', message: 'boom' })
  })
  it('connection.status nunca lanza: convierte un fallo IPC en «failed»', async () => {
    const api = createTauriApi()
    handler = () => ({ reject: { code: 'internal', message: 'sin backend' } })
    expect(await api.connection.status()).toMatchObject({ state: 'failed', cause: 'other', message: 'sin backend' })
  })
  it('conexiones no locales: select lanza not_implemented (solo toast, sin cambiar la activa)', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'connection_status' ? { state: 'connected', endpoint: 'unix:///var/run/docker.sock', server: { version: '27.3.1', api_version: '1.47', os: 'linux', arch: 'x86_64' } } : undefined)
    await api.connection.status()
    await expect(api.connection.select('prod')).rejects.toMatchObject({ code: 'not_implemented' })
    expect(api.connection.activeId()).toBe('local')
    const profiles = await api.connection.profiles()
    expect(profiles[0]).toMatchObject({ id: 'local', target: 'unix:///var/run/docker.sock', simulated: false, version: 'Docker 27.3.1 · API 1.47' })
    expect(profiles.slice(1).every((p) => p.simulated)).toBe(true)
  })
  it('streams: subscribe_logs con Channel y cancelación con unsubscribe(subscriptionId) — incluso si se cancela antes de recibir el id', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'subscribe_logs' ? 'sub-1' : undefined)
    const got: unknown[] = []
    const off = api.containers.streamLogs('abc', { tail: 100, follow: true }, (f) => got.push(f))
    const sub = calls.find((c) => c.cmd === 'subscribe_logs')!
    expect(sub.args).toMatchObject({ id: 'abc', tail: 100, follow: true })
    const ch = sub.args!.onEvent as { onmessage: (m: unknown) => void }
    ch.onmessage({ type: 'lines', lines: [], dropped: 0 })
    expect(got).toHaveLength(1)
    off() // antes de que se resuelva la promesa del id
    await new Promise((r) => setTimeout(r, 5))
    expect(calls.some((c) => c.cmd === 'unsubscribe' && (c.args as { subscriptionId: string }).subscriptionId === 'sub-1')).toBe(true)
  })
  it('Ola 1: exec, pull, create y stacks ya son reales (solo connections sigue simulado)', () => {
    const api = createTauriApi()
    expect(api.capabilities).toMatchObject({ exec: 'live', pull: 'live', create: 'live', stacks: 'live', containers: 'live', connections: 'simulated' })
    expect(calls).toHaveLength(0)
  })
})

// ---------------- Contrato serde del backend (fixtures tipadas) ----------------
import { createEngineStore } from '../../store/engineStore'
import { describePlan } from '@/components/shared/planDescribe'
import * as F from './contract.fixtures'

describe('contrato serde del backend', () => {
  it('los comandos usados son los del backend', async () => {
    const api = createTauriApi()
    handler = () => undefined
    await api.connection.reconnect()
    await api.actions.cancel('t')
    expect(calls.map((c) => c.cmd)).toEqual(['reconnect', 'cancel_action'])
  })
  it('system.usage llama a system_usage y devuelve la forma serde del backend', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'system_usage' ? F.systemUsage : undefined)
    const u = await api.system.usage()
    expect(calls).toEqual([{ cmd: 'system_usage', args: undefined }])
    expect(u.host.cpu_count).toBe(24)
    expect(u.disk.build_cache.total_bytes).toBeNull()
    expect(u.container_disk[0].size_rw_bytes).toBe(3_051_520)
  })
  it('system.gpu llama a gpu_status; ante cualquier fallo o forma rara devuelve [] (sin error visible)', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'gpu_status' ? F.gpus : undefined)
    expect((await api.system.gpu())[0].name).toContain('RTX 5060')
    expect(calls).toEqual([{ cmd: 'gpu_status', args: undefined }])
    handler = () => { throw new Error('nvidia-smi ausente') }
    expect(await api.system.gpu()).toEqual([])
    handler = () => ({ no: 'es una lista' }) as never
    expect(await api.system.gpu()).toEqual([])
  })
  it('statsSnapshot llama a container_stats_snapshot{ids} SIN abrir suscripciones y sin cortar a 12', async () => {
    const api = createTauriApi()
    handler = (cmd) => (cmd === 'container_stats_snapshot' ? F.snapshot : undefined)
    const ids = Array.from({ length: 40 }, (_, i) => `id${i}`)
    const rows = await api.containers.statsSnapshot(ids)
    expect(calls).toEqual([{ cmd: 'container_stats_snapshot', args: { ids } }])
    expect(rows[0].stats?.cpu_percent).toBe(6.8)
    expect(rows[1]).toMatchObject({ stats: null, error: { code: 'timeout' } })
  })
  it('el store lanza el primer muestreo tras cargar y solo un vuelo a la vez', async () => {
    let inFlight = 0
    let peak = 0
    let n = 0
    handler = (cmd) => {
      if (cmd === 'container_stats_snapshot') {
        n++
        inFlight++
        peak = Math.max(peak, inFlight)
        return new Promise((r) => setTimeout(() => { inFlight--; r(F.snapshot) }, 60)) as never
      }
      return ({ connection_status: F.statusConnected, list_containers: [F.container], list_images: [], list_volumes: [], list_networks: [] } as Record<string, unknown>)[cmd]
    }
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 10, storage: null })
    await store.getState().bootstrap()
    await new Promise((r) => setTimeout(r, 200))
    expect(n).toBeGreaterThan(1)
    expect(peak).toBe(1)
    expect(store.getState().stats[F.container.id]?.cpu_percent).toBe(6.8)
    store.getState().dispose()
  })
  it('las listas del backend se cargan tal cual en el store (bootstrap con fixtures)', async () => {
    handler = (cmd) => ({ connection_status: F.statusConnected, list_containers: [F.container], list_images: [F.image], list_volumes: [F.volume], list_networks: [F.network] } as Record<string, unknown>)[cmd]
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const s = store.getState()
    expect(s.connection.status).toBe('connected')
    expect(s.containers.byId[F.container.id].names[0]).toBe('tienda-api-1')
    expect(s.volumes.ids).toEqual(['datos'])
    store.getState().dispose()
  })
  it('un fallo de permisos del backend produce el diagnóstico de permisos', async () => {
    handler = (cmd) => (cmd === 'connection_status' ? F.statusPermission : [])
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const c = store.getState().connection
    expect(c.status === 'error' && c.issue).toBe('permission')
    store.getState().dispose()
  })
  it('los feeds llegan por Channel con la etiqueta `type` y alimentan el store', async () => {
    let onEvent: { onmessage: (m: unknown) => void } | null = null
    handler = (cmd, args) => {
      if (cmd === 'subscribe_engine_events') { onEvent = args!.onEvent as typeof onEvent; return 'sub-ev' }
      return ({ connection_status: F.statusConnected, list_containers: [F.container], list_images: [], list_volumes: [], list_networks: [] } as Record<string, unknown>)[cmd]
    }
    const store = createEngineStore(createTauriApi(), { statsIntervalMs: 0, storage: null, debounce: { containers: 1, others: 1 } })
    await store.getState().bootstrap()
    onEvent!.onmessage(F.feedConnection)
    expect(store.getState().connection.status).toBe('lost')
    expect(store.getState().containers.ids).toHaveLength(1)
    store.getState().dispose()
  })
  it('los planes del backend (con avisos etiquetados) se describen sin error en los 3 niveles', () => {
    const d = describePlan(F.planConfirm, F.requests[0])
    expect(d.title).toBe('Eliminar contenedor')
    expect(describePlan(F.planTyped, F.requests[3]).okLabel).toBe('Eliminar volumen')
    expect(F.planDeny.decision).toEqual({ type: 'deny', reason: 'forbidden' })
    expect(F.outcome.failed[0].error.code).toBe('state_changed')
  })
})

import { apiErrorMessage } from '../../errors'
describe('errores: tope de planes pendientes', () => {
  it('tiene mensaje propio, no «Docker rechazó…»', () => {
    const m = apiErrorMessage({ code: 'conflict', message: 'demasiados planes pendientes: confirma o cancela alguno antes de crear otro' })
    expect(m.title).toContain('demasiadas acciones pendientes')
    expect(apiErrorMessage({ code: 'conflict', message: 'volume in use' }).title).toContain('Docker rechazó')
  })
})
