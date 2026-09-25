// Redes e IPs de un contenedor y de un grupo (funciones puras, sin React).
// La IP viene del listado (`c.endpoints`); los alias de DNS solo del detalle (inspect). Si el backend no envía `endpoints`
// (versión antigua), se cae a los nombres de red sin IP en vez de fallar.
import type { Container, Network, NetworkEndpoint } from '@/data/types'

export function endpointsOf(c: Pick<Container, 'endpoints' | 'networks'>): NetworkEndpoint[] {
  if (Array.isArray(c.endpoints)) return c.endpoints
  return (c.networks ?? []).map((name) => ({ name, ip_address: null, ipv6_address: null, gateway: null, mac_address: null, aliases: [] }))
}

/** ¿Tiene alguna IP asignada? (un contenedor detenido conserva sus redes pero sin IP). */
export const hasIp = (c: Pick<Container, 'endpoints' | 'networks'>): boolean => endpointsOf(c).some((e) => e.ip_address || e.ipv6_address)

/** Nombres de las redes «propias» de un contenedor: se excluyen las de sistema (bridge, host, none). */
export function ownNetworkNames(c: Pick<Container, 'endpoints' | 'networks'>, systemNames: ReadonlySet<string>): string[] {
  return endpointsOf(c).map((e) => e.name).filter((n) => !systemNames.has(n))
}

export interface GroupNetwork {
  name: string
  /** Metadatos de la red (null si aún no se cargó la lista de redes). */
  info: Network | null
  /** Puerta de enlace: la primera que informe algún contenedor del grupo en esa red. */
  gateway: string | null
  members: { c: Container; endpoint: NetworkEndpoint }[]
}

/** Redes propias que usan los contenedores de un grupo, con quién está conectado a cada una y con qué IP. Ordenadas por nombre. */
export function groupNetworks(containers: readonly Container[], networks: readonly Network[]): GroupNetwork[] {
  const system = new Set(networks.filter((n) => n.system).map((n) => n.name))
  const byName = new Map<string, GroupNetwork>()
  for (const c of containers) {
    for (const e of endpointsOf(c)) {
      if (system.has(e.name)) continue
      let g = byName.get(e.name)
      if (!g) {
        g = { name: e.name, info: networks.find((n) => n.name === e.name) ?? null, gateway: null, members: [] }
        byName.set(e.name, g)
      }
      g.gateway ??= e.gateway
      g.members.push({ c, endpoint: e })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
