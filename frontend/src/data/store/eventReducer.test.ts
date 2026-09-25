import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../types'
import { planRefresh } from './eventReducer'

const ev = (kind: EngineEvent['kind'], action: string, id = 'abc'): EngineEvent => ({ kind, action, id, name: null, time_nano: 0, attributes: {} })

describe('planRefresh', () => {
  it('start (docker run coalescido) y die refrescan también imágenes, volúmenes y redes', () => {
    for (const a of ['start', 'die']) {
      expect(planRefresh([ev('container', a)])).toMatchObject({ containers: true, images: true, volumes: true, networks: true, removedContainerIds: [] })
    }
  })
  it('stop/pause/unpause/kill/oom/rename refrescan solo contenedores', () => {
    for (const a of ['stop', 'pause', 'unpause', 'kill', 'oom', 'rename']) {
      const p = planRefresh([ev('container', a)])
      expect(p).toMatchObject({ containers: true, images: false, volumes: false, networks: false, removedContainerIds: [] })
    }
  })
  it('health_status llega con sufijo («health_status: healthy»)', () => {
    expect(planRefresh([ev('container', 'health_status: healthy')]).containers).toBe(true)
  })
  it('destroy elimina al instante y refresca imágenes/volúmenes/redes (en uso / usado por)', () => {
    const p = planRefresh([ev('container', 'destroy', 'x1')])
    expect(p.removedContainerIds).toEqual(['x1'])
    expect(p).toMatchObject({ containers: true, images: true, volumes: true, networks: true })
  })
  it('eventos de imagen/volumen/red refrescan solo su colección; acciones ajenas se ignoran', () => {
    expect(planRefresh([ev('image', 'pull')])).toMatchObject({ images: true, containers: false })
    expect(planRefresh([ev('volume', 'create')])).toMatchObject({ volumes: true, images: false })
    expect(planRefresh([ev('network', 'connect')])).toMatchObject({ networks: true })
    expect(planRefresh([ev('container', 'exec_start')]).containers).toBe(false)
    expect(planRefresh([ev('daemon', 'reload')])).toMatchObject({ containers: false })
  })
  it('resync fuerza refrescar todo', () => {
    expect(planRefresh([], true)).toMatchObject({ containers: true, images: true, volumes: true, networks: true })
  })
})
