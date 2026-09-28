import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSimApi } from './adapters/sim'
import { createEngineStore } from './store/engineStore'
import { resetShellPrefs, useShellPrefs } from './shellPrefs'
import { BATCH_MS, DEDUPE_MS, ruleFor, startNotifications } from './notifications'
import type { EngineEvent } from './types'

const ev = (action: string, over: Partial<EngineEvent> = {}): EngineEvent => ({ kind: 'container', action, id: 'c1', name: 'web', time_nano: 1, attributes: { name: 'web', exitCode: '1' }, ...over })

describe('ruleFor', () => {
  it('die con exitCode ≠ 0 avisa; con 0, sin exitCode o iniciado por la app no', () => {
    expect(ruleFor(ev('die'), false)?.kind).toBe('die')
    expect(ruleFor(ev('die', { attributes: { name: 'web', exitCode: '0' } }), false)).toBeNull()
    expect(ruleFor(ev('die', { attributes: { name: 'web' } }), false)).toBeNull()
    expect(ruleFor(ev('die'), true)).toBeNull()
  })
  it('oom y unhealthy avisan; healthy, start y otros tipos de recurso no', () => {
    expect(ruleFor(ev('oom'), false)?.kind).toBe('oom')
    expect(ruleFor(ev('health_status: unhealthy'), false)?.kind).toBe('unhealthy')
    expect(ruleFor(ev('health_status: healthy'), false)).toBeNull()
    expect(ruleFor(ev('start'), false)).toBeNull()
    expect(ruleFor(ev('die', { kind: 'image' }), false)).toBeNull()
  })
  it('el nombre es una sola línea y se recorta (dato no confiable)', () => {
    const r = ruleFor(ev('oom', { attributes: { name: `${'x'.repeat(200)}\n<img src=x>` } }), false)
    expect(r?.name.length).toBeLessThanOrEqual(60)
    expect(r?.name).not.toContain('\n')
  })
})

describe('startNotifications', () => {
  let timers: (() => void)[] = []
  let t = 1_000_000
  const opts = () => ({ now: () => t, setTimer: (fn: () => void) => { timers.push(fn); return 0 }, idle: () => true })
  const setup = () => {
    const api = createSimApi({ latency: 0, tick: 5 })
    const store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    const stop = startNotifications(api, store, opts())
    const flush = () => { const f = timers; timers = []; f.forEach((x) => x()) }
    return { api, store, stop, flush }
  }
  beforeEach(() => { timers = []; t = 1_000_000; resetShellPrefs() })
  afterEach(() => { resetShellPrefs(); vi.useRealTimers() })
  const on = (events?: Partial<Record<'die' | 'oom' | 'unhealthy' | 'op_done', boolean>>) => useShellPrefs.setState({ notifyEnabled: true, notifyEvents: { die: true, oom: true, unhealthy: true, op_done: true, ...events } })
  const emit = (api: ReturnType<typeof setup>['api'], items: EngineEvent[]) => api.sim.emit({ type: 'events', resync: false, items })

  it('con los avisos apagados no envía nada', () => {
    const { api, flush } = setup()
    emit(api, [ev('die')])
    flush()
    expect(api.sim.window.notifications).toHaveLength(0)
  })
  it('una caída envía UN aviso tras el lote; un tipo desactivado no', () => {
    on({ oom: false })
    const { api, flush } = setup()
    emit(api, [ev('die'), ev('oom', { id: 'c2' })])
    flush()
    expect(api.sim.window.notifications).toEqual([{ kind: 'die', title: 'Un contenedor se detuvo con error', body: 'web' }])
  })
  it('no mezcla tipos distintos en un resumen: cada aviso conserva su significado', () => {
    on()
    const { api, flush } = setup()
    emit(api, [ev('die'), ev('oom', { id: 'c2', attributes: { name: 'db', exitCode: '137' } }), ev('health_status: unhealthy', { id: 'c3', attributes: { name: 'api' } })])
    flush()
    expect(api.sim.window.notifications).toEqual([
      { kind: 'die', title: 'Un contenedor se detuvo con error', body: 'web' },
      { kind: 'oom', title: 'Un contenedor se quedó sin memoria', body: 'db' },
      { kind: 'unhealthy', title: 'Un contenedor no está sano', body: 'api' },
    ])
  })
  it('anti-ruido: el mismo contenedor y tipo no repite antes de 30 s; después sí', () => {
    on()
    const { api, flush } = setup()
    emit(api, [ev('die')]); flush()
    emit(api, [ev('die')]); flush()
    expect(api.sim.window.notifications).toHaveLength(1)
    t += DEDUPE_MS + 1
    emit(api, [ev('die')]); flush()
    expect(api.sim.window.notifications).toHaveLength(2)
  })
  it('varias caídas seguidas se agrupan en un resumen', () => {
    on()
    const { api, flush } = setup()
    emit(api, ['a', 'b', 'c', 'd'].map((n) => ev('die', { id: n, attributes: { name: `svc-${n}`, exitCode: '2' } })))
    flush()
    expect(api.sim.window.notifications).toHaveLength(1)
    expect(api.sim.window.notifications[0].title).toBe('4 contenedores cayeron')
    expect(api.sim.window.notifications[0].body).toBe('svc-a, svc-b, svc-c y 1 más')
    expect(BATCH_MS).toBeGreaterThan(0)
  })
  it('una parada iniciada por la propia app (rowOps ocupado) no es una caída', () => {
    on()
    const { api, store, flush } = setup()
    store.setState({ rowOps: { c1: { busy: 'stop' } } })
    emit(api, [ev('die')]); flush()
    expect(api.sim.window.notifications).toHaveLength(0)
  })
  it('descarga terminada con la ventana sin mirar avisa como op_done; cancelada no; con op_done apagado no', () => {
    on()
    const { api, store } = setup()
    const pull = (state: 'pulling' | 'done' | 'canceled') => ({ reference: 'nginx:1', state, layers: [], doneBytes: 0, totalBytes: 0, upToDate: false, digest: null, error: null })
    store.setState({ pulls: { 'nginx:1': pull('pulling') } })
    store.setState({ pulls: { 'nginx:1': pull('done') } })
    expect(api.sim.window.notifications).toEqual([{ kind: 'op_done', title: 'Descarga terminada', body: 'nginx:1' }])
    store.setState({ pulls: { 'nginx:1': pull('pulling') } })
    store.setState({ pulls: { 'nginx:1': pull('canceled') } })
    expect(api.sim.window.notifications).toHaveLength(1)
    on({ op_done: false })
    store.setState({ pulls: { 'nginx:2': pull('pulling') } })
    store.setState({ pulls: { 'nginx:2': pull('done') } })
    expect(api.sim.window.notifications).toHaveLength(1)
  })
  it('la baja deja de escuchar', () => {
    on()
    const { api, stop, flush } = setup()
    stop()
    emit(api, [ev('die')]); flush()
    expect(api.sim.window.notifications).toHaveLength(0)
  })
})
