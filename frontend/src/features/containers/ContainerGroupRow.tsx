// Fila de cabecera de un grupo (stack de Compose o grupo propio) de la tabla de contenedores, con su consumo y sus redes.
import { memo, useMemo, type CSSProperties } from 'react'
import { Icon } from '@/components/shared/Icon'
import { safeText } from '@/lib/safeText'
import { formatBytesPrecise, formatBytesSI } from '@/lib/format'
import type { Container, Volume } from '@/data/types'
import { useAllStats, useSystemUsage } from '@/data/store/hooks'
import { groupDiskBytes, sumConsumption } from './usage'
import type { GroupItem } from './useContainerItems'

/** Chips de consumo de una cabecera de grupo. Memoizado: solo se repinta si cambian sus miembros/volúmenes o las muestras/el disco. */
export const GroupUsage = memo(function GroupUsage({ members, volumes }: { members: Container[] | undefined; volumes: Volume[] }) {
  const stats = useAllStats()
  const system = useSystemUsage()
  const u = useMemo(() => (members ? { sum: sumConsumption(members, stats), disk: groupDiskBytes(members, volumes, system?.container_disk ?? [], !!system?.disk_known) } : null), [members, stats, volumes, system])
  if (!u) return null
  return (
    <span className="group-usage">
      {u.sum.sampled > 0 ? <span className="usage-chip mono" title="CPU de los contenedores en marcha de este stack (100 % = 1 núcleo)">CPU {u.sum.cpu.toFixed(1)} %</span> : null}
      {u.sum.sampled > 0 ? <span className="usage-chip usage-ram mono" title="Memoria de los contenedores en marcha de este grupo">RAM {formatBytesPrecise(u.sum.memBytes)}</span> : null}
      {u.disk != null ? <span className="usage-chip usage-disk mono" title="Disco aproximado: capas de escritura + volúmenes de sus contenedores (no incluye las imágenes)">Disco ≈ {formatBytesSI(u.disk)}</span> : null}
    </span>
  )
})

/** Columnas de la tabla + la de relleno (COLS + 1 en ContainersPage). */
const SPAN = 9

export interface ContainerGroupRowProps {
  item: GroupItem
  index: number
  /** Medición de altura de la tabla virtualizada (`useVirtualTable().measure`). */
  measure: (el: Element | null) => void
  open: boolean
  settingsHref: string
  members: Container[] | undefined
  volumes: Volume[]
  onToggle: (key: string) => void
  onShowNets: (key: string) => void
}

export function ContainerGroupRow({ item: it, index, measure, open, settingsHref, members, volumes, onToggle, onShowNets }: ContainerGroupRowProps) {
  const etiqueta = it.kind === 'custom' ? 'el grupo' : 'el stack'
  return (
    <tr ref={measure} data-index={index} data-drop-key={it.key} data-group-kind={it.kind} aria-rowindex={index + 2} className="group-row" style={{ '--grp-h': it.hue } as CSSProperties}>
      <td colSpan={SPAN}>
        <div className="group-head">
          <button type="button" aria-expanded={open} onClick={() => onToggle(it.key)}>
            <Icon name="chev-down" size="sm" className="chev" />
            <span className="grp-dot" aria-hidden="true" />
            {it.kind === 'custom' ? <Icon name="folder" size="sm" /> : null}
            {it.kind === 'custom' ? 'Grupo' : 'Stack'} {safeText(it.label)}{it.running > 0 ? <span className="live-dot" aria-hidden="true" /> : null} <span className="muted font-normal">· {it.count}{it.running ? ` · ${it.running} en ejecución` : ''}</span>
          </button>
          {it.nets.length > 0 ? (
            <button
              type="button"
              className="group-nets"
              aria-haspopup="dialog"
              aria-label={`Ver las ${it.nets.length} ${it.nets.length === 1 ? 'red' : 'redes'} de ${etiqueta} ${safeText(it.label)}`}
              title="Redes del grupo, con sus IPs"
              onClick={() => onShowNets(it.key)}
            >
              <Icon name="network" size="sm" />Redes <b>{it.nets.length}</b><Icon name="eye" size="sm" />
            </button>
          ) : null}
          <a className="group-edit" href={settingsHref} aria-label={`Editar el color o el nombre de ${etiqueta} ${safeText(it.label)}`} title="Editar en Configuración > Grupos"><Icon name="palette" size="sm" /></a>
          <GroupUsage members={members} volumes={volumes} />
        </div>
      </td>
    </tr>
  )
}
