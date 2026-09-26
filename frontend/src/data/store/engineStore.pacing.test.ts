// Ritmo del muestreo de stats (optimización): solo con consumidor, en pausa con la ventana oculta, ≥ slowStatsMs sin foco tras la gracia,
// refresco inmediato al volver, e identidad conservada de las muestras que no cambian. Números medidos con contadores de llamadas al motor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSimApi, type SimEngineApi } from '@/data/adapters/sim'
import { BLUR_GRACE_MS, installWindowActivity, isIdle, resetWindowActivity } from '@/lib/windowActivity'
import type { ContainerStats } from '../types'
import { createEngineStore, mergeStats, sameStatsValues, type EngineStore } from './engineStore'

const st = (o: Partial<ContainerStats> = {}): ContainerStats => ({
  read_at: '2026-09-26T10:00:00Z', cpu_percent: 1, mem_used_bytes: 100, mem_limit_bytes: 1000, mem_percent: 10, net_rx_bytes: 5, net_tx_bytes: 5,
  net_rx_bytes_per_sec: 0, net_tx_bytes_per_sec: 0, block_read_bytes: 0, block_write_bytes: 0, pids: 3, ...o,
})

describe('mergeStats', () => {
  it('conserva la identidad de lo que no cambió (aunque cambie read_at) y devuelve null si nada cambió', () => {
    const a = { x: st(), y: st({ cpu_percent: 2 }) }
    expect(mergeStats(a, { x: st({ read_at: 'otra hora' }), y: st({ cpu_percent: 2, read_at: 'otra' }) })).toBeNull()
    const m = mergeStats(a, { x: st({ read_at: 'nueva' }), y: st({ cpu_percent: 9 }) })!
    expect(m.x).toBe(a.x) // misma referencia: la fila memoizada no se repinta
    expect(m.y).not.toBe(a.y)
    expect(m.y.cpu_percent).toBe(9)
  })
  it('detecta ids nuevos y ids que desaparecen', () => {
    const a = { x: st() }
    expect(mergeStats(a, { x: st(), z: st() })).toHaveProperty('z')
    expect(mergeStats({ x: st(), z: st() }, { x: st() })).toEqual({ x: st() })
    expect(mergeStats({}, {})).toBeNull()
  })
  it('sameStatsValues compara todos los valores visibles', () => {
    expect(sameStatsValues(st(), st({ pids: 4 }))).toBe(false)
    expect(sameStatsValues(st(), st({ read_at: 'x' }))).toBe(true)
  })
})

describe('ritmo del muestreo (contadores de statsSnapshot)', () => {
  let api: SimEngineApi
  let store: EngineStore
  let count: number
  let visible: 'visible' | 'hidden'
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush() }
  const setVisibility = (v: 'visible' | 'hidden') => { visible = v; document.dispatchEvent(new Event('visibilitychange')) }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    visible = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible })
    resetWindowActivity()
    installWindowActivity()
    api = createSimApi({ latency: 0, tick: 1 })
    count = 0
    const orig = api.containers.statsSnapshot
    api.containers.statsSnapshot = async (ids) => { count++; return orig(ids) }
    store = createEngineStore(api, { statsIntervalMs: 4000, slowStatsMs: 8000, storage: null })
    await store.getState().bootstrap()
    await flush()
  })
  afterEach(() => {
    store.getState().dispose()
    resetWindowActivity()
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('sin consumidores no se pide nada al motor; el primer consumidor dispara un muestreo inmediato y al soltarlo se detiene', async () => {
    await tick(60_000)
    expect(count).toBe(0)
    const release = store.getState().retainStats()
    await flush()
    expect(count).toBe(1)
    expect(Object.keys(store.getState().stats).length).toBeGreaterThan(0)
    await tick(12_000)
    expect(count).toBe(4) // 1 inmediato + 3 ticks de 4 s
    release()
    release() // idempotente
    await tick(60_000)
    expect(count).toBe(4)
  })
  it('varios consumidores: el muestreo sigue hasta soltar el último', async () => {
    const a = store.getState().retainStats()
    const b = store.getState().retainStats()
    await flush()
    a()
    await tick(4000)
    expect(count).toBe(2)
    b()
    await tick(8000)
    expect(count).toBe(2)
  })
  it('ventana sin foco: tras la gracia el ritmo baja a ≥ slowStatsMs; al volver el foco refresca de inmediato', async () => {
    store.getState().retainStats()
    await flush()
    // Con foco: una muestra cada 4 s durante 40 s = 10 + la inmediata.
    await tick(40_000)
    const focused = count
    expect(focused).toBe(11)
    count = 0
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.classList.contains('window-blurred')).toBe(true) // el CSS pausa las animaciones
    await tick(BLUR_GRACE_MS) // gracia: sigue a ritmo normal
    const inGrace = count
    expect(inGrace).toBeGreaterThanOrEqual(2)
    expect(isIdle()).toBe(true)
    count = 0
    await tick(60_000)
    expect(count).toBeLessThanOrEqual(8) // ≥ 8 s entre muestras: como mucho 60/8 = 7.5 (frente a 15 con foco)
    expect(count).toBeGreaterThanOrEqual(5)
    count = 0
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(count).toBe(1) // refresco inmediato al recuperar el foco
    expect(document.documentElement.classList.contains('window-blurred')).toBe(false)
    await tick(4000)
    expect(count).toBe(2) // vuelve al ritmo normal
  })
  it('pestaña oculta: no se muestrea; al hacerse visible tras un rato refresca de inmediato', async () => {
    store.getState().retainStats()
    await flush()
    count = 0
    setVisibility('hidden')
    await tick(60_000)
    expect(count).toBe(0)
    setVisibility('visible')
    await flush()
    expect(count).toBe(1)
  })
  it('el consumo de disco/equipo (system_usage) sigue la misma política: solo con consumidor y no en segundo plano', async () => {
    let usage = 0
    const orig = api.system.usage
    api.system.usage = async () => { usage++; return orig() }
    await tick(120_000)
    expect(usage).toBe(0)
    store.getState().retainStats()
    await flush()
    expect(usage).toBe(1)
    window.dispatchEvent(new Event('blur'))
    await tick(BLUR_GRACE_MS + 1000)
    usage = 0
    await tick(180_000)
    expect(usage).toBe(0) // sin foco no se pide `df` (pesado)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(usage).toBe(1)
  })
  it('una muestra idéntica no notifica a los suscriptores (no hay repintado)', async () => {
    const fixed = st()
    api.containers.statsSnapshot = async (ids) => ids.map((id) => ({ id, stats: { ...fixed }, error: null }))
    let n = 0
    let last = store.getState().stats
    store.subscribe((s) => { if (s.stats !== last) { n++; last = s.stats } })
    store.getState().retainStats()
    await flush()
    await tick(20_000)
    expect(n).toBe(1) // solo la primera vez que aparecen; las 5 siguientes, idénticas, no cambian el estado
  })
})
