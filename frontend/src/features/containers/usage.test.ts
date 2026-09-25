import { describe, expect, it } from 'vitest'
import type { Container, ContainerStats, Volume } from '@/data/types'
import { groupDiskBytes, sumConsumption } from './usage'

const c = (id: string, name: string, state: Container['state'] = 'running'): Container =>
  ({ id, names: [name], image: 'img', image_id: 'x', state, status: '', created: 0, compose_project: null, compose_service: null, ports: [], labels: {}, networks: [] }) as unknown as Container
const st = (cpu: number, mem: number): ContainerStats =>
  ({ read_at: '', cpu_percent: cpu, mem_used_bytes: mem, mem_limit_bytes: 0, mem_percent: 0, net_rx_bytes: 0, net_tx_bytes: 0, net_rx_bytes_per_sec: 0, net_tx_bytes_per_sec: 0, block_read_bytes: 0, block_write_bytes: 0, pids: 1 })
const vol = (name: string, size: number | null, used_by: string[]): Volume =>
  ({ name, driver: 'local', mountpoint: '', created_at: null, labels: {}, compose_project: null, size_bytes: size, used_by, anonymous: false })

describe('sumConsumption', () => {
  it('suma solo los que están en marcha y tienen muestra; cuenta cuántos hay y cuántos con muestra', () => {
    const cs = [c('a', 'a'), c('b', 'b'), c('d', 'd', 'exited'), c('e', 'e')]
    const r = sumConsumption(cs, { a: st(10, 100), b: st(20.5, 200), d: st(99, 999) })
    expect(r).toEqual({ cpu: 30.5, memBytes: 300, running: 3, sampled: 2 })
  })
  it('ignora valores no finitos y conjuntos vacíos', () => {
    expect(sumConsumption([], {})).toEqual({ cpu: 0, memBytes: 0, running: 0, sampled: 0 })
    const r = sumConsumption([c('a', 'a')], { a: st(Number.NaN, Number.POSITIVE_INFINITY) })
    expect(r.cpu).toBe(0)
    expect(r.memBytes).toBe(0)
  })
})

describe('groupDiskBytes', () => {
  const cs = [c('a', 'web'), c('b', 'db')]
  const disk = [{ id: 'a', size_rw_bytes: 10 }, { id: 'b', size_rw_bytes: 20 }, { id: 'zzz', size_rw_bytes: 999 }]
  it('capa de escritura + volúmenes usados por el grupo (sin contar los de otros ni los desconocidos)', () => {
    const vols = [vol('datos', 1000, ['db']), vol('otro', 5000, ['ajeno']), vol('sin-tam', null, ['web'])]
    expect(groupDiskBytes(cs, vols, disk, true)).toBe(10 + 20 + 1000)
  })
  it('un volumen usado por dos contenedores del mismo grupo se cuenta una sola vez', () => {
    expect(groupDiskBytes(cs, [vol('compartido', 500, ['web', 'db'])], disk, true)).toBe(10 + 20 + 500)
  })
  it('sin df conocido devuelve null (desconocido, nunca cero)', () => {
    expect(groupDiskBytes(cs, [], [], false)).toBeNull()
  })
})
