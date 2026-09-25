// Selectores puros sobre EngineStoreState (sin React). Contrato:
//   listOf(entity) · containerCounts(state) · findContainer(state, nameOrId) · totalImageBytes(images) · navCounts(state)
import type { Container, Image } from '../types'
import type { Entity, EngineStoreState } from './engineStore'

export function listOf<T>(e: Entity<T>): T[] {
  return e.ids.map((id) => e.byId[id])
}

export const isStopped = (c: Container): boolean => c.state === 'exited' || c.state === 'dead' || c.state === 'created'

export function containerCounts(s: Pick<EngineStoreState, 'containers'>) {
  const list = listOf(s.containers)
  return { total: list.length, running: list.filter((c) => c.state === 'running').length, stopped: list.filter(isStopped).length }
}

/** Busca por nombre exacto (la ruta usa nombre), con fallback a id completo o prefijo de id (≥4). */
export function findContainer(s: Pick<EngineStoreState, 'containers'>, nameOrId: string | null | undefined): Container | undefined {
  if (!nameOrId) return undefined
  const list = listOf(s.containers)
  return (
    list.find((c) => c.names.includes(nameOrId)) ??
    list.find((c) => c.id === nameOrId) ??
    (nameOrId.length >= 4 ? list.find((c) => c.id.startsWith(nameOrId)) : undefined)
  )
}

/** Suma deduplicando por id de imagen (una imagen con N etiquetas ocupa una sola vez). */
export function totalImageBytes(images: Image[]): number {
  const seen = new Map<string, number>()
  for (const i of images) seen.set(i.id, i.size_bytes)
  let t = 0
  for (const v of seen.values()) t += v
  return t
}

/** Contadores del menú. Solo se incluye una colección cuando ya hay datos (no se muestran «0» mientras carga o hay error). */
export function navCounts(s: Pick<EngineStoreState, 'containers' | 'images' | 'volumes' | 'networks'>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (s.containers.status === 'ready') {
    const c = containerCounts(s)
    out.containers = `${c.running}/${c.total}`
    // Stacks = proyectos Compose distintos que aparecen en las etiquetas de los contenedores reales.
    out.stacks = new Set(listOf(s.containers).map((x) => x.compose_project).filter(Boolean)).size
  }
  if (s.images.status === 'ready') out.images = s.images.ids.length
  if (s.volumes.status === 'ready') out.volumes = s.volumes.ids.length
  if (s.networks.status === 'ready') out.networks = s.networks.ids.length
  return out
}
