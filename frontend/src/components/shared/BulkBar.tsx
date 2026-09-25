// Barra de acciones sobre la selección masiva (.bulkbar, role="region"). «Eliminar…» va separado por `sep`.
// Contrato: <BulkBar count onStart onStop onDelete onClear locked? />  (el padre la pone dentro de <div className="toolbar">)
import { Button } from '@/components/ui/button'
import { Icon } from './Icon'

export function BulkBar({ count, onStart, onStop, onDelete, onClear, locked }: {
  count: number
  onStart(): void
  onStop(): void
  onDelete(): void
  onClear(): void
  locked?: boolean
}) {
  return (
    <div className="bulkbar" role="region" aria-label="Acciones sobre la selección">
      <strong>{count} seleccionado{count > 1 ? 's' : ''}</strong>
      <Button variant="secondary" size="sm" locked={locked} onClick={onStart}><Icon name="play" size="sm" fill />Iniciar</Button>
      <Button variant="secondary" size="sm" locked={locked} onClick={onStop}><Icon name="square" size="sm" fill />Detener</Button>
      <span className="sep" aria-hidden="true" />
      <Button variant="outline-destructive" size="sm" locked={locked} onClick={onDelete}><Icon name="trash" size="sm" />Eliminar…</Button>
      <Button variant="ghost" size="sm" onClick={onClear}>Quitar selección</Button>
    </div>
  )
}
