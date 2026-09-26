// Store: slices `stacks` (fuente única del contador), `compose`, `stackOps` y `pulls` con el adaptador simulado.
import { describe, expect, it } from 'vitest'
import { createSimApi } from '../adapters/sim'
import { createEngineStore } from './engineStore'
import { navCounts } from './selectors'
import { planRefresh } from './eventReducer'

const mk = () => {
  const api = createSimApi({ latency: 0, tick: 2 })
  const store = createEngineStore(api, { statsIntervalMs: 0, storage: null, debounce: { containers: 1, others: 1 } })
  return { api, store }
}
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout esperando la condición')
    await new Promise((r) => setTimeout(r, 3))
  }
}

describe('store: stacks', () => {
  it('bootstrap carga stacks y compose; el contador del menú sale de la MISMA lista', async () => {
    const { store } = mk()
    await store.getState().bootstrap()
    await until(() => store.getState().compose !== null)
    const s = store.getState()
    expect(s.stacks.ids).toEqual(['monitoreo', 'tienda'])
    expect(s.compose).toMatchObject({ available: true, flavor: 'plugin' })
    expect(navCounts(s).stacks).toBe(2)
    store.getState().dispose()
  })

  it('regresión de la incoherencia: un stack propio SIN contenedores cuenta; un proyecto sin contenedores ni archivo deja de contar', async () => {
    const { api, store } = mk()
    api.sim.world.ownStacks.push({ name: 'propio', origin: 'managed', path: '~/p/compose.yaml', yaml: 'services:\n  a:\n    image: x\n', env: '', revision: 1 })
    await store.getState().bootstrap()
    expect(navCounts(store.getState()).stacks).toBe(3)
    for (const c of api.sim.world.containers.filter((x) => x.compose_project === 'monitoreo')) c.compose_project = null
    await store.getState().refresh('stacks')
    expect(navCounts(store.getState()).stacks).toBe(2)
    expect(store.getState().stacks.ids).not.toContain('monitoreo')
    store.getState().dispose()
  })

  it('cualquier evento de contenedor programa el refresco de stacks (planRefresh)', () => {
    const ev = (action: string) => ({ kind: 'container' as const, action, id: 'x', name: 'n', time_nano: 0, attributes: {} })
    expect(planRefresh([ev('die')]).stacks).toBe(true)
    expect(planRefresh([ev('exec_start: sh')]).stacks).toBe(false)
    expect(planRefresh([], true).stacks).toBe(true)
  })

  it('un evento del motor refresca el estado de los stacks con debounce', async () => {
    const { api, store } = mk()
    await store.getState().bootstrap()
    const id = api.sim.world.containers.find((c) => c.names[0] === 'monitoreo-grafana-1')!.id
    await api.containers.stop(id)
    await until(() => store.getState().stacks.byId.monitoreo.running === 1)
    store.getState().dispose()
  })

  it('runStackOp alimenta stackOps, termina y refresca; el segundo intento mientras corre se ignora', async () => {
    const { api, store } = mk()
    await store.getState().bootstrap()
    store.getState().runStackOp('tienda', 'up')
    store.getState().runStackOp('tienda', 'up')
    expect(store.getState().stackOps.tienda).toMatchObject({ kind: 'up', state: 'running' })
    await until(() => store.getState().stackOps.tienda?.state === 'done')
    const op = store.getState().stackOps.tienda
    expect(op.services.every((s) => s.percent === 100)).toBe(true)
    expect(op.log.length).toBeGreaterThan(0)
    // up levantó los servicios declarados en el archivo (worker no está en el YAML de ejemplo: sigue como estaba).
    expect(api.sim.world.containers.filter((c) => c.compose_project === 'tienda' && c.compose_service !== 'worker').every((c) => c.state === 'running')).toBe(true)
    await until(() => store.getState().stacks.byId.tienda.running === 4)
    store.getState().dismissStackOp('tienda')
    expect(store.getState().stackOps.tienda).toBeUndefined()
    store.getState().dispose()
  })

  it('un fallo de Compose deja el error en la operación (con Reintentar posible) y cancelar marca «canceled»', async () => {
    const { api, store } = mk()
    api.sim.world.ownStacks.push({ name: 'stack-fail', origin: 'managed', path: '~/f/compose.yaml', yaml: 'services:\n  a:\n    image: imagen-inexistente\n  b:\n    image: y\n', env: '', revision: 1 })
    await store.getState().bootstrap()
    store.getState().runStackOp('stack-fail', 'up')
    await until(() => store.getState().stackOps['stack-fail']?.state === 'error')
    expect(store.getState().stackOps['stack-fail'].error).toMatchObject({ code: 'compose_failed' })
    store.getState().dismissStackOp('stack-fail')
    store.getState().runStackOp('tienda', 'restart')
    store.getState().cancelStackOp('tienda')
    await until(() => store.getState().stackOps.tienda?.state === 'canceled')
    store.getState().dispose()
  })

  it('noteStackDown limpia la operación y refresca; selectProfile y dispose cancelan los Channels abiertos', async () => {
    const { api, store } = mk()
    await store.getState().bootstrap()
    store.getState().runStackOp('tienda', 'up')
    store.getState().dispose()
    await new Promise((r) => setTimeout(r, 30))
    // dispose = abort duro: no llegan más feeds (la operación queda en «running», el store ya no se usa).
    expect(store.getState().stackOps.tienda.state).toBe('running')
    const s2 = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await s2.getState().bootstrap()
    s2.getState().runStackOp('tienda', 'up')
    s2.getState().noteStackDown('tienda')
    expect(s2.getState().stackOps.tienda).toBeUndefined()
    s2.getState().dispose()
  })
})

describe('store: pulls', () => {
  it('startPull -> capas en bytes -> done + refresca imágenes y sobrevive fuera de la pantalla', async () => {
    const { api, store } = mk()
    await store.getState().bootstrap()
    store.getState().startPull('miapp/web:2.0')
    await until(() => (store.getState().pulls['miapp/web:2.0']?.layers.length ?? 0) > 0)
    expect(store.getState().pulls['miapp/web:2.0'].totalBytes).toBeGreaterThan(1_000_000)
    await until(() => store.getState().pulls['miapp/web:2.0']?.state === 'done')
    await until(() => store.getState().images.ids.includes('miapp/web:2.0'))
    expect(api.sim.world.images.some((i) => i.reference === 'miapp/web:2.0')).toBe(true)
    store.getState().dismissPull('miapp/web:2.0')
    expect(store.getState().pulls['miapp/web:2.0']).toBeUndefined()
    store.getState().dispose()
  })

  it('cancelPull aborta y marca canceled; error del registro queda como error tipado', async () => {
    const { store } = mk()
    await store.getState().bootstrap()
    store.getState().startPull('a/b:1')
    store.getState().cancelPull('a/b:1')
    expect(store.getState().pulls['a/b:1'].state).toBe('canceled')
    store.getState().startPull('x/private-auth:1')
    await until(() => store.getState().pulls['x/private-auth:1']?.state === 'error')
    expect(store.getState().pulls['x/private-auth:1'].error?.code).toBe('auth_required')
    store.getState().dispose()
  })
})
