// Tarjeta de un stack: servicios con estado, origen y acciones (Editar / Levantar / Reiniciar / Bajar… o Eliminar…).
import { Icon } from '@/components/shared/Icon'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LinkButton } from '../common/LinkButton'
import { safeText } from '@/lib/safeText'
import type { StackOpState, StackSummary } from '@/data/types'
import { StackOpPanel } from './StackOpPanel'

const HEALTH: Record<string, string> = { running: 'var(--status-running)', paused: 'var(--status-paused)', restarting: 'var(--status-restarting)' }
const ORIGIN: Record<StackSummary['origin'], string> = { discovered: 'Descubierto', managed: 'Propio', linked: 'Vinculado' }

export interface StackCardProps {
  stack: StackSummary
  op: StackOpState | undefined
  /** Conexión perdida. */
  locked: boolean
  /** Docker Compose ausente: levantar/reiniciar/bajar desactivados con motivo. */
  composeMissing: boolean
  /** Una acción de política (bajar/eliminar) está en curso para este stack. */
  policyBusy: boolean
  editHref: string
  /** Enlace al detalle del contenedor de un servicio (undefined si no hay contenedor). */
  serviceHref(service: string): string | undefined
  onUp(): void
  onRestart(): void
  onStop(): void
  onStart(): void
  onPull(): void
  onDown(): void
  onDelete(): void
  onUnlink(): void
  onLink(): void
  onCancelOp(): void
  onDismissOp(): void
}

export function StackCard(p: StackCardProps) {
  const s = p.stack
  const name = safeText(s.name, { singleLine: true })
  const running = p.op?.state === 'running'
  const okN = s.services.filter((x) => x.state === 'running').length
  const n = s.services.length
  const blocked = p.locked || p.composeMissing
  const reason = p.composeMissing ? 'Requiere Docker Compose' : undefined
  const hasContainers = s.containers > 0
  const discovered = s.origin === 'discovered'
  // Levantar (up) y Actualizar imágenes (pull) necesitan el archivo Compose: un stack solo descubierto por etiquetas no lo tiene.
  const whyFile = discovered ? `«${name}» se descubrió por las etiquetas de sus contenedores: Levantar y Actualizar imágenes requieren vincular su archivo Compose.` : null
  const anyStopped = s.containers > s.running
  const busy = blocked || running || p.policyBusy
  return (
    <section className="card stack-card" aria-label={`Stack ${name}`}>
      <header>
        <div className="min-w-0">
          <h3 className="[overflow-wrap:anywhere]">{name} <span className="tag" title={s.origin === 'discovered' ? 'Detectado por las etiquetas de los contenedores' : s.origin === 'linked' ? 'Archivo Compose vinculado' : 'Stack creado en DockInng'}>{ORIGIN[s.origin]}</span></h3>
          <div className="path [overflow-wrap:anywhere]" >{s.path ? safeText(s.path, { singleLine: true }) : 'Ubicación del archivo desconocida'}</div>
        </div>
        <span className="spacer">
          <span className="health" role="img" aria-label={`${okN} de ${n} servicios en ejecución`}>
            {s.services.map((x) => <i key={x.name} className="flex-1" style={{ background: HEALTH[x.state] ?? 'var(--status-exited)' }} />)}
          </span>
          <span className="muted min-w-[84px] text-right" >{okN} de {n} activos</span>
          {s.editable ? (
            <LinkButton variant="secondary" size="sm" locked={p.locked} href={p.editHref} aria-label={`Editar stack ${name}`}><Icon name="edit" size="sm" />Editar</LinkButton>
          ) : (
            <Button variant="secondary" size="sm" locked={p.locked} onClick={p.onLink} aria-label={`Vincular el archivo del stack ${name} para editarlo`} title="Se descubrió por etiquetas: vincula su archivo Compose para editarlo"><Icon name="file" size="sm" />Vincular…</Button>
          )}
          <Button variant="secondary" size="sm" locked={busy || discovered} title={reason} aria-describedby={discovered ? `why-${s.name}` : undefined} aria-label={`Levantar stack ${name}`} onClick={p.onUp}><Icon name={running && p.op?.kind === 'up' ? 'loader' : 'play'} size="sm" fill={!(running && p.op?.kind === 'up')} spin={running && p.op?.kind === 'up'} />Levantar</Button>
          <Button variant="secondary" size="sm" locked={blocked || running || p.policyBusy || !hasContainers} title={reason} aria-label={`Reiniciar stack ${name}`} onClick={p.onRestart}><Icon name={running && p.op?.kind === 'restart' ? 'loader' : 'rotate'} size="sm" spin={running && p.op?.kind === 'restart'} />Reiniciar</Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="btn btn-secondary btn-sm" aria-label={`Más acciones del stack ${name}`}><Icon name="dots" size="sm" />Más</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy || s.running === 0} onClick={p.onStop}><Icon name="square" size="sm" fill />Detener{s.running === 0 ? ' (ya está detenido)' : ''}</DropdownMenuItem>
              <DropdownMenuItem disabled={busy || !anyStopped} onClick={p.onStart}><Icon name="play" size="sm" fill />Iniciar{!anyStopped ? ' (no hay servicios detenidos)' : ''}</DropdownMenuItem>
              <DropdownMenuItem disabled={busy || discovered} onClick={p.onPull}><Icon name="download" size="sm" />Actualizar imágenes{discovered ? ' (requiere vincular)' : ''}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="sep" aria-hidden="true" />
          {hasContainers ? (
            <Button variant="outline-destructive" size="sm" locked={blocked || running || p.policyBusy} title={reason} aria-label={`Bajar stack ${name}`} onClick={p.onDown}><Icon name={p.policyBusy ? 'loader' : 'square'} size="sm" fill={!p.policyBusy} spin={p.policyBusy} />Bajar…</Button>
          ) : s.origin === 'managed' ? (
            <Button variant="outline-destructive" size="sm" locked={p.locked || running || p.policyBusy} aria-label={`Eliminar stack ${name}`} onClick={p.onDelete}><Icon name="trash" size="sm" />Eliminar stack…</Button>
          ) : s.origin === 'linked' ? (
            <Button variant="outline-destructive" size="sm" locked={p.locked || running || p.policyBusy} aria-label={`Desvincular stack ${name}`} title="No borra el archivo" onClick={p.onUnlink}><Icon name="x" size="sm" />Desvincular</Button>
          ) : null}
        </span>
      </header>
      {whyFile ? <p className="f-hint stack-why" id={`why-${s.name}`}>{whyFile}</p> : null}
      {p.op ? <StackOpPanel op={p.op} locked={p.locked} autoDismiss onCancel={p.onCancelOp} onRetry={p.op?.kind === 'restart' ? p.onRestart : p.op?.kind === 'stop' ? p.onStop : p.op?.kind === 'start' ? p.onStart : p.op?.kind === 'pull' ? p.onPull : p.onUp} onDismiss={p.onDismissOp} /> : null}
      {s.services.length === 0 ? <div className="svc"><span className="muted">Sin servicios conocidos. {p.composeMissing ? 'Con Docker Compose instalado se leerán del archivo.' : ''}</span></div> : null}
      {s.services.map((x) => {
        const href = p.serviceHref(x.name)
        return (
          <div className="svc" key={x.name}>
            {href ? <a href={href} className="link-name"><b>{safeText(x.name, { singleLine: true })}</b></a> : <b>{safeText(x.name, { singleLine: true })}</b>}
            <span><StatusBadge state={x.state} /></span>
            <span className="mono svc-image" title={safeText(x.image, { singleLine: true })}>{safeText(x.image, { singleLine: true })}</span>
            <span className="muted text-right"  title="Réplicas en ejecución">{x.replicas}</span>
          </div>
        )
      })}
    </section>
  )
}
