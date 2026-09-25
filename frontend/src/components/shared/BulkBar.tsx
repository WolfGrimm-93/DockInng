// Barra de acciones sobre la selección masiva (.bulkbar, role="region"). «Eliminar…» va separado por `sep`.
// Contrato: <BulkBar count onStart onStop onDelete onClear locked? />  (el padre la pone dentro de <div className="toolbar">)
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from './Icon'

export function BulkBar({ count, onStart, onStop, onDelete, onClear, locked, extra }: {
  count: number
  onStart(): void
  onStop(): void
  onDelete(): void
  onClear(): void
  locked?: boolean
  /** Acciones adicionales (p. ej. «Mover a grupo»), antes del separador de «Eliminar…». */
  extra?: ReactNode
}) {
  return (
    <div className="bulkbar" role="region" aria-label="Acciones sobre la selección">
      <strong>{count} seleccionado{count > 1 ? 's' : ''}</strong>
      <Button variant="secondary" size="sm" locked={locked} onClick={onStart}><Icon name="play" size="sm" fill />Iniciar</Button>
      <Button variant="secondary" size="sm" locked={locked} onClick={onStop}><Icon name="square" size="sm" fill />Detener</Button>
      {extra}
      <span className="sep" aria-hidden="true" />
      <Button variant="outline-destructive" size="sm" locked={locked} onClick={onDelete}><Icon name="trash" size="sm" />Eliminar…</Button>
      <Button variant="ghost" size="sm" onClick={onClear}>Quitar selección</Button>
    </div>
  )
}
