// Router por hash (~30 líneas, sin dependencias). Contrato:
//   useHashRoute(): { id, params, go(id, params?), href(id, params?) }
// `go` cambia location.hash (la vista se actualiza por `hashchange`). El foco a <h1 id="viewTitle"> en cada cambio de
// ruta lo hace AppShell (`useRouteFocus`), como la plantilla.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import './navGuard' // instala la guarda en fase de captura ANTES de que el router se suscriba
import { buildHref, parseRoute, type ParsedRoute, type RouteId } from './routes'

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
const getHash = (): string => window.location.hash
const getServerHash = (): string => ''

export interface HashRoute extends ParsedRoute {
  hash: string
  go(id: RouteId, params?: Record<string, string | undefined>): void
  href(id: RouteId, params?: Record<string, string | undefined>): string
}

export function useHashRoute(): HashRoute {
  const hash = useSyncExternalStore(subscribe, getHash, getServerHash)
  const parsed = useMemo(() => parseRoute(hash, window.location.search), [hash])
  const go = useCallback((id: RouteId, params?: Record<string, string | undefined>) => {
    window.location.hash = buildHref(id, params)
  }, [])
  return { ...parsed, hash, go, href: buildHref }
}
