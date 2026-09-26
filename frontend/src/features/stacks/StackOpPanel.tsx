// Panel de progreso de una operación de stack (levantar/reiniciar) con la salida de docker compose.
// Solo el RESUMEN es aria-live (no cada línea). Resultado: éxito (se cierra solo a los 6 s si `autoDismiss`), error con salida y «Reintentar», o cancelado.
import { useEffect } from 'react'
import { Icon } from '@/components/shared/Icon'
import { ServiceProgress } from '@/components/shared/LayerProgress'
import { AlertBox } from '@/components/shared/StateViews'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { apiErrorMessage } from '@/data/errors'
import type { StackOpState } from '@/data/types'
import { safeText } from '@/lib/safeText'

const VERB = {
  up: ['Levantando', 'levantar', 'Stack levantado'], restart: ['Reiniciando', 'reiniciar', 'Stack reiniciado'], stop: ['Deteniendo', 'detener', 'Stack detenido'],
  start: ['Iniciando', 'iniciar', 'Stack iniciado'], pull: ['Actualizando imágenes', 'actualizar las imágenes de', 'Imágenes actualizadas'],
} as const

export function StackOpPanel({ op, locked, autoDismiss, onCancel, onRetry, onDismiss }: {
  op: StackOpState
  locked?: boolean
  autoDismiss?: boolean
  onCancel(): void
  onRetry(): void
  onDismiss(): void
}) {
  const [ing, verb, okTitle] = VERB[op.kind]
  useEffect(() => {
    if (op.state !== 'done' || !autoDismiss) return
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [op.state, autoDismiss, onDismiss])

  const total = op.services.length
  const ready = op.services.filter((s) => s.percent >= 100).length
  const output = op.log.length ? (
    <details className="op-log">
      <summary>Salida de docker compose</summary>
      <pre className="mono" tabIndex={0} aria-label="Salida de docker compose">{op.log.slice(-60).join('\n')}</pre>
    </details>
  ) : null

  if (op.state === 'running') {
    return (
      <div className="op-panel" aria-busy="true">
        <div className="op-head">
          <span role="status" aria-live="polite">{total ? `${ing}… ${ready} de ${total} listos` : `${ing}…`}</span>
          <Button variant="secondary" size="sm" locked={locked} onClick={onCancel}><Icon name="x" size="sm" />Cancelar</Button>
        </div>
        {total ? <ServiceProgress services={op.services} /> : <Progress value={0} label={`${ing} stack`} indeterminate />}
        {output}
      </div>
    )
  }
  if (op.state === 'done') {
    return (
      <div className="op-panel">
        <AlertBox kind="info" icon="check" title={okTitle} text={total ? `${ready} de ${total} servicios en marcha.` : 'La operación terminó correctamente.'}
          actions={<Button variant="ghost" size="sm" onClick={onDismiss}>Cerrar</Button>} />
        {output}
      </div>
    )
  }
  if (op.state === 'canceled') {
    return (
      <div className="op-panel">
        <AlertBox kind="warn" icon="warn" title="Operación cancelada" text="Cancelado: puede haber quedado a medias; revisa los servicios."
          actions={<><Button variant="secondary" size="sm" locked={locked} onClick={onRetry}><Icon name="refresh" size="sm" />Reintentar</Button><Button variant="ghost" size="sm" onClick={onDismiss}>Cerrar</Button></>} />
        {output}
      </div>
    )
  }
  const m = op.error ? apiErrorMessage(op.error) : null
  return (
    <div className="op-panel">
      <AlertBox kind="error" icon="alert" title={`No se pudo ${verb} ${op.kind === 'pull' ? 'el stack' : 'el stack'}`}
        text={<>{m ? safeText(m.detail || m.title) : 'Docker Compose terminó con un error.'}{op.issues.slice(0, 5).map((i, n) => <span key={n} className="op-issue">{i.line ? `Línea ${i.line}: ` : ''}{safeText(i.message, { singleLine: true })}</span>)}</>}
        actions={<><Button variant="secondary" size="sm" locked={locked} onClick={onRetry}><Icon name="refresh" size="sm" />Reintentar</Button><Button variant="ghost" size="sm" onClick={onDismiss}>Cerrar</Button></>} />
      {output}
    </div>
  )
}
