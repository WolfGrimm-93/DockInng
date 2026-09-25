// Estado global de conexión aplicado a una vista de datos, PERO con la estructura de la plantilla:
//   cabecera · (toolbar) · view-body[ banner «conexión perdida» + contenido ].
// (ConnectionGate de la base pone el banner antes de la toolbar; aquí se necesita dentro de .view-body.)
// Contrato: useViewGate(cols?, rows?) -> { blocked, lostBanner, locked }
//   blocked: ReactNode | null  -> si no es null, la vista devuelve `cabecera + blocked` (error de conexión o conectando)
//   lostBanner: ReactNode | null -> va como primer hijo de .view-body
//   locked: boolean            -> true si la conexión se perdió (botones con `locked`)
import type { ReactNode } from 'react'
import { useUiStore } from '@/app/uiStore'
import { ErrorPanel, LostBanner, SkeletonTable } from '@/components/shared/StateViews'
import { useConnection } from '@/data/store/hooks'

export function useViewGate(cols = 7, rows = 8): { blocked: ReactNode | null; lostBanner: ReactNode | null; locked: boolean; isError: boolean } {
  const c = useConnection()
  const openMenu = () => useUiStore.getState().openCtxMenu(true)
  if (c.state.status === 'error') {
    const target = c.profile.remote ? c.profile.target : c.state.diagnostic.lead
    return {
      blocked: (
        <div className="view-body">
          <ErrorPanel diagnostic={c.state.diagnostic} connectionName={c.profile.name} target={target} onRetry={c.retry} onChangeConnection={openMenu} />
        </div>
      ),
      lostBanner: null, locked: false, isError: true,
    }
  }
  if (c.state.status === 'connecting') {
    return { blocked: <div className="view-body"><SkeletonTable cols={cols} rows={rows} /></div>, lostBanner: null, locked: false, isError: false }
  }
  const lost = c.state.status === 'lost'
  return {
    blocked: null,
    lostBanner: lost ? <LostBanner since={c.state.status === 'lost' ? c.state.since : undefined} onRetry={c.retry} onChangeConnection={openMenu} /> : null,
    locked: lost,
    isError: false,
  }
}
