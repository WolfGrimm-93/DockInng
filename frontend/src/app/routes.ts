// RUTAS (hash + query, idénticas a la plantilla). Contrato público:
//   RouteId · NavId · NAV (5 en «Docker», 1 en «Aplicación») · NAV_OF[route] (ítem resaltado) · TITLES[route]
//   RouteParams[route] (parámetros que se conservan) · parseRoute(hash, search) · buildHref(id, params?)
// Formato: `#detail?c=tienda-api-1&tab=logs`. Parámetros de vista tras el hash; `location.search` solo como
// respaldo de arranque (paridad con la plantilla). Estado de UI (filtro, selección…) NO va en la URL.
import type { IconName } from '@/components/shared/iconNames'

export type RouteId =
  | 'containers' | 'detail' | 'create' | 'images' | 'pull' | 'volumes' | 'networks' | 'stacks' | 'stack-edit' | 'settings' | 'conn-new'
export type NavId = 'containers' | 'images' | 'volumes' | 'networks' | 'stacks' | 'settings'

export interface NavItemDef { id: NavId; label: string; icon: IconName; group: 'Docker' | 'Aplicación' }

export const NAV: NavItemDef[] = [
  { id: 'containers', label: 'Contenedores', icon: 'box', group: 'Docker' },
  { id: 'images', label: 'Imágenes', icon: 'layers', group: 'Docker' },
  { id: 'volumes', label: 'Volúmenes', icon: 'database', group: 'Docker' },
  { id: 'networks', label: 'Redes', icon: 'network', group: 'Docker' },
  { id: 'stacks', label: 'Stacks (Compose)', icon: 'grid', group: 'Docker' },
  { id: 'settings', label: 'Configuración', icon: 'sliders', group: 'Aplicación' },
]

export const NAV_OF: Record<RouteId, NavId> = {
  containers: 'containers', detail: 'containers', create: 'containers', images: 'images', pull: 'images', volumes: 'volumes',
  networks: 'networks', stacks: 'stacks', 'stack-edit': 'stacks', settings: 'settings', 'conn-new': 'settings',
}

export const TITLES: Record<RouteId, string> = {
  containers: 'Contenedores', detail: 'Contenedor', create: 'Nuevo contenedor', images: 'Imágenes', pull: 'Descargar imagen', volumes: 'Volúmenes',
  networks: 'Redes', stacks: 'Stacks', 'stack-edit': 'Editar stack', settings: 'Configuración', 'conn-new': 'Nueva conexión',
}

/** Parámetros que se conservan de la plantilla. Los marcados (dev) solo se interpretan en modo simulado/DEV. */
export interface RouteParams {
  detail: { c?: string; tab?: 'logs' | 'terminal' | 'stats' | 'inspect'; focus?: '0' }
  create: { image?: string; remote?: '1' }
  pull: { image?: string; pull?: 'running' | 'done' | 'canceled' | 'error' } // pull= (dev)
  'stack-edit': { stack?: string; yaml?: 'broken'; run?: 'up' | 'done'; file?: 'env' } // yaml/run/file (dev)
  'conn-new': { test?: 'testing' | 'ok' | 'fail' } // test= (dev)
}

const IDS = Object.keys(TITLES) as RouteId[]
export const isRouteId = (s: string): s is RouteId => (IDS as string[]).includes(s)

export interface ParsedRoute { id: RouteId; params: URLSearchParams }

/** `hash` con o sin `#`; `search` = location.search (respaldo). Los valores del hash ganan. */
export function parseRoute(hash: string, search = ''): ParsedRoute {
  let hs = hash.replace(/^#/, '')
  let q = ''
  const i = hs.indexOf('?')
  if (i >= 0) {
    q = hs.slice(i + 1)
    hs = hs.slice(0, i)
  }
  const fromSearch = new URLSearchParams(search)
  const fromHash = new URLSearchParams(q)
  const params = new URLSearchParams(fromSearch)
  fromHash.forEach((v, k) => params.set(k, v))
  const candidate = hs || fromSearch.get('view') || 'containers'
  return { id: isRouteId(candidate) ? candidate : 'containers', params }
}

export function buildHref(id: RouteId, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') q.set(k, v)
  const qs = q.toString()
  return `#${id}${qs ? `?${qs}` : ''}`
}
