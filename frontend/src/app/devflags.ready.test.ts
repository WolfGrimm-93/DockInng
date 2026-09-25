import { describe, expect, it } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { createEngineStore } from '@/data/store/engineStore'
import { navCounts } from '@/data/store/selectors'
import { applyPrepare, applyReady } from './devFlags'

describe('?state=error conserva los últimos contadores del sidebar', () => {
  it('conexión en error pero contadores 7/13, 12, 7, 6, 2', async () => {
    window.history.replaceState({}, '', '/?state=error')
    const api = createSimApi({ latency: 0 })
    applyPrepare(api)
    const store = createEngineStore(api, { statsIntervalMs: 0, storage: null })
    await store.getState().bootstrap()
    expect(store.getState().connection.status).toBe('error')
    applyReady(api, store)
    await new Promise((r) => setTimeout(r, 30))
    expect(navCounts(store.getState())).toEqual({ containers: '7/13', images: 12, volumes: 7, networks: 6, stacks: 2 })
    window.history.replaceState({}, '', '/')
    store.getState().dispose()
  })
})
