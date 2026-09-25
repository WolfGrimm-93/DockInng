import { describe, expect, it } from 'vitest'
import type { PortMapping } from '@/data/types'
import { hasMorePorts, mainPortsText, portEntries, portLabel, publishedPorts, totalPorts } from './ports'

const pub = (host: number, container = host, proto = 'tcp', ip: string | null = '0.0.0.0'): PortMapping => ({ ip, private_port: container, public_port: host, protocol: proto })
const exposed = (container: number, proto = 'tcp'): PortMapping => ({ ip: null, private_port: container, public_port: null, protocol: proto })

describe('portEntries', () => {
  it('une IPv4 e IPv6 del mismo puerto en una sola fila con sus dos enlaces', () => {
    const e = portEntries([pub(8000, 8000, 'tcp', '0.0.0.0'), pub(8000, 8000, 'tcp', '::')])
    expect(e).toHaveLength(1)
    expect(e[0].bindings).toEqual(['IPv4', 'IPv6'])
    expect(portLabel(e[0])).toBe('8000')
  })
  it('conserva una IP concreta y no publica los solo expuestos', () => {
    const e = portEntries([pub(5432, 5432, 'tcp', '127.0.0.1'), exposed(9000)])
    expect(e[0].bindings).toEqual(['127.0.0.1'])
    expect(e[1]).toMatchObject({ host: null, bindings: [] })
  })
  it('formato: publicado distinto «8080:80», igual «80», udp con sufijo, solo expuesto sin equipo', () => {
    const l = (p: PortMapping) => portLabel(portEntries([p])[0])
    expect(l(pub(8080, 80))).toBe('8080:80')
    expect(l(pub(80))).toBe('80')
    expect(l(pub(5353, 53, 'udp'))).toBe('5353:53/udp')
    expect(l(exposed(6379))).toBe('6379')
    expect(l(exposed(3478, 'udp'))).toBe('3478/udp')
  })
  it('prioridad: publicados antes que expuestos, tcp antes que udp, número menor primero', () => {
    const e = portEntries([exposed(5050), pub(9443), pub(53, 53, 'udp'), pub(8000), exposed(3478, 'udp')])
    expect(e.map(portLabel)).toEqual(['8000', '9443', '53/udp', '5050', '3478/udp'])
  })
  it('colapsa 3 o más puertos consecutivos en un rango y conserva el total; con 2 los deja sueltos', () => {
    const run = Array.from({ length: 90 }, (_, i) => pub(55110 + i, 55110 + i, 'udp'))
    const e = portEntries([...run, pub(9000), pub(9001)])
    expect(e.map(portLabel)).toEqual(['9000', '9001', '55110–55199/udp'])
    expect(e[2].count).toBe(90)
    expect(totalPorts(e)).toBe(92)
    expect(publishedPorts(e)).toBe(92)
  })
  it('un rango con puerto distinto en el contenedor se muestra «equipo–equipo:contenedor–contenedor»', () => {
    const e = portEntries([pub(8080, 80), pub(8081, 81), pub(8082, 82)])
    expect(e).toHaveLength(1)
    expect(portLabel(e[0])).toBe('8080–8082:80–82')
  })
  it('no une consecutivos con enlaces distintos ni de protocolos distintos', () => {
    const e = portEntries([pub(100, 100, 'tcp', '0.0.0.0'), pub(101, 101, 'tcp', '::'), pub(102, 102, 'tcp', '0.0.0.0'), pub(103, 103, 'udp')])
    expect(e).toHaveLength(4)
  })
  it('CASO REAL (screego): 189 entradas de la API con IPv4+IPv6 y un rango de 90 → pocas filas, ojo activo y nada perdido', () => {
    const raw: PortMapping[] = [exposed(3478), exposed(5050), exposed(3478, 'udp')]
    for (let p = 55100; p <= 55101; p++) raw.push(pub(p, p, 'tcp', '0.0.0.0'), pub(p, p, 'tcp', '::'))
    for (let p = 55110; p <= 55199; p++) raw.push(pub(p, p, 'udp', '0.0.0.0'), pub(p, p, 'udp', '::'))
    raw.push(pub(55101, 55101, 'udp', '0.0.0.0'), pub(55101, 55101, 'udp', '::'))
    const e = portEntries(raw)
    expect(e.length).toBeLessThanOrEqual(8)
    expect(hasMorePorts(e)).toBe(true)
    expect(totalPorts(e)).toBe(3 + 2 + 90 + 1)
    expect(mainPortsText(e)).toBe('55100, 55101')
  })
})

describe('mainPortsText / hasMorePorts', () => {
  it('«—» sin puertos y sin ojo con 2 o menos', () => {
    expect(mainPortsText([])).toBe('—')
    const two = portEntries([pub(1), exposed(2)])
    expect(hasMorePorts(two)).toBe(false)
    expect(mainPortsText(two)).toBe('1, 2')
  })
  it('con más de 2, muestra los 2 principales y activa el ojo', () => {
    const e = portEntries([pub(80), pub(443), pub(8080), exposed(9000)])
    expect(hasMorePorts(e)).toBe(true)
    expect(mainPortsText(e)).toBe('80, 443')
  })
})
