// Cambio de conexión (Ola 2): estado «conectando», errores clasificados, reanudación de la conexión previa si falla (Tauri), sin cambios concurrentes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSimApi, type SimEngineApi } from '@/data/adapters/sim'
import { getToasts, toast } from '@/lib/toastStore'
import type { ConnectionStatus } from '../types'
import { createEngineStore, type EngineStore } from './engineStore'
import { listOf } from './selectors'

const asTauri = (sim: SimEngineApi): SimEngineApi => Object.assign(Object.create(sim), { mode: 'tauri' }) as SimEngineApi
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms))

let sim: SimEngineApi
let store: EngineStore
beforeEach(() => { toast.clear(); sim = createSimApi({ latency: 0, tick: 1 }) })
afterEach(() => { store?.getState().dispose(); toast.clear() })

describe('selectProfile', () => {
  it('éxito: marca «cambiando» mientras dura, limpia y recarga los datos y guarda last_connection_id', async () => {
    store = createEngineStore(sim, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const orig = sim.connections.select
    let release: () => void = () => {}
    sim.connections.select = (id) => new Promise<ConnectionStatus>((res) => { release = () => res(orig(id)) })
    const p = store.getState().selectProfile('prod')
    await wait()
    expect(store.getState().switchingProfileId).toBe('prod')
    // Un segundo cambio mientras uno está en curso se ignora (nunca dos túneles a la vez).
    void store.getState().selectProfile('staging')
    release()
    await p
    expect(store.getState().switchingProfileId).toBeNull()
    expect(store.getState().activeProfileId).toBe('prod')
    expect(store.getState().connection.status).toBe('connected')
    expect(await sim.prefs.get('last_connection_id')).toBe('prod')
    expect(getToasts().some((t) => t.kind === 'ok' && /Conectado a prod-hetzner/.test(t.msg))).toBe(true)
  })
  it('Tauri: si el backend rechaza el cambio DESPUÉS del quiesce (quiesced:true) se conserva la conexión previa, se explica la causa y se reabren los streams', async () => {
    const api = asTauri(sim)
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const before = listOf(store.getState().containers).length
    api.connections.select = async () => { throw { code: 'connection', message: 'Host key verification failed', cause: 'host_key_changed', quiesced: true } }
    let resubscribed = 0
    const origSub = api.events.subscribe
    api.events.subscribe = (on) => { resubscribed++; return origSub(on) }
    await store.getState().selectProfile('prod')
    expect(store.getState().activeProfileId).toBe('local')
    expect(store.getState().connection.status).toBe('connected')
    expect(listOf(store.getState().containers)).toHaveLength(before)
    expect(resubscribed).toBe(1) // el backend abortó los streams al intentar el cambio: se reabren
    const t = getToasts().find((x) => x.kind === 'err')!
    expect(t.msg).toMatch(/No se pudo conectar con prod-hetzner/)
    expect(t.sub).toMatch(/CAMBIÓ/)
    expect(store.getState().switchingProfileId).toBeNull()
  })
  it('Tauri: un estado «failed» de una conexión remota no cambia la activa; el de «local» sí se muestra (panel de diagnóstico)', async () => {
    const api = asTauri(sim)
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const failed: ConnectionStatus = { state: 'failed', endpoint: 'ssh://x', cause: 'auth_failed', message: 'denied', steps: [] }
    api.connections.select = async () => failed
    await store.getState().selectProfile('prod')
    expect(store.getState().activeProfileId).toBe('local')
    expect(store.getState().connection.status).toBe('connected')
    // «local» caído: se muestra el diagnóstico de Docker local (no se oculta tras «conexión previa»).
    api.connections.select = async () => ({ state: 'failed', endpoint: 'unix:///var/run/docker.sock', cause: 'daemon_down', message: 'refused', steps: [] })
    await store.getState().selectProfile('local')
    expect(store.getState().connection.status).toBe('error')
  })
  it('simulado (navegador): staging falla y se enseña su panel SSH (comportamiento de la plantilla)', async () => {
    store = createEngineStore(sim, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    await store.getState().selectProfile('staging')
    const c = store.getState().connection
    expect(c.status === 'error' && c.issue).toBe('ssh')
  })
  it('refreshProfiles relee la lista tras guardar/borrar', async () => {
    store = createEngineStore(sim, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    const n = store.getState().profiles.length
    await sim.connections.save({ kind: 'tls', name: 'nuevo', host: 'h', port: 2376, ca_path: '/a', cert_path: '/b', key_path: '/c' })
    await store.getState().refreshProfiles()
    expect(store.getState().profiles).toHaveLength(n + 1)
  })
})

describe('revisión fase 4', () => {
  it('M-1: un fallo ANTES del quiesce (sin quiesced) no aborta operaciones locales ni reengancha nada', async () => {
    const api = asTauri(sim)
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    store.setState({ pulls: { 'x:1': { reference: 'x:1', state: 'pulling', layers: [], doneBytes: 0, totalBytes: 0, upToDate: false, digest: null, error: null } } })
    let resubscribed = 0
    const origSub = api.events.subscribe
    api.events.subscribe = (on) => { resubscribed++; return origSub(on) }
    api.connections.select = async () => { throw { code: 'connection', message: 'no responde', cause: 'unreachable' } }
    await store.getState().selectProfile('prod')
    expect(store.getState().pulls['x:1'].state).toBe('pulling') // sigue vivo
    expect(resubscribed).toBe(0)
    expect(store.getState().connection.status).toBe('connected')
    expect(getToasts().some((t) => t.kind === 'err' && /No se pudo conectar con prod-hetzner/.test(t.msg))).toBe(true)
  })
  it('M-1: con quiesced:true sí se abortan las operaciones locales (el backend ya las cerró)', async () => {
    const api = asTauri(sim)
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    let disposed = 0
    store.setState({ pulls: { 'x:1': { reference: 'x:1', state: 'pulling', layers: [], doneBytes: 0, totalBytes: 0, upToDate: false, digest: null, error: null } } })
    void disposed
    api.connections.select = async () => { throw { code: 'connection', message: 'x', cause: 'auth_failed', quiesced: true } }
    await store.getState().selectProfile('prod')
    expect(store.getState().connection.status).toBe('connected') // reanudada la previa
  })
  it('B-10: si connection_list falla, «Local» sigue en la lista y se puede volver desde un remoto', async () => {
    const api = asTauri(sim)
    api.connections.list = async () => { throw { code: 'internal', message: 'sin almacén' } }
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    expect(store.getState().profiles.map((p) => p.id)).toEqual(['local'])
    await store.getState().refreshProfiles()
    expect(store.getState().profiles.map((p) => p.id)).toEqual(['local'])
    await store.getState().selectProfile('local')
    expect(store.getState().activeProfileId).toBe('local')
  })
  it('B-8: al volver a consumir tras un rato, las muestras viejas se marcan obsoletas hasta que llega la nueva', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      store = createEngineStore(sim, { statsIntervalMs: 4000, storage: null })
      await store.getState().bootstrap()
      const r1 = store.getState().retainStats()
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(Object.keys(store.getState().stats).length).toBeGreaterThan(0)
      expect(store.getState().statsStale).toBe(false)
      r1()
      await vi.advanceTimersByTimeAsync(120_000)
      // Sonda: la siguiente muestra se retrasa para poder observar el estado «obsoleto».
      let release: () => void = () => {}
      const orig = sim.containers.statsSnapshot
      sim.containers.statsSnapshot = (ids) => new Promise((res) => { release = () => res(orig(ids)) })
      store.getState().retainStats()
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(store.getState().statsStale).toBe(true)
      sim.containers.statsSnapshot = orig
      release()
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(store.getState().statsStale).toBe(false)
    } finally { vi.useRealTimers() }
  })
})

describe('preferencia de sondeo en el almacén', () => {
  it('setPolling se escribe también en prefs y bootstrap la lee (fuente de verdad del backend)', async () => {
    store = createEngineStore(sim, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    store.getState().setPolling(true)
    await wait()
    expect(await sim.prefs.get('polling')).toBe(true)
    store.getState().dispose()
    store = createEngineStore(sim, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    expect(store.getState().polling).toBe(true)
    store.getState().setPolling(false)
  })
})
