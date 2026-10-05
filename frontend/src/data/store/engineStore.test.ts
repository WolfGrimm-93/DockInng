import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSimApi, type SimEngineApi } from '../adapters/sim'
import { getToasts, toast } from '@/lib/toastStore'
import { createEngineStore, type EngineStore } from './engineStore'
import { containerCounts, findContainer, listOf, navCounts, totalImageBytes } from './selectors'

let api: SimEngineApi
let store: EngineStore
const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  toast.clear()
  api = createSimApi({ latency: 0, tick: 1 })
  // minRefreshGapMs: 0 → los tests de semántica de eventos no esperan el límite de ritmo (se prueba aparte).
  store = createEngineStore(api, { statsIntervalMs: 0, storage: null, debounce: { containers: 5, others: 5 }, minRefreshGapMs: 0 })
})
afterEach(() => store.getState().dispose())

describe('engineStore', () => {
  it('bootstrap: conecta y carga las 4 colecciones normalizadas por id', async () => {
    await store.getState().bootstrap()
    const s = store.getState()
    expect(s.connection.status).toBe('connected')
    expect(s.containers.status).toBe('ready')
    expect(s.containers.ids).toHaveLength(13)
    expect(Object.keys(s.containers.byId)).toHaveLength(13)
    expect(s.images.ids).toHaveLength(12)
    expect(containerCounts(s)).toEqual({ total: 13, running: 7, stopped: 4 })
    expect(navCounts(s)).toEqual({ containers: '7/13', images: 12, volumes: 7, networks: 6, stacks: 2 })
    expect(totalImageBytes(listOf(s.images))).toBeGreaterThan(0)
  })
  it('findContainer: por nombre, id completo y prefijo de id', async () => {
    await store.getState().bootstrap()
    const c = findContainer(store.getState(), 'tienda-api-1')!
    expect(findContainer(store.getState(), c.id)?.id).toBe(c.id)
    expect(findContainer(store.getState(), c.id.slice(0, 8))?.id).toBe(c.id)
    expect(findContainer(store.getState(), 'no-existe')).toBeUndefined()
  })
  it('runContainerOp: spinner por fila y refresco; el fallo de mailpit deja error en su fila y toast rojo', async () => {
    await store.getState().bootstrap()
    const mail = findContainer(store.getState(), 'mailpit-pruebas')!
    const p = store.getState().runContainerOp(mail.id, 'start')
    expect(store.getState().rowOps[mail.id]?.busy).toBe('start')
    expect(await p).toBe(false)
    expect(store.getState().rowOps[mail.id]).toMatchObject({ error: expect.stringContaining('8025'), tried: true })
    expect(getToasts().some((t) => t.kind === 'err')).toBe(true)
    expect(await store.getState().runContainerOp(mail.id, 'start')).toBe(true)
    expect(store.getState().rowOps[mail.id]).toBeUndefined()
    expect(findContainer(store.getState(), 'mailpit-pruebas')!.state).toBe('running')
  })
  it('evento destroy: se quita del store al instante; otros eventos provocan refetch', async () => {
    await store.getState().bootstrap()
    const c = findContainer(store.getState(), 'minio-dev')!
    api.sim.world.containers = api.sim.world.containers.filter((x) => x.id !== c.id)
    api.sim.emit({ type: 'events', resync: false, items: [{ kind: 'container', action: 'destroy', id: c.id, name: null, time_nano: 0, attributes: {} }] })
    expect(store.getState().containers.byId[c.id]).toBeUndefined()
    await settle()
    expect(store.getState().containers.ids).toHaveLength(12)
    // evento start sobre otro contenedor: refetch refleja el cambio real
    const w = api.sim.world.containers.find((x) => x.names[0] === 'wiki-outline-1')!
    w.state = 'running'
    api.sim.emit({ type: 'events', resync: false, items: [{ kind: 'container', action: 'start', id: w.id, name: null, time_nano: 0, attributes: {} }] })
    await settle()
    expect(store.getState().containers.byId[w.id].state).toBe('running')
  })
  it('ráfagas de eventos: dos listados del mismo tipo nunca quedan a menos de minRefreshGapMs', async () => {
    store.getState().dispose()
    store = createEngineStore(api, { statsIntervalMs: 0, storage: null, debounce: { containers: 1, others: 1 }, minRefreshGapMs: 120 })
    await store.getState().bootstrap()
    const stamps: number[] = []
    const orig = api.containers.list.bind(api.containers)
    api.containers.list = (a) => { stamps.push(Date.now()); return orig(a) }
    // 8 ráfagas separadas 20 ms: sin límite de ritmo, cada una provocaría un listado.
    for (let i = 0; i < 8; i++) {
      api.sim.emit({ type: 'events', resync: false, items: [{ kind: 'container', action: 'start', id: api.sim.world.containers[0].id, name: null, time_nano: 0, attributes: {} }] })
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.length).toBeLessThan(8)
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(110)
  })
  it('conexión perdida: se conservan los datos y se puede recuperar con reconectar', async () => {
    await store.getState().bootstrap()
    api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'daemon_down', message: 'boom', steps: [] } })
    expect(store.getState().connection.status).toBe('lost')
    expect(store.getState().containers.ids).toHaveLength(13)
    await store.getState().retry()
    expect(store.getState().connection.status).toBe('connected')
  })
  it('fallo de conexión: error con diagnóstico (permiso / daemon) y sin datos', async () => {
    api.sim.setFault('permission')
    await store.getState().bootstrap()
    const c = store.getState().connection
    expect(c.status).toBe('error')
    if (c.status !== 'error') return
    expect(c.issue).toBe('permission')
    expect(c.diagnostic.steps.map((s) => s.state)).toEqual(['ok', 'fail', 'skip'])
    expect(c.diagnostic.steps[1].command).toBe('sudo usermod -aG docker $USER')
    expect(store.getState().containers.status).toBe('idle')
    // reintentar sin arreglar: sigue en error + toast
    await store.getState().retry()
    expect(store.getState().connection.status).toBe('error')
    expect(getToasts().at(-1)?.msg).toBe('Sigue sin conectar')
  })
  it('daemon apagado y SSH tienen su propio diagnóstico', async () => {
    api.sim.setFault('daemon')
    await store.getState().bootstrap()
    let c = store.getState().connection
    expect(c.status === 'error' && c.issue).toBe('daemon')
    api.sim.setFault(null)
    await store.getState().bootstrap()
    await store.getState().selectProfile('staging')
    c = store.getState().connection
    expect(c.status === 'error' && c.issue).toBe('ssh')
    if (c.status === 'error') expect(c.diagnostic.steps[1].command).toBe('ssh ops@192.168.1.40 docker info')
  })
  it('previewConnection muestra el panel sin tocar el motor', async () => {
    await store.getState().bootstrap()
    store.getState().previewConnection('daemon')
    const c = store.getState().connection
    expect(c.status === 'error' && c.issue).toBe('daemon')
  })
  it('polling: se persiste en el storage', () => {
    const mem = new Map<string, string>()
    const st = createEngineStore(api, { statsIntervalMs: 0, storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) } })
    st.getState().setPolling(true)
    expect(mem.get('dockinng.poll')).toBe('1')
    st.getState().dispose()
  })
})

describe('runContainerOps', () => {
  it('concurrencia limitada, UN refresco y UN toast resumen', async () => {
    await store.getState().bootstrap()
    toast.clear()
    const stopped = listOf(store.getState().containers).filter((c) => c.state === 'exited' && c.names[0] !== 'mailpit-pruebas').map((c) => c.id)
    let inFlight = 0
    let peak = 0
    const orig = api.containers.start
    api.containers.start = async (id) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return orig(id)
    }
    let lists = 0
    const ol = api.containers.list
    api.containers.list = async (a) => { lists++; return ol(a) }
    const many = [...stopped, ...stopped]
    const r = await store.getState().runContainerOps(many, 'start', { concurrency: 1 })
    expect(r.ok).toBe(stopped.length)
    expect(peak).toBe(1)
    expect(lists).toBe(1)
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]).toMatchObject({ kind: 'ok' })
  })
  it('concurrencia por defecto 6 y toast parcial cuando alguno falla', async () => {
    await store.getState().bootstrap()
    toast.clear()
    const all = listOf(store.getState().containers).filter((c) => c.state !== 'running').map((c) => c.id)
    let inFlight = 0
    let peak = 0
    const orig = api.containers.start
    api.containers.start = async (id) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return orig(id)
    }
    const r = await store.getState().runContainerOps(all, 'start') // mailpit falla la 1ª vez
    expect(peak).toBeLessThanOrEqual(6)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error.code).toBe('conflict')
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0].kind).toBe('warn')
    expect(store.getState().rowOps[r.failed[0].id]?.error).toBeTruthy()
  })
  it('todo falla -> un toast de error; sin conexión no hace nada', async () => {
    await store.getState().bootstrap()
    toast.clear()
    const mail = listOf(store.getState().containers).find((c) => c.names[0] === 'mailpit-pruebas')!
    const r = await store.getState().runContainerOps([mail.id], 'start')
    expect(r.ok).toBe(0)
    expect(getToasts().map((t) => t.kind)).toEqual(['err'])
    store.getState().markLost()
    expect(await store.getState().runContainerOps([mail.id], 'start')).toEqual({ ok: 0, failed: [] })
  })
})

describe('feedback: estadísticas y reconexión', () => {
  it('el primer muestreo de stats llega tras cargar la lista (no «—» hasta el 2º tick)', async () => {
    const st = createEngineStore(api, { statsIntervalMs: 60_000, storage: null })
    st.getState().retainStats() // sin consumidor (vista) no se muestrea
    await st.getState().bootstrap()
    await settle()
    expect(Object.keys(st.getState().stats).length).toBe(7)
    st.getState().dispose()
  })
  it('retry estando «lost» y fallando conserva la conexión perdida y la lista', async () => {
    await store.getState().bootstrap()
    store.getState().markLost()
    api.sim.setFault('daemon')
    await store.getState().retry()
    expect(store.getState().connection.status).toBe('lost')
    expect(store.getState().containers.ids).toHaveLength(13)
  })
})
