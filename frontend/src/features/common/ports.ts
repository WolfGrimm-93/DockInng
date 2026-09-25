// Puertos de un contenedor para la tabla y el modal (funciones puras, sin React).
//
// Docker entrega UNA entrada por puerto y por familia de red: un contenedor con el rango 55110-55199 publicado en IPv4 e IPv6 llega como
// 180 entradas. Aquí se normaliza: se unen los duplicados IPv4/IPv6 (una fila con sus dos enlaces) y las tiradas de 3 o más puertos
// consecutivos se colapsan en un rango (`55110–55199/udp`), como hace la CLI de Docker. Nada se pierde: el total de puertos se conserva.
// La tabla muestra solo los PRINCIPALES (los 2 primeros por prioridad: publicados antes que solo expuestos, tcp antes que udp, número menor primero)
// y el resto va en el modal.
import type { PortMapping } from '@/data/types'

export interface PortEntry {
  /** Primer puerto en el equipo; `null` = el contenedor lo expone pero NO está publicado. */
  host: number | null
  /** Último puerto en el equipo (igual a `host` si no es rango). */
  hostEnd: number | null
  container: number
  containerEnd: number
  proto: string
  /** Enlaces del puerto publicado: «IPv4», «IPv6» o la IP concreta. Vacío si no está publicado. */
  bindings: string[]
  /** Cuántos puertos representa esta fila (1 salvo en un rango). */
  count: number
}

/** Mínimo de puertos consecutivos para colapsarlos en un rango (con 2 se dejan sueltos: p. ej. 9000 y 9001 de MinIO). */
export const MIN_RANGE = 3
/** Cuántos puertos se muestran en la tabla; con más filas aparece el ojo. */
export const MAIN_PORTS = 2

const bindingOf = (ip: string | null): string | null => {
  if (!ip) return null
  if (ip === '0.0.0.0') return 'IPv4'
  if (ip === '::') return 'IPv6'
  return ip
}
const protoRank = (p: string) => (p === 'tcp' ? 0 : p === 'udp' ? 1 : 2)

export function portEntries(ports: readonly PortMapping[]): PortEntry[] {
  // 1) Deduplicar por (público, privado, protocolo) uniendo las IP.
  const byKey = new Map<string, PortEntry>()
  for (const p of ports) {
    const key = `${p.public_port ?? ''}|${p.private_port}|${p.protocol}`
    let e = byKey.get(key)
    if (!e) {
      e = { host: p.public_port, hostEnd: p.public_port, container: p.private_port, containerEnd: p.private_port, proto: p.protocol, bindings: [], count: 1 }
      byKey.set(key, e)
    }
    const b = p.public_port != null ? bindingOf(p.ip) : null
    if (b && !e.bindings.includes(b)) e.bindings.push(b)
  }
  for (const e of byKey.values()) e.bindings.sort()

  // 2) Prioridad: publicados primero, tcp antes que udp, número menor primero.
  const sorted = [...byKey.values()].sort(
    (a, b) =>
      Number(a.host === null) - Number(b.host === null) ||
      protoRank(a.proto) - protoRank(b.proto) ||
      a.proto.localeCompare(b.proto) ||
      (a.host ?? a.container) - (b.host ?? b.container) ||
      a.container - b.container,
  )

  // 3) Colapsar tiradas de ≥ MIN_RANGE puertos consecutivos con el mismo protocolo y los mismos enlaces.
  const adjacent = (a: PortEntry, b: PortEntry) =>
    a.proto === b.proto &&
    (a.host === null) === (b.host === null) &&
    b.container === a.containerEnd + 1 &&
    (a.host === null || b.host === (a.hostEnd ?? 0) + 1) &&
    a.bindings.join() === b.bindings.join()
  const out: PortEntry[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && adjacent(sorted[j], sorted[j + 1])) j++
    if (j - i + 1 >= MIN_RANGE) {
      const first = sorted[i]
      const last = sorted[j]
      out.push({ ...first, hostEnd: last.hostEnd, containerEnd: last.containerEnd, count: j - i + 1 })
    } else {
      for (let k = i; k <= j; k++) out.push(sorted[k])
    }
    i = j + 1
  }
  return out
}

/** «8080:80», «80» (solo expuesto o igual en ambos lados), «5353:53/udp», «55110–55199/udp». */
export function portLabel(e: PortEntry): string {
  const range = (a: number, b: number) => (a === b ? String(a) : `${a}–${b}`)
  const proto = e.proto === 'tcp' ? '' : `/${e.proto}`
  const cont = range(e.container, e.containerEnd)
  if (e.host === null) return `${cont}${proto}`
  const host = range(e.host, e.hostEnd ?? e.host)
  return `${host === cont ? host : `${host}:${cont}`}${proto}`
}

export const mainPorts = (entries: readonly PortEntry[], n: number = MAIN_PORTS): PortEntry[] => entries.slice(0, n)
export const totalPorts = (entries: readonly PortEntry[]): number => entries.reduce((a, e) => a + e.count, 0)
export const publishedPorts = (entries: readonly PortEntry[]): number => entries.reduce((a, e) => a + (e.host === null ? 0 : e.count), 0)

/** Texto compacto para la tabla: los principales separados por coma, «—» si no hay. */
export const mainPortsText = (entries: readonly PortEntry[]): string => (entries.length ? mainPorts(entries).map(portLabel).join(', ') : '—')
/** ¿Hay más puertos de los que caben en la tabla? (entonces aparece el ojo). */
export const hasMorePorts = (entries: readonly PortEntry[]): boolean => entries.length > MAIN_PORTS
