import { describe, expect, it } from 'vitest'
import type { Container, Network, NetworkEndpoint } from '@/data/types'
import { endpointsOf, groupNetworks, hasIp, ownNetworkNames } from './netinfo'

const ep = (name: string, ip: string | null = null, gw: string | null = null): NetworkEndpoint => ({ name, ip_address: ip, ipv6_address: null, gateway: gw, mac_address: null, aliases: [] })
const cont = (name: string, endpoints: NetworkEndpoint[]): Container =>
  ({ id: name.padEnd(64, '0'), names: [name], image: 'i', image_id: 's', state: 'running', status: '', created: 0, compose_project: null, compose_service: null, ports: [], mounts: [], networks: endpoints.map((e) => e.name), endpoints })
const net = (name: string, system = false): Network => ({ id: name, name, driver: 'bridge', scope: 'local', subnets: ['172.20.0.0/16'], internal: false, system, connected: [], compose_project: null })

describe('netinfo', () => {
  it('endpointsOf cae a los nombres de red sin IP si el backend no envía `endpoints`', () => {
    const old = { networks: ['a', 'b'] } as unknown as Container
    expect(endpointsOf(old).map((e) => [e.name, e.ip_address])).toEqual([['a', null], ['b', null]])
    expect(hasIp(old)).toBe(false)
  })
  it('hasIp: un contenedor detenido (redes sin IP) no tiene IP', () => {
    expect(hasIp(cont('x', [ep('a', '10.0.0.2')]))).toBe(true)
    expect(hasIp(cont('x', [ep('a')]))).toBe(false)
    expect(hasIp(cont('x', []))).toBe(false)
  })
  it('ownNetworkNames excluye las redes de sistema', () => {
    const c = cont('x', [ep('bridge', '172.17.0.2'), ep('tienda_default', '172.20.0.2')])
    expect(ownNetworkNames(c, new Set(['bridge', 'host', 'none']))).toEqual(['tienda_default'])
  })
  it('groupNetworks: unión de redes propias con sus miembros, IP por miembro, puerta de enlace y orden por nombre', () => {
    const cs = [
      cont('web', [ep('tienda_default', '172.20.0.2', '172.20.0.1'), ep('proxy', '172.30.0.5', '172.30.0.1'), ep('bridge', '172.17.0.9', '172.17.0.1')]),
      cont('db', [ep('tienda_default', '172.20.0.3', '172.20.0.1')]),
      cont('parado', [ep('tienda_default')]),
    ]
    const r = groupNetworks(cs, [net('tienda_default'), net('proxy'), net('bridge', true)])
    expect(r.map((g) => g.name)).toEqual(['proxy', 'tienda_default']) // sin bridge, ordenadas
    const td = r.find((g) => g.name === 'tienda_default')!
    expect(td.gateway).toBe('172.20.0.1')
    expect(td.members.map((m) => [m.c.names[0], m.endpoint.ip_address])).toEqual([['web', '172.20.0.2'], ['db', '172.20.0.3'], ['parado', null]])
    expect(td.info?.subnets).toEqual(['172.20.0.0/16'])
  })
  it('sin lista de redes cargada no se pierde nada: todas se consideran propias y sin metadatos', () => {
    const r = groupNetworks([cont('web', [ep('x', '10.0.0.2')])], [])
    expect(r).toHaveLength(1)
    expect(r[0].info).toBeNull()
  })
})
