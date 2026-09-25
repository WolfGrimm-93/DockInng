// Estados comunes de las listas de recursos (imágenes, volúmenes, redes): carga, error de carga.
// Contrato: resourceState({status, error, refresh, what}) -> ReactNode | null  (null = hay datos que pintar)
import { AlertBox, SkeletonTable } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/shared/Icon'
import { apiErrorMessage } from '@/data/errors'
import type { ApiError } from '@/data/types'
import type { ReactNode } from 'react'

export function resourceState(o: { status: 'idle' | 'loading' | 'ready' | 'error'; hasRows: boolean; preview: 'empty' | 'loading' | null; error?: ApiError; refresh(): void; what: string; cols: number; rows: number }): ReactNode | null {
  if (o.preview === 'loading' || ((o.status === 'idle' || o.status === 'loading') && !o.hasRows)) return <div className="view-body"><SkeletonTable cols={o.cols} rows={o.rows} /></div>
  if (o.status === 'error' && !o.hasRows && !o.preview) {
    const m = o.error ? apiErrorMessage(o.error) : { title: 'Error', detail: '' }
    return (
      <div className="view-body">
        <AlertBox kind="error" icon="alert" title={`No se pudo cargar ${o.what}`} text={`${m.title}. ${m.detail}`}
          actions={<Button variant="secondary" size="sm" onClick={o.refresh}><Icon name="refresh" size="sm" />Reintentar</Button>} />
      </div>
    )
  }
  return null
}
