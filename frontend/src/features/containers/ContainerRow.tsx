// Fila de la tabla de contenedores (memoizada). Datos en vivo por fila: estado de operación (useRowOps) y muestreo (useStats).
// Todo texto de Docker (nombre, imagen, puertos) se pinta como nodo de texto de React: nunca HTML.
import { safeText } from '@/lib/safeText'
import { memo, useMemo, type Ref, type CSSProperties } from 'react'
import { Icon } from '@/components/shared/Icon'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip } from '@/components/ui/tooltip'
import { containerName } from '@/data/store/engineStore'
import { useRowOps, useStats } from '@/data/store/hooks'
import type { Container } from '@/data/types'
import { statusTextEs } from '@/lib/format'
import { isOn } from '../common/containerUtils'
import { hasMorePorts, mainPortsText, portEntries, totalPorts } from '../common/ports'
import { AssignGroupMenu } from '../groups/AssignGroupMenu'

export interface ContainerRowProps {
  c: Container
  selected: boolean
  locked: boolean
  href: string
  index: number
  measure?: Ref<HTMLTableRowElement>
  /** Matiz (OKLCH) del stack al que pertenece; si existe, la fila es hija de una cabecera y se indenta con la barra de ese color. */
  groupHue?: number
  onSelect(id: string, on: boolean): void
  onOp(c: Container, op: 'start' | 'stop' | 'restart'): void
  onDelete(c: Container): void
  /** Abre el modal con todos los puertos (el ojo solo aparece con más de 2). */
  onShowPorts(c: Container): void
}

const MIB = 1024 * 1024

function ContainerRowImpl({ c, selected, locked, href, index, measure, groupHue, onSelect, onOp, onDelete, onShowPorts }: ContainerRowProps) {
  const name = safeText(containerName(c), { singleLine: true })
  const image = safeText(c.image, { singleLine: true })
  const op = useRowOps(c.id)
  const stats = useStats(c.id)
  const on = isOn(c.state)
  const busy = op.busy
  const portList = useMemo(() => portEntries(c.ports), [c.ports])
  const ports = mainPortsText(portList)
  const morePorts = hasMorePorts(portList)
  const memMib = stats ? Math.round(stats.mem_used_bytes / MIB) : 0
  const memPct = stats ? Math.min(100, stats.mem_percent) : 0
  const blockedByBusy = !!busy
  return (
    <tr
      ref={measure}
      data-index={index}
      data-name={name}
      className={groupHue != null ? 'in-group' : undefined}
      style={groupHue != null ? ({ '--grp-h': groupHue } as CSSProperties) : undefined}
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-busy={busy ? true : undefined}
    >
      <td className="col-check">
        <Checkbox aria-label={`Seleccionar ${name}`} checked={selected} onChange={(e) => onSelect(c.id, e.target.checked)} />
      </td>
      <td className="cell-name">
        <div className="name-cell">
          <a href={href} title={`${name} · ${c.id.slice(0, 12)}`}>{name}</a>
          <small className="mono" title={image}>{image}</small>
          <small className="sub-extra">{safeText(ports)} · {stats && memMib ? `${memMib} MiB` : 'sin memoria en uso'}</small>
        </div>
      </td>
      <td>
        <div className="status-cell">
          <StatusBadge state={c.state} busy={busy} />
          {op.error ? (
            <small className="row-error">
              <Icon name="alert" size="sm" /> {safeText(op.error)}{' '}
              <button type="button" className="link" style={{ color: 'var(--foreground)', textDecoration: 'underline' }} onClick={() => onOp(c, 'start')}>Reintentar</button>
            </small>
          ) : (
            <small>{statusTextEs(c.status, c.state)}</small>
          )}
        </div>
      </td>
      <td className="col-ports mono" title={safeText(ports)}>{safeText(ports)}</td>
      <td className="col-ports-more">
        {morePorts ? (
          <Tooltip label={`Ver los ${totalPorts(portList)} puertos`}>
            <Button variant="ghost" size="icon" className="ports-eye" aria-label={`Ver los ${totalPorts(portList)} puertos de ${name}`} aria-haspopup="dialog" onClick={() => onShowPorts(c)}>
              <Icon name="eye" />
            </Button>
          </Tooltip>
        ) : null}
      </td>
      <td className="num col-cpu">{c.state === 'running' && stats ? `${stats.cpu_percent.toFixed(1)}%` : '—'}</td>
      <td className="num col-mem">
        {stats && memMib ? (
          <>
            <span className="bar" aria-hidden="true"><i style={{ width: `${memPct}%` }} /></span>
            {memMib} MiB
          </>
        ) : '—'}
      </td>
      <td className="col-actions">
        <div className="row-actions">
          <Tooltip label={on ? 'Detener' : 'Iniciar'}>
            <Button
              variant="ghost"
              size="icon"
              locked={locked || blockedByBusy}
              aria-label={`${on ? 'Detener' : 'Iniciar'} ${name}`}
              onClick={() => onOp(c, on ? 'stop' : 'start')}
            >
              <Icon name={on ? 'square' : 'play'} fill />
            </Button>
          </Tooltip>
          <Button variant="ghost" size="icon" aria-label={`Reiniciar ${name}`} disabled={!on || blockedByBusy || locked} onClick={() => onOp(c, 'restart')}>
            <Icon name="rotate" />
          </Button>
          <AssignGroupMenu names={[containerName(c)]} triggerClass="btn btn-ghost btn-icon" ariaLabel={`Mover ${name} a un grupo`}>
            <Icon name="folder" />
          </AssignGroupMenu>
          <span className="sep" aria-hidden="true" />
          <Button variant="ghost" size="icon" className="btn-del" locked={locked || blockedByBusy} aria-label={`Eliminar ${name}`} onClick={() => onDelete(c)}>
            <Icon name="trash" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

export const ContainerRow = memo(ContainerRowImpl)
