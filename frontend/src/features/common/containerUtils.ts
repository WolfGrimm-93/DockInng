// Utilidades puras sobre Container (sin React): puertos legibles, «está encendido», búsqueda.
import { containerName } from '@/data/store/engineStore'
import type { Container, ContainerState } from '@/data/types'

/** «8080:80, 443, 5353:53/udp» — sin duplicados (IPv4/IPv6). «—» si no hay puertos. */
export function portsText(c: Pick<Container, 'ports'>): string {
  const seen: string[] = []
  for (const p of c.ports) {
    const proto = p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''
    const t = p.public_port != null ? `${p.public_port}:${p.private_port}${proto}` : `${p.private_port}${proto}`
    if (!seen.includes(t)) seen.push(t)
  }
  return seen.length ? seen.join(', ') : '—'
}

export const isOn = (s: ContainerState): boolean => s === 'running' || s === 'paused' || s === 'restarting'
export const isStoppedState = (s: ContainerState): boolean => s === 'exited' || s === 'dead' || s === 'created'

export type StateFilter = 'all' | 'running' | 'stopped'

export function matchesContainer(c: Container, filter: StateFilter, query: string): boolean {
  if (filter === 'running' && c.state !== 'running') return false
  if (filter === 'stopped' && !isStoppedState(c.state)) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${containerName(c)} ${c.image} ${c.id} ${portsText(c)}`.toLowerCase().includes(q)
}
