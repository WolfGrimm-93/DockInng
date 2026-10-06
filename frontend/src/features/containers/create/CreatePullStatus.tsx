// Descarga de la imagen durante la creación: tarjeta con progreso y cancelación, y aviso si la descarga falló o se canceló.
import { safeText } from '@/lib/safeText'
import { pullErrorText } from '@/lib/resourceNames'
import { AlertBox } from '@/components/shared/StateViews'
import { Icon } from '@/components/shared/Icon'
import { LayerProgress } from '@/components/shared/LayerProgress'
import { Button } from '@/components/ui/button'
import type { RefObject } from 'react'
import type { usePull } from '@/data/store/hooks'

export interface CreatePullStatusProps {
  phase: 'idle' | 'pulling' | 'creating'
  pullRef: string
  pullOp: ReturnType<typeof usePull>
  cardRef: RefObject<HTMLElement | null>
  onCancel(): void
}

export function CreatePullStatus({ phase, pullRef, pullOp, cardRef, onCancel }: CreatePullStatusProps) {
  return (
    <>
      {phase === 'pulling' && pullRef ? (
        <section className="card" aria-label="Descargando imagen" ref={cardRef}>
          <header className="flex items-center gap-3 px-4 py-3 border-b border-border">
            <b>Descargando imagen</b><span className="mono muted">{safeText(pullRef, { singleLine: true })}</span>
            <Button type="button" variant="secondary" size="sm" className="ml-auto" onClick={onCancel}><Icon name="x" size="sm" />Cancelar</Button>
          </header>
          <div role="status" aria-live="polite" className="sr-only">Descargando {pullRef}</div>
          {pullOp?.layers.length ? <LayerProgress layers={pullOp.layers} pulling /> : <div className="layer"><span className="muted">Conectando con el registro…</span></div>}
        </section>
      ) : null}
      {pullOp && phase === 'idle' && (pullOp.state === 'error' || pullOp.state === 'canceled') ? (
        <AlertBox kind={pullOp.state === 'error' ? 'error' : 'info'} icon={pullOp.state === 'error' ? 'alert' : 'info'} title={pullOp.state === 'error' ? `No se pudo descargar ${safeText(pullRef, { singleLine: true })}` : 'Descarga cancelada'}
          text={pullOp.error ? safeText(pullErrorText(pullRef, pullOp.error)) : 'No se creó el contenedor.'} />
      ) : null}
    </>
  )
}
