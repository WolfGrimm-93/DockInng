// Agrupación de la tabla de contenedores: cabeceras de stack/grupo propio + filas, color de cada grupo y sus miembros.
// Extraído de ContainersPage para que la página solo pinte. Las suscripciones al almacén de grupos viven aquí.
import { useCallback, useMemo } from 'react'
import type { Container, Network } from '@/data/types'
import { containerName } from '@/data/store/engineStore'
import { isOn } from '../common/containerUtils'
import { assignGroupHues } from '../common/groupColor'
import { ownNetworkNames } from '../common/netinfo'
import { assignKey, useGroupsStore } from '../groups/groupsStore'

/** Cabecera de grupo: un stack de Compose (automático) o un grupo propio (`g:<id>` / `s:<proyecto>` como clave). */
export type GroupItem = { type: 'group'; key: string; kind: 'stack' | 'custom'; label: string; count: number; running: number; nets: string[]; hue: number }
export type Item = GroupItem | { type: 'row'; c: Container; hue?: number }

export interface GroupMeta { kind: 'stack' | 'custom'; label: string; hue: number }

interface Params {
  /** Todos los contenedores (para colores y miembros, aunque el filtro oculte alguno). */
  list: Container[]
  networks: Network[]
  /** Contenedores visibles con el filtro y la búsqueda actuales. */
  filtered: Container[]
  group: boolean
  collapsed: Record<string, boolean>
  profileId: string
}

export function useContainerItems({ list, networks, filtered, group, collapsed, profileId }: Params) {
  const customGroups = useGroupsStore((s) => s.groups)
  const assigned = useGroupsStore((s) => s.assign)
  const stackHueOverride = useGroupsStore((s) => s.stackHue)

  // Red(es) propia(s) de cada contenedor (nombre → redes), desde sus endpoints. Se omiten las de sistema (bridge, host, none).
  const netsByContainer = useMemo(() => {
    const system = new Set(networks.filter((n) => n.system).map((n) => n.name))
    return new Map(list.map((c) => [containerName(c), ownNetworkNames(c, system)]))
  }, [list, networks])

  // A qué grupo pertenece un contenedor: su grupo propio (si lo tiene y existe), si no su stack de Compose, si no ninguno (suelto).
  const groupKeyOf = useCallback((c: Container): string | null => {
    const gid = assigned[assignKey(profileId, containerName(c))]
    if (gid !== undefined && customGroups.some((g) => g.id === gid)) return `g:${gid}`
    return c.compose_project != null ? `s:${c.compose_project}` : null
  }, [assigned, customGroups, profileId])

  // Color automático de cada stack: sobre TODOS los stacks (no solo los filtrados) para que un stack no cambie de color al filtrar.
  const stackAuto = useMemo(() => assignGroupHues(list.flatMap((c) => (c.compose_project != null ? [c.compose_project] : []))), [list])

  const metaOf = useCallback((key: string): GroupMeta => {
    if (key.startsWith('g:')) {
      const g = customGroups.find((x) => x.id === key.slice(2))
      return { kind: 'custom', label: g?.name ?? '', hue: g?.hue ?? 175 }
    }
    const project = key.slice(2)
    return { kind: 'stack', label: project, hue: stackHueOverride[project] ?? stackAuto.get(project) ?? 175 }
  }, [customGroups, stackHueOverride, stackAuto])

  // Miembros de cada grupo (sobre TODOS sus contenedores). El consumo lo calcula <GroupUsage/> con sus propias suscripciones.
  const groupMembers = useMemo(() => {
    const by = new Map<string, Container[]>()
    for (const c of list) { const k = groupKeyOf(c); if (k) by.set(k, [...(by.get(k) ?? []), c]) }
    return by
  }, [list, groupKeyOf])

  // Los que están en marcha primero (orden estable: dentro de cada mitad se conserva el orden del motor).
  const ordered = useMemo(() => [...filtered].sort((a, b) => Number(!isOn(a.state)) - Number(!isOn(b.state))), [filtered])

  const items = useMemo<Item[]>(() => {
    if (!group) return ordered.map((c) => ({ type: 'row', c }))
    const groups = new Map<string, Container[]>()
    const loose: Container[] = []
    for (const c of ordered) {
      const k = groupKeyOf(c)
      if (k === null) { loose.push(c); continue }
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(c)
    }
    // Grupos con algo en marcha primero; luego los propios antes que los stacks; después por nombre.
    const keys = [...groups.keys()].sort((a, b) => {
      const ra = groups.get(a)!.some((c) => isOn(c.state)) ? 0 : 1
      const rb = groups.get(b)!.some((c) => isOn(c.state)) ? 0 : 1
      const ma = metaOf(a)
      const mb = metaOf(b)
      return ra - rb || Number(ma.kind === 'stack') - Number(mb.kind === 'stack') || ma.label.localeCompare(mb.label)
    })
    const out: Item[] = []
    for (const key of keys) {
      const cs = groups.get(key)!
      const nets = [...new Set(cs.flatMap((c) => netsByContainer.get(containerName(c)) ?? []))]
      const m = metaOf(key)
      out.push({ type: 'group', key, kind: m.kind, label: m.label, count: cs.length, running: cs.filter((c) => isOn(c.state)).length, nets, hue: m.hue })
      if (!collapsed[key]) for (const c of cs) out.push({ type: 'row', c, hue: m.hue })
    }
    for (const c of loose) out.push({ type: 'row', c })
    return out
  }, [ordered, group, collapsed, netsByContainer, groupKeyOf, metaOf])

  return { items, groupKeyOf, metaOf, groupMembers }
}
